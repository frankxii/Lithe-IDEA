import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LocaleProvider } from "@/i18n/locale-provider";
import { installHappyDom } from "@/test-utils/happy-dom";
import * as commitsApi from "../../api/git-commits-api";
import * as diffApi from "../../api/git-diff-api";
import type { GitCommit, GitCommitFile } from "../../types/git.types";
import { GitCommitInspector } from "./git-commit-inspector";

const commit = (hash: string, parents: string[] = []): GitCommit => ({
  hash,
  shortHash: hash,
  parentHashes: parents,
  message: hash,
  author: "Fixture",
  date: "unknown",
  decorations: "",
  description: "",
});
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousActEnvironment: boolean | undefined;
let restoreDom: () => void;
let root: Root;
let container: HTMLElement;
let filesSpy: ReturnType<typeof spyOn>;
let rangeSpy: ReturnType<typeof spyOn>;
const requests: Array<{
  repo: string;
  hash: string;
  resolve: (files: GitCommitFile[] | null) => void;
}> = [];
const preview = mock(() => {});
const noop = () => {};
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  restoreDom = installHappyDom();
  for (const key of ["DOMRect", "ResizeObserver"] as const) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: window[key],
    });
  }
  previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  requests.length = 0;
  preview.mockClear();
  filesSpy = spyOn(commitsApi, "getCommitFiles").mockImplementation(
    (repo, hash) => new Promise((resolve) => requests.push({ repo, hash, resolve })),
  );
  rangeSpy = spyOn(diffApi, "getRefDiff").mockResolvedValue([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    for (const request of requests) request.resolve(null);
  });
  filesSpy.mockRestore();
  rangeSpy.mockRestore();
  environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  previousGlobals.clear();
  restoreDom();
});

const render = async (values: GitCommit[], repoPath = "C:/fixture", previewRequest = 0) => {
  await act(async () =>
    root.render(
      <LocaleProvider language="en-US">
        <GitCommitInspector
          repoPath={repoPath}
          commit={values[0] ?? null}
          commits={values}
          previewRequest={previewRequest}
          onPreviewFile={preview}
          onOpenDiff={noop}
          onOpenRangeDiff={noop}
          onOpenSelectionDiff={noop}
        />
      </LocaleProvider>,
    ),
  );
};
const release = async (index: number, path: string) => {
  await act(async () => requests[index].resolve([{ path, status: "M" }]));
};

test("pagination selection arrays and metadata repainting retain loaded files without another read", async () => {
  const selected = commit("tip");
  await render([selected]);
  await release(0, "kept.ts");
  const findFileRow = () =>
    [...container.querySelectorAll("[data-sidebar-tree-row]")].find((row) =>
      row.textContent?.includes("kept.ts"),
    );
  const fileRow = findFileRow();
  expect(fileRow).toBeDefined();
  await act(async () => fileRow!.querySelector<HTMLButtonElement>('[role="treeitem"]')!.click());
  expect(fileRow).not.toBeNull();
  await render([selected]);
  await render([{ ...selected, message: "Updated metadata" }]);
  expect(filesSpy).toHaveBeenCalledTimes(1);
  expect(findFileRow()).toBe(fileRow);
  expect(findFileRow()?.getAttribute("data-active")).toBe("true");
  expect(container.textContent).toContain("Updated metadata");
  expect(preview).toHaveBeenCalledTimes(1);
});

test("repainting a pending selection keeps its original request and explicit preview runs after loading", async () => {
  await render([commit("tip")]);
  await render([commit("tip")], "C:/fixture", 1);
  expect(filesSpy).toHaveBeenCalledTimes(1);
  await release(0, "preview.ts");
  expect(container.textContent).toContain("preview.ts");
  expect(preview).toHaveBeenCalledTimes(1);
  await render([commit("tip")], "C:/fixture", 1);
  expect(preview).toHaveBeenCalledTimes(1);
});

test("unchanged contiguous and discontiguous selections do not reload range or aggregate files", async () => {
  await render([commit("new", ["old"]), commit("old", ["base"])]);
  await render([commit("new", ["old"]), commit("old", ["base"])]);
  expect(rangeSpy).toHaveBeenCalledTimes(1);
  await render([commit("a"), commit("b")]);
  await act(async () => {
    for (const request of requests) request.resolve([]);
  });
  await render([commit("a"), commit("b")]);
  expect(filesSpy).toHaveBeenCalledTimes(2);
});

test("a new commit or repository loads files and ignores late answers from the old owner", async () => {
  await render([commit("a")]);
  await render([commit("b")]);
  await release(0, "stale.ts");
  expect(container.textContent).not.toContain("stale.ts");
  await release(1, "current.ts");
  expect(container.textContent).toContain("current.ts");
  await render([commit("b")], "C:/other", 1);
  expect(filesSpy).toHaveBeenCalledTimes(3);
  expect(preview).not.toHaveBeenCalled();
  await release(2, "other.ts");
  expect(container.textContent).toContain("other.ts");
  expect(preview).toHaveBeenCalledTimes(1);
});
