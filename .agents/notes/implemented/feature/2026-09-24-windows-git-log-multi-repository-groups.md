# Agent 笔记：Windows Git Log 多仓库分支分组

状态：已实现

## 先说结论

在 Windows 版里，当一个工作区包含多个 Git 仓库时，Git Log 的引用树按仓库分组：
顶层每个仓库一个可折叠节点（仓库名 + 引用数），节点内部才是 Local / Remote / Tags。
分支数据由前端按仓库分别读取再聚合，Rust Core 的引用与历史命令仍是单仓库接口，
`GitReference` 只在浏览器侧多带一个可选的 `repositoryPath`。
点击其它仓库的分支会把活动仓库切换过去，再加载该分支的历史。

仓库引用是**按需加载**的：打开 Git Log 时只读活动仓库；其它仓库要等它在引用树里
可见且展开时才读，读到后缓存，直到该仓库发生 Git 变更才刷新。这样打开大型多仓库
工作区不再一次性发起 N 次 Git 读。

读取必须**串行**：解析仓库路径会执行一条持有"仓库级写租约"的 Git 命令，而该租约
按 Git 公共目录（common dir）加锁。一个仓库的多个链接工作树共享同一个公共目录，
并发解析会互相报 "another Git write operation is running"，导致工作树取不到引用而显示 0 条。
按需加载不改变这一点：所有加载请求（活动仓库首读、展开时的按需读、变更刷新）
都排进同一条串行队列。

## 问题

工作区（例如 `D:/workspace/work-code/op`）下可以有多个并列仓库，其中 `op-platform`
还带一批链接工作树（`git worktree`，位于 `op-platform/.worktrees/<name>`）。以前的
Windows Git Log 只显示单个活动仓库的分支：

- `git-log-tool-window.tsx` 用 `activeRepoPath ?? rootFolderPath` 作为唯一 `repoPath`，
  `useGitLogController` 只取一个仓库的引用；
- 引用树 (`git-reference-tree.tsx`) 只按 Local / Remote / Tags 分层，没有仓库维度。

结果就是多仓库工作区里"只渲染了部分分支、没有按仓库分组"。

## 决策

### Tags 引用节点可以删除本地标签

Tags 中每个标签的右键菜单在最后一组提供 `Delete`，仅活动仓库允许执行。
依据 IntelliJ Community `fb72b4df43ab` 的
`plugins/git4idea/backend/src/ui/branch/GitBranchPopupActions.java` 中 `TagActions` / `DeleteTagAction`，
以及 `plugins/git4idea/backend/src/branch/GitDeleteTagOperation.java`：默认删除本地标签，
远程删除是独立动作，不随本地删除自动执行。按用户要求，Delete 与 Git 分支及提交节点的删除操作
共用已有 `TrashIcon`，只复用图标，不新增删除行为。

Windows 入口复用已有 `deleteTag` API，点击 Delete 后直接删除完整名称对应的本地标签，不再二次确认；失败保留标签和选择。
成功后先清除被删标签的历史筛选，再刷新引用与历史，避免继续查询已经不存在的标签。
删除期间阻止重复请求及其他引用写操作；工作区或仓库变化后旧动作回调不能发起删除，
已经发出的操作仍属于原仓库，但迟到结果不能刷新新仓库或解除新操作的禁用状态。

### 从提交节点创建标签

提交右键菜单提供 `New Tag…`，只允许一个提交，多选或正在执行 Git 写操作时禁用。
依据 IntelliJ Community `fb72b4df43ab` 的
`plugins/git4idea/backend/src/actions/GitCreateTagAction.java`、
`platform/dvcs-impl/src/com/intellij/dvcs/ui/VcsLogSingleCommitAction.java` 和
`plugins/git4idea/backend/resources/intellij.vcs.git.backend.xml`。
输入框只填写标签名称，空名称或包含空白字符时无法提交；该入口创建轻量标签，
即没有附加注释和签名的标签。需要注释或签名仍使用已有标签管理器。

弹窗打开时固定活动仓库和右键提交的完整 hash，不提供可变目标字段，也不默认使用 HEAD。
复用已有 `createTag` API，由 Git 校验完整的标签名规则，成功后刷新引用及提交历史；失败保留名称以便重试。
弹窗使用共享 `AppDialog` 和 `Input`，工作区或仓库切换会卸载旧弹窗；已经发出的写入仍归属
原仓库，迟到结果不能刷新或关闭新仓库的弹窗。不要把同一个弹窗换成新仓库路径后继续复用旧请求。

Git Log 标题栏不显示固定的 `Read-only` 标签：面板已经支持活动仓库的分支和提交写操作，
固定文字会误导用户。关闭按钮仍靠右；非活动仓库引用的只读限制继续由原有操作策略管理。

本地和远程分支右键菜单先显示“拷贝分支名称”，删除操作单独放在最后一组，
方便复制并降低误点删除的机会。当前分支仍不提供删除，执行 Git 写操作时删除仍禁用。

### Tags 默认折叠，手动展开状态继续保存

没有已保存引用折叠设置时，单仓库和多仓库 Git Log 的 Tags 默认折叠，
Local / Remote 默认展开，避免标签较多时占满引用面板。
初始值由 `git-log-preferences.store.ts` 的 `collapsedReferenceSections` 管理；
手动展开、折叠和全部展开仍使用原有持久化逻辑，重新打开面板时保留用户选择。
已有折叠设置优先于默认值，不在打开面板时强制重置，也不迁移覆盖已保存的展开状态。

### 本地与远程分支复用同一个图标

普通本地、远程分支都使用顶部分支按钮已有的 `VcsIcon`（含明暗主题资源），
分支所属位置由 Local / Remote 和远程名称分组表达，不再给远程分支使用网络节点图标。
依据是 IntelliJ Community 版本 `fb72b4df43ab` 的
`plugins/git4idea/shared/src/com/intellij/vcs/git/ui/GitBranchesTreeIconProvider.kt`：
Git Log 的 `BranchesTree.kt` 与分支菜单共用该提供器，普通分支都走 `AllIcons.Vcs.BranchNode`。
具体图形按用户指定的顶部分支按钮复用：IDEA 的
`plugins/git4idea/frontend/src/com/intellij/vcs/git/frontend/widget/GitToolbarWidgetAction.kt`
使用 `AllIcons.General.Vcs`，Lithe 已映射到 `expui/general/vcs.svg` 与 `_dark.svg`。
不要替换成下拉列表中的实心 `GitBranchIcon`；当前分支勾选、收藏星标、标签和分组文件夹继续表达各自状态。

### 仓库维度的分组放在前端，不下沉到 Core

Core 的 `git.references` / `git.historyPage` 保持单仓库入参（`root`）。多仓库聚合由
Windows 前端完成：新 hook `windows/tauri/src/features/git/hooks/use-git-workspace-references.ts`
遍历 `availableRepoPaths`，逐个调用现有 `getGitReferences`，给每条引用打上
`repositoryPath`（规范化的仓库根），并按仓库缓存与取消。

理由是：分组是**呈现层**能力，历史分页、游标、diff、控制台都属于活动仓库；把
"列出所有仓库的引用"做成 Core 新命令会把仓库身份这一呈现概念塞进稳定契约。
`GitReference` 的 `repositoryPath` 因此是前端类型里的可选字段，不进 JSON C ABI。

引用树在 `repositoryPaths.length > 1` 时渲染仓库层，折叠状态复用 preferences 里的
`collapsedReferenceGroups`（id 形如 `repo:<规范化路径>`），组内节点 id 带仓库前缀，
避免不同仓库的同名分支共享折叠状态。单仓库时渲染路径与以前完全一致。

### 各仓库的引用串行读取

工作区里的链接工作树共享主仓库的 Git 公共目录。解析仓库路径（前端
`resolveRepositoryPath` → 原生 `git_discover_repo` → Core `git.command` 执行
`rev-parse --show-toplevel`）会持有按公共目录加锁的写租约；若并发解析同一公共目录
下的多个工作树，除第一个外都会失败。因此 `useGitWorkspaceReferences` 把所有读取
请求排进一条 Promise 串行队列（`loadChainRef`），活动仓库首读、展开时的按需读、
变更刷新都从同一条队列出队，任何时刻只有一个 Git 读在飞。工作树本身是合法仓库
（Core 的发现明确返回 `.git` 文件形式的工作树），修复方向是让读取不互相冲突，
而不是把工作树从仓库列表里剔除。

### 只有活动仓库预先加载，其余按展开加载

首版实现一打开 Git Log 就遍历 `availableRepoPaths` 把所有仓库读一遍，仓库一多就是
N 次串行 Git 读。现在 hook 只主动读**活动仓库**，其它仓库通过返回的
`ensureRepository(repositoryPath)` 按需触发：引用树在某个仓库分组可见且未折叠时
调用它，展开折叠的分组也会触发。已请求过的仓库记录在 `requestedRepositoryKeysRef`
里，重复请求直接返回，形成缓存；仓库从工作区移除时清掉该记录并取消它自己的在飞操作。
Git 变更刷新只作用于已请求过的仓库。活动仓库改变或列表变化时，活动仓库会被重新
确保加载。

活动仓库的引用同时由 `useGitLogController` 提供并被引用树直接使用，hook 侧对活动
仓库的读取主要用于保持"活动仓库总是已加载"这一不变式和刷新语义一致。

读取串行执行（同一个 common dir 的兄弟工作树读引用会互相抢仓库写租约），所以一次请求
可能要排在前面若干次读取之后才真正开始。**排队不等于已经发出**：仓库代数在入队时就占住，
真正调用原生 API 前要重新核对"面板没卸载、仓库还在工作区、没有更新的请求顶替"。三者任一
不成立就丢掉这条排队项，并把它占用的 pending 计数还回去。否则会出现：A 的读取挂起、B 入队、
面板关闭，A 取消完成后 B 仍会发起一次没有主人负责取消的原生读取。

### 点击其它仓库的分支要切换活动仓库

引用树只负责选中，不负责加载历史。选中一条属于非活动仓库的引用时，
`GitLogToolWindow` 先把活动仓库切到该仓库（`selectRepository`），再用一个
pending 引用 ref，在 `repoPath` 变化后的 effect 里调用 `selectReference`。
这样历史的单仓库语义不变，也避免引入"一个窗口同时展示多个仓库历史"的新状态机。

## 考虑过的备选方案

- **在 Core 增加"聚合所有仓库引用"的新命令**：被否。它把呈现层的仓库身份引入稳定
  契约，还要为两个平台同时定义 fixture；每个仓库的引用读取已有命令可复用。
- **在 Core 的 `GitReferenceResponse` 上直接加 `repositoryPath`**：被否。活动仓库由
  应用层决定，Core 不该知道"工作区里有哪几个仓库"。
- **并发读取各仓库引用**：被否，见上文租约冲突。前端最初的 `Promise.all` 会让
  同主仓库的工作树互相失败。
- **让 Core 的仓库发现跳过 `.git` 文件（工作树）**：被否。Core 现有集成测试
  `workspace_repositories_discovers_multiple_child_repositories` 明确要求发现工作树标记，
  契约文档也写明 `.git` 目录和 `.git` 文件都算仓库标记；剔除工作树会破坏该既定行为。
- **打开时一次性加载所有仓库（初版实现）**：被否。仓库越多首屏要串行等待越多，
  而大多数仓库分组是折叠的、用户不会去看；改为只预读活动仓库，其余按展开加载，
  代价是展开时多一次读。

## 后果

- 多仓库工作区能按仓库看到分支，并知道每条分支属于哪个仓库；工作树作为独立仓库
  照常出现，且能看到与主仓库共享的分支。
- 单仓库用户不受影响：引用树不出现仓库层，行为与此前一致。
- 打开 Git Log 只读活动仓库，其余仓库在首次展开时读一次并缓存；仓库越多，
  首屏越快，代价是展开新仓库时有一次可见延迟（先显示 0 条再填充）。
- 各仓库引用仍顺序读取，换来的是同一公共目录下不互相抢租约。
- 只在 `repositoryPaths.length > 1` 时走仓库分组与多仓库按需读取。
- macOS 端尚未做对应的引用树分组，行为与 Windows 暂不一致。

## 验证

- `use-git-log-tag-deletion.test.tsx` 验证直接删除、名称及仓库目标、重复请求、失败重试、旧动作回调失效和
  迟到删除结果隔离；`git-reference-actions.test.ts` 验证标签包含删除动作且不改变分支动作。
- 在 Windows Git Log 展开 Tags，右键一个标签确认最后一项为 Delete；点击后不弹二次确认，
  活动仓库本地标签消失，历史筛选回到全部引用，远程标签保持；非活动仓库和写操作期间不可删除。
- `git-create-tag-dialog.test.tsx` 验证名称校验、固定提交、重复提交、取消、失败重试和迟到结果隔离；
  `git-commit-table-tag.test.tsx` 验证右键目标不是 HEAD/旧选择，以及多选和执行写操作时的禁用。
- 在 Windows Git Log 中右键一个较早提交并新建标签，确认标签指向该提交，Tags 列表与历史引用刷新；
  检查中文和英文标题、取消及重复标签失败，切换仓库或工作区后旧弹窗关闭。
- 在没有已保存引用折叠设置的 Windows Git Log 中确认 Tags 默认折叠、Local / Remote
  默认展开；单仓库和多仓库均适用。展开 Tags 后重新打开面板，确认仍保留展开状态。
- 在 Windows Git Log 的 Local / Remote 中对比普通分支，确认与顶部分支按钮使用相同空心图标，
  明暗主题均正常；当前分支、收藏、标签及文件夹状态提示保持可辨认。
- Windows 前端：`tsc --noEmit`；`bun test src/features/git`，含
  `git-reference-tree.test.tsx`（单仓库保持扁平、多仓库按仓库分组）、
  `git-reference-tree-lazy-references.test.tsx`（可见的展开分组触发加载、折叠分组
  展开后才加载）与 `use-git-workspace-references.test.tsx`（只加载活动仓库、
  按需加载、只刷新已加载仓库、错误重试，以及排队项在面板卸载 / 仓库移出工作区后
  不得发起原生读取且要归还 pending 计数）。
- Rust 未改动（Core 的仓库发现和引用契约保持原样），`cargo test --manifest-path
  rust/lithe-core/Cargo.toml` 无需针对本改动重跑。
- 手工：在工作区 `D:/workspace/work-code/op` 打开 Git Log，确认仓库分组、工作树
  不再显示 0 条、点击跨仓库分支切换加载，以及单仓库项目无回归。

## 适用范围

适用于 Windows（`windows/tauri/src/features/git/`）的 Git Log 引用树。不改变
`git.references`、`git.historyPage`、`workspace.repositories` 的 JSON 契约；不覆盖
macOS 的引用树分组，也不覆盖左侧 Source Control 的分支切换下拉（仍是单仓库、
仅本地分支）。
