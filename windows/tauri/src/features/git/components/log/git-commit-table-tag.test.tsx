import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LocaleProvider } from "@/i18n/locale-provider";
import { installHappyDom } from "@/test-utils/happy-dom";
import { useGitLogPreferencesStore } from "../../stores/git-log-preferences.store";
import type { GitCommit } from "../../types/git.types";

const menus = await import("@/ui/context-menu");
const virtualization = await import("@tanstack/react-virtual");
const dates = await import("./git-log-date-cell");
const { GitCommitTable } = await import("./git-commit-table");
const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousAct: boolean | undefined;
let restoreDom: () => void;
let root: Root;
let container: HTMLDivElement;
let previousPreferences: ReturnType<typeof useGitLogPreferencesStore.getState>;
const spies: Array<{ mockRestore: () => void }> = [];
const onCreateTag = mock((_commit: GitCommit) => {});
const commits: GitCommit[] = ["a", "b"].map((letter, index) => ({
  hash: letter.repeat(40),
  shortHash: letter.repeat(7),
  parentHashes: index === 0 ? ["b".repeat(40)] : [],
  message: `Commit ${letter}`,
  author: "Developer",
  date: "2026/10/06 10:00",
  decorations: index === 0 ? "HEAD -> main" : "",
}));
const content = ({ children }: { children?: unknown }) => (
  <div>{typeof children === "function" ? null : (children as ReactNode)}</div>
);

beforeEach(() => {
  restoreDom = installHappyDom();
  previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  previousPreferences = useGitLogPreferencesStore.getState();
  useGitLogPreferencesStore.setState({ filterQuery: "", filterScope: "text" });
  onCreateTag.mockClear();
  // Deterministic visible rows and inline menus let us click the actual commit
  // action without relying on browser layout, popup placement, or date timers.
  spies.push(
    spyOn(virtualization, "useVirtualizer").mockImplementation((() => ({
      getVirtualItems: () =>
        commits.map((commit, index) => ({ index, key: commit.hash, start: index * 30, size: 30 })),
      getTotalSize: () => commits.length * 30,
      scrollToIndex: () => {},
    })) as unknown as typeof virtualization.useVirtualizer),
    spyOn(menus, "ContextMenu").mockImplementation(content),
    spyOn(menus, "ContextMenuTrigger").mockImplementation(content),
    spyOn(menus, "ContextMenuContent").mockImplementation(content),
    spyOn(menus, "ContextMenuItem").mockImplementation(({ children, disabled, onClick }) => (
      <button
        disabled={disabled}
        onClick={(event) =>
          onClick?.(event as unknown as Parameters<NonNullable<typeof onClick>>[0])
        }
      >
        {children}
      </button>
    )),
    spyOn(menus, "ContextMenuSeparator").mockImplementation(() => <hr />),
    spyOn(menus, "ContextMenuShortcut").mockImplementation(content),
    spyOn(dates, "GitLogDateCell").mockImplementation(() => <span />),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  try {
    await act(async () => root.unmount());
  } finally {
    for (const spy of spies.splice(0)) spy.mockRestore();
    useGitLogPreferencesStore.setState(previousPreferences);
    container.remove();
    if (previousAct === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT;
    else globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
    restoreDom();
  }
});

const renderTable = async (selectedCommitHashes: Set<string>, isMutatingHistory = false) => {
  await act(async () =>
    root.render(
      <LocaleProvider language="en-US">
        <GitCommitTable
          commits={commits}
          selectedCommit={commits[0]!}
          selectedCommitHashes={selectedCommitHashes}
          isMutatingHistory={isMutatingHistory}
          hasMore={false}
          isLoadingMore={false}
          onSelect={() => {}}
          onContextSelect={() => {}}
          onOpenDiff={() => {}}
          onCompareWithHead={() => {}}
          onCopyHash={() => {}}
          onCopyShortHash={() => {}}
          onCopyMessage={() => {}}
          onEditMessage={() => {}}
          onUndo={() => {}}
          onInteractiveRebase={() => {}}
          onExportPatch={() => {}}
          onDelete={() => {}}
          onSquash={() => {}}
          onReset={() => {}}
          onCherryPick={() => {}}
          onRevert={() => {}}
          onCreateTag={onCreateTag}
          onLoadMore={() => {}}
        />
      </LocaleProvider>,
    ),
  );
};
const tagButtons = () =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
    (button) => button.textContent === "New Tag…",
  );

test("New Tag targets the context commit rather than HEAD or the previous selection", async () => {
  await renderTable(new Set([commits[0]!.hash]));
  expect(tagButtons()).toHaveLength(2);
  await act(async () => tagButtons()[1]!.click());
  expect(onCreateTag.mock.calls).toEqual([[commits[1]!]]);
});

test("New Tag is disabled for multiple selected commits and during mutations", async () => {
  await renderTable(new Set(commits.map((commit) => commit.hash)));
  expect(tagButtons()).toHaveLength(2);
  expect(tagButtons().every((button) => button.disabled)).toBe(true);
  await act(async () => tagButtons()[1]!.click());
  await renderTable(new Set([commits[1]!.hash]), true);
  expect(tagButtons().every((button) => button.disabled)).toBe(true);
  await act(async () => tagButtons()[1]!.click());
  expect(onCreateTag).not.toHaveBeenCalled();
});
