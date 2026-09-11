# Proposal: 本地个人工作台

**Change ID:** `add-local-personal-workbench`
**Created:** 2026-09-11
**Status:** Archived — 提前归档，剩余测试延期

## Problem Statement

用户需要一个能快速调出的个人工作台，在同一界面中管理本地 Markdown 笔记、对照阅读相关笔记，并查看剪贴板。核心体验是文件易管理、引用易建立、阅读不中断，同时降低应用常驻带来的内存消耗。

当前工作区为空。本变更提出首版完整功能边界和验收标准，没有现有实现需要兼容。

## Proposed Solution

首版面向 Windows，提供一个主窗口、一个可关闭的悬浮入口及可配置的全局快捷键。主窗口顶部始终显示「笔记管理」「剪贴板」入口；默认进入笔记管理，之后恢复上次所在模块。

笔记管理直接使用用户选定的本地目录。左侧显示真实文件夹和 `.md` 文件，右侧最多容纳两个笔记窗格；各窗格独立切换编辑与显示模式。把文件树中的笔记拖入编辑区，在落点插入标准 Markdown 相对链接；打开链接时，左窗格显示发起跳转的笔记，右窗格显示目标笔记。

拟采用 Tauri 2、Rust 与 TypeScript，使用 CodeMirror 6 的必要模块进行 Markdown 源码编辑。系统集成和文件操作归后端管理，界面资源按需加载。此选型需先通过内存与窗口生命周期验证，再进入主体实现；依据与替代方案见 [design.md](design.md)。

## Scope

### In Scope

- Windows 桌面应用，悬浮入口和全局快捷键均可唤起同一个主窗口。
- 顶部双模块入口及主窗口隐藏、恢复、明确退出操作。
- 选择一个本地笔记根目录，读取已有笔记，记住目录设置。
- 文件树展开、折叠、新建文件夹、新建 `.md` 文件、重命名、移至系统回收站及手动刷新。
- Markdown 显示、源码编辑、自动保存和 `Ctrl+S`，保存失败及外部修改冲突处理。
- 文件树拖拽生成相对链接、链接解析、双分屏打开和连续跳转。
- 当前剪贴板文本展示、刷新，以及空内容、非文本和读取失败状态。
- 按需读取正文、限制缓存、释放闲置界面资源及可复现的性能验收。

### Out of Scope

- macOS、Linux、移动端、云同步、账户和多人协作。
- 剪贴板历史、图片历史、开机自启、全局搜索、标签、知识图谱及插件体系。
- 富文本编辑、PDF/Office 预览、三个及以上笔记窗格。
- 文件移动、自动批量改写引用、跨笔记库链接和数据库存储正文。

## 已确认与默认假设

| 项目 | 本提案采用的规则 | 状态 |
|---|---|---|
| 首版平台 | Windows | 用户已确认 |
| 标题页含义 | 主窗口顶部持久显示两个模块入口 | 根据需求作出的设计解释 |
| 调出方式 | 同时支持悬浮入口与全局快捷键，悬浮入口可关闭 | 提案默认 |
| 快捷键 | 默认 `Ctrl+Alt+Space`，允许修改；冲突时提示调整 | 提案默认 |
| 剪贴板 | 仅显示当前文本，不收集历史、不持久化 | 已发起范围澄清；未收到回答时采用此默认 |
| 连续跳转 | A→B 为 A｜B；从右侧 B→C 后变成 B｜C | 提案默认，确保每次跳转均为左来源、右目标 |
| 保存 | 停止输入 500 ms 后自动保存，`Ctrl+S` 立即保存 | 提案默认 |
| 内存数值 | 隐藏常驻 120 MiB、单笔记 200 MiB、双笔记 260 MiB | 拟议预算，尚未实测 |

## 需求追踪

| 用户需求 | 对应规格 | 主要实施阶段 |
|---|---|---|
| 1. 悬浮窗或快捷键调出 | [desktop-shell_delta.md](specs/desktop-shell_delta.md) | 1、4 |
| 2. 两个功能入口 | [desktop-shell_delta.md](specs/desktop-shell_delta.md)、[clipboard-view_delta.md](specs/clipboard-view_delta.md) | 4 |
| 3. 笔记存本地 | [local-notes_delta.md](specs/local-notes_delta.md) | 2 |
| 4. 文件管理与 Markdown 展示 | [local-notes_delta.md](specs/local-notes_delta.md)、[markdown-editor_delta.md](specs/markdown-editor_delta.md) | 2、3 |
| 5. 左文件树、右正文及新建操作 | [local-notes_delta.md](specs/local-notes_delta.md) | 2、3 |
| 6. 编辑与显示两种模式 | [markdown-editor_delta.md](specs/markdown-editor_delta.md) | 3 |
| 7. 拖拽生成链接并打开分屏 | [note-links_delta.md](specs/note-links_delta.md) | 3 |
| 8. 最多双分屏、左来源右目标 | [note-links_delta.md](specs/note-links_delta.md) | 3 |
| 9. 降低运行时内存 | [runtime-resources_delta.md](specs/runtime-resources_delta.md) | 1、5 |

## Impact Analysis

| 组件 | 变更 | 说明 |
|---|---|---|
| 数据库 | 无 | 正文直接存储于 `.md`，设置使用本地小型配置文件 |
| 文件层 | 新增 | 目录枚举、路径解析、保存、冲突检测、重命名与回收站 |
| 系统集成 | 新增 | 快捷键、悬浮入口、托盘、窗口生命周期、剪贴板 |
| 状态 | 新增 | 模块、文件树、至多两份打开文档及各自编辑状态 |
| 界面 | 新增 | 顶部入口、文件树、Markdown 窗格、剪贴板视图 |
| 性能验证 | 新增 | Windows 发布构建的进程集合内存和唤起延迟记录 |

## Architecture Considerations

文件系统是笔记的唯一正文来源；内存仅持有打开文档和有限的视图状态。双分屏共享一个主界面运行环境，不能为每篇笔记创建独立窗口。悬浮入口不能载入笔记树或编辑器。隐藏后，仅在保存成功且无冲突时释放主界面，并保留再次打开所需的文件路径、模式及滚动位置。

首个实施阶段应验证悬浮入口的原生实现与最小 WebView 实现的实际增量成本，再确定实现方式。Tauri 使用系统 WebView 并不意味着运行内存必然较低，数值必须测量完整应用进程集合。

## Success Criteria

以下保留原提案验收目标；提前归档不自动勾选目标。当前检查状态以 [任务清单](tasks.md) 和 [后续验收](../../../docs/verification/deferred-tests.md) 为准。

- [ ] 两种入口均能在其他应用处于前台时唤起工作台，重复操作不会产生多个主窗口。
- [ ] 断网时能选择本地目录、新建及编辑笔记；退出重开后文件内容一致。
- [ ] 文件树与磁盘结构一致，新建、重命名和删除失败时不错误显示成功。
- [ ] 两个笔记窗格可独立切换模式，切换和替换不会静默丢弃编辑内容。
- [ ] 中文、空格和特殊字符路径的拖拽链接可正确保存、重开并导航。
- [ ] A→B→C 连续跳转符合左来源、右目标规则，任意时刻不超过两个笔记窗格。
- [ ] 剪贴板展示符合最终选定范围，隐藏后停止无用读取。
- [ ] 完成发布构建的常驻、单笔记、双笔记、唤起及重复操作测量，满足性能规格；未达标时完成优化或修订预算后重新评审。

## Risks & Mitigations

| 风险 | 概率 | 影响 | 缓解方式 |
|---|---|---|---|
| WebView 与悬浮入口常驻成本超过预算 | 中 | 高 | 最先验证空壳成本、比较悬浮实现、闲置卸载并测量整个进程集合 |
| 外部编辑或保存失败导致正文损失 | 中 | 高 | 保存前校验版本、同目录临时文件替换、保留失败缓冲并阻止丢弃 |
| 重命名后相对链接失效 | 中 | 中 | 首版说明不自动更新引用；跳转时检测缺失，保留原布局供用户修复 |
| 连续跳转时覆盖另一窗格的未保存内容 | 中 | 高 | 跳转事务先校验目标并处理被移出文档，再一次性提交布局 |
| 快捷键占用或显示器变化影响唤起 | 中 | 中 | 提供配置、托盘入口和工作区内位置恢复 |
| 大笔记、剪贴板内容或长时间使用扩大内存 | 中 | 中 | 内容大小保护、有限缓存、事件解绑与重复操作测量 |

## Review Artifacts

- [技术与交互设计](design.md)
- [实施任务清单](tasks.md)
- 六份 `specs/*_delta.md` 增量规格；本变更仅新增能力，没有既有需求被修改或移除。

---

## Archive Information

**Archived:** 2026-09-11T15:19:08+08:00

**Duration:** 0 天（创建与归档均为 2026-09-11）

**Outcome:** 当前实现提前归档；剩余测试延期，不代表全部验收完成。

### 归档依据

用户明确要求：“先进行归档，其他测试我后续再进行”。本次据此跳过剩余验收执行，将六份增量规格合并到正式规格，保留未勾选任务与既有测试证据。性能预算不降低，也不标记为整体达标；后续事项见 [待验收清单](../../../docs/verification/deferred-tests.md)。

### Files Modified

- `src/`：本地笔记界面、会话、保存状态、Markdown 编辑与双分屏。
- `src-tauri/`：Rust 文件操作、配置、Windows 快捷键/悬浮入口、窗口生命周期及剪贴板。
- `tests/`、`scripts/`：状态、文件、交互与原生验收，以及内存采样工具。
- `README.md`、`docs/verification/`：运行与安装说明、已有证据、部分性能数据及待验收清单。
- `package.json`、依赖锁文件与构建配置：可复现的 Windows 桌面开发及安装包构建。

### Specs Updated

- [clipboard-view.md](../../specs/clipboard-view.md)
- [desktop-shell.md](../../specs/desktop-shell.md)
- [local-notes.md](../../specs/local-notes.md)
- [markdown-editor.md](../../specs/markdown-editor.md)
- [note-links.md](../../specs/note-links.md)
- [runtime-resources.md](../../specs/runtime-resources.md)
