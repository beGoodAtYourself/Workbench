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
- 增量规格使用 `specs/*_delta.md` 格式；首版六份增量及后续变更均已合并至 `openspec/specs/`，作为后续需求依据，当前无活动变更。本次编辑器改进已验收，首版历史性能等延期项目仍待完整验证。

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
