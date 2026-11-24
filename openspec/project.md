# 个人工作台项目上下文

## 项目目标

构建便于随时调出的个人桌面工作台，提供本地 Markdown 笔记管理及剪贴板显示，并尽量降低常驻内存占用。

## 当前状态

- 2026-09-11 创建提案时，工作区为空，没有已有应用代码、技术栈、测试命令或正式规格。
- 用户已确认：首版支持 Windows。
- 本次变更 `add-local-personal-workbench` 已于 2026-09-11 按用户要求提前归档，核心实现与已有验证保留；尚未完成的测试交由用户后续进行，见 [待验收清单](../docs/verification/deferred-tests.md)。
- 首版归档记录位于 [提案](archive/2026-09-11-add-local-personal-workbench/proposal.md) 与 [任务清单](archive/2026-09-11-add-local-personal-workbench/tasks.md)，后续变更见下方记录。
- 2026-09-11 完成并归档 [fix-sibling-folder-creation](archive/2026-09-11-fix-sibling-folder-creation/proposal.md)：补齐返回根目录和新建同级文件夹入口，FILE-02 与说明已同步，27 项前端单元测试、9 项界面回归、9 项 Rust 测试及静态检查通过；Windows 修复版已打包。该独立修复记录在归档时按实际工作补录，首版延期验收状态保持不变。
- 2026-09-11 完成 [improve-editor-formatting](archive/2026-09-14-improve-editor-formatting/proposal.md)，2026-09-14 复核并归档：修复选区遮挡，新增格式工具栏、代码语言着色及显示模式保留换行；69 项单元测试、17 项界面回归、类型检查和 7 组隔离 WebView2 实机检查通过，正式程序与 NSIS 安装包已独立生成。归档复核通过前端自动化、生产构建、9 项 Rust 测试及 Clippy，原产物哈希核对一致。两份增量已合并至正式规格，任务和[验证记录](archive/2026-09-14-improve-editor-formatting/verification.md)保存在归档目录。
- 增量规格使用 `specs/*_delta.md` 格式；已归档变更均已合并至 `openspec/specs/`，作为后续需求依据。本次编辑器改进已验收，首版历史性能等延期项目仍待完整验证。
- 2026-09-14 完成 [add-folder-reordering-and-moves](changes/add-folder-reordering-and-moves/proposal.md)：支持文件夹上下排序、跨目录移动及每库顺序记忆。128 项前端单元测试、39 项界面回归、24 项 Rust 测试、静态检查与构建通过；隔离 Windows WebView2 的 7 组目录验收及真实 60 秒隐藏卸载／唤醒检查通过。正式程序和 NSIS 安装包已从独立目录生成，见 [验证记录](changes/add-folder-reordering-and-moves/verification.md)。实施已完成，两份增量规格尚待归档时合并至正式规格，首版延期验收状态保持不变。

- 2026-09-14 根据用户反馈完成 [add-note-reordering-and-moves](changes/add-note-reordering-and-moves/proposal.md)，补齐单篇 Markdown 笔记同级排序及跨目录移动。148 项前端单元测试、52 项界面回归、31 项 Rust 测试、Clippy、生产构建及 7 组隔离 Windows WebView2 验收通过；正式程序及安装包已生成，见 [验证记录](changes/add-note-reordering-and-moves/verification.md)。两份增量待文件夹变更归档后合并，首版延期状态不变。

2026-10-14 已实现 [add-launch-at-startup](changes/add-launch-at-startup/proposal.md)：默认关闭的当前用户登录自启动、后台按需界面、设置失败恢复及 NSIS 生命周期保护。148 项前端单元测试、68 项界面回归、54 项 Rust 测试、Clippy、8 项安装器模拟、14 项隔离原生启动和 8 组实际安装／卸载检查通过；正式程序与安装包位于独立 `src-tauri/target/startup/release/`。真实注销登录、系统禁用及 GUI 跨版本升级待验收，状态为 Implemented — Acceptance Pending，不提前归档；见 [验证记录](changes/add-launch-at-startup/verification.md)。已有整理变更及首版延期状态保留。

## 已明确的产品要求

1. 通过悬浮窗或全局快捷键调出工作台。
2. 标题区域提供笔记管理和剪贴板两个入口。
3. 笔记以本地文件保存，使用 Markdown 展示。
4. 左侧文件夹与笔记树支持新建等文件操作，右侧显示笔记。
5. 每个笔记支持编辑模式和显示模式。
6. 从文件树拖入编辑区生成链接；打开本地 Markdown 链接形成双分屏。
7. 最多两个笔记窗格，左边保留发起跳转的文件，右边显示目标文件。
8. 以低运行时内存占用为架构约束。

## 提案约定

- 文档使用中文；变更 ID 和规格文件名使用英文 kebab-case。
- 笔记正文是普通 UTF-8 `.md` 文件；磁盘目录结构是文件树的来源。
- 不要求账户、云端服务或数据库才能使用核心功能。
- 未经实现和实测，不将性能预算描述为实际性能。
- 详细设计、默认假设和实施依赖见归档目录，行为要求见正式规格目录。

## 实现与验证

- Tauri 2 / Rust + TypeScript / Vite，CodeMirror 6 源码编辑，Marked 与 DOMPurify 渲染。
- Win32 原生悬浮入口，共用单个主 WebView；隐藏 60 秒后卸载。
- `npm run desktop` 启动桌面开发版；`npm run package` 生成 Windows x64 NSIS 安装包。
- `npm run check`、`npm test`、`npm run test:e2e` 验证前端；`cargo test --manifest-path src-tauri/Cargo.toml` 和 `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` 验证后端。
- 用 `.qa/` 中生成的测试库进行原生验收，不使用个人笔记。最终报告位于 `docs/verification/`。

## 文本编辑增量实施记录（2026-10-16）

[add-text-editor-module](changes/add-text-editor-module/proposal.md) 已实现，状态为 **Implemented — Acceptance Pending**，新增独立「文本编辑」，使顶部导航扩展为笔记管理、文本编辑、剪贴板。上文原有产品要求、笔记双窗格与历史验收记录保留；文本标签及草稿与笔记库独立，当前主窗口最多挂载两个编辑器。

- 文本模块最多 12 个标签与两个不同文档的并排视图，复用 CodeMirror 及现有 18 个代码语言入口，另提供 Markdown、XML、纯文本和独立可终止搜索 Worker。
- 文本原文件显式保存，停止编辑约 1 秒后暂存本机恢复，正常模块切换、隐藏、退出及 60 秒卸载前要求最新代次持久化确认；笔记继续 500 ms 自动保存。正常退出保留文本草稿，关闭标签选择不保存才明确删除对应恢复引用。
- 宿主原生对话框仅授权具体文件，以不透明记录 ID 读写；跨笔记／文本的同一文件共享唯一所属会话。笔记改名、移动及回收涉及活动文本路径或祖先时拒绝，纯排序不受影响，换库不清空文本。
- 编码于 2026-10-29 扩展为 47 个选项，包含 GBK／GB18030、Big5、日韩、Windows／ISO 系列及 UTF-16／UTF-32 有无 BOM 变体；支持自动识别、指定编码打开与重读，无损转换失败不写文件，见[验证记录](../docs/verification/text-encodings.md)。混合或 CR 换行编辑后保存前明确统一为 LF／CRLF。文本单文件字节上限 16 MiB、2 MiB 确认、总正文 16 Mi UTF-16 代码单元；恢复正文单代 64 MiB、元数据 128 KiB、包含临时及旧代的恢复目录总量 128 MiB。
- 2026-10-26 18:30预约已执行，QA 8d0066c1b881538985f1b5a347a92b2dfd876e6793814b5cc76ccc6cd877172f 的56项已执行原生检查通过，工作区／shell保留partial。完整性能545／545帧有效；三轮工作集增长27.83984375／22.6484375／24.78125 MiB，Private Bytes增长28.796875／24.453125／26.20703125 MiB，三轮均超各20 MiB上限，完整结果budget-failed。静态样式复用未解决原生循环增长，全部有效失败与旧fb／d82／dfe／d1c5历史保留。自有测试进程已退出，18:56确认并通知恢复键鼠，一次性自动化已删除。系统入口、物理ENOSPC和历史待验／归档依赖继续保留，未归档。 后端未改，80项Rust结果沿用。
- 真实全局快捷键／悬浮输入、原生剪贴板、物理ENOSPC及历史登录／升级待验项目保留。今晚单次原生复测已结束，没有追加修复版前台测试；旧对话框、目录选择器及9项安装生命周期payload保留原哈希。
- 独立交付为 `src-tauri/target/text-editor/release/shiye.exe` 与其 `bundle/nsis/拾页_0.1.0_x64-setup.exe`，版本 0.1.0，产物哈希见交付记录。实际结果及待验收项目集中记录在[文本编辑验证记录](changes/add-text-editor-module/verification.md)。

本次尚未归档。资源预算须按[增量规格](changes/add-text-editor-module/specs/runtime-resources_delta.md)实测；首版历史性能延期、自启动真实登录／系统禁用／GUI 跨版本升级待验收，以及整理变更的规格归档依赖均保持原状态。
