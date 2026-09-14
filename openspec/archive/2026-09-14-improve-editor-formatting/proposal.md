# Proposal: 编辑器高亮与便捷排版

**Change ID:** `improve-editor-formatting`
**Created:** 2026-09-11
**Status:** Archived — 实现与本次验收已完成，增量已合并至正式规格
**Completed:** 2026-09-11

## 问题与目标

当前行的不透明背景遮住 CodeMirror 选区；代码块没有配置语言解析器，显示模式也未着色。缺少格式按钮且普通单次换行被合并，使不熟悉 Markdown 的用户难以整理 TXT 中粘贴的文字。

## 已批准方案

- 修复聚焦、失焦与预览选区，当前行使用半透明背景。
- 每个编辑窗格增加正文/H1–H3、加粗、斜体、三类列表、引用、行内代码、代码块、链接与撤销/重做工具栏。保留选区，格式操作一步撤销并自动保存。
- 编辑与预览共享语言注册表、按需加载语言及语法配色；代码块按钮提供语言选择，已有代码块修改语言而不嵌套。
- 所有笔记显示模式保留单次换行，不因此改写文件正文。
- 支持 JS/TS/JSX/TSX、Python、Java、C/C++、C#、Go、Rust、HTML/CSS、JSON、SQL、Shell、PowerShell、YAML 及常见别名。未知/未指定/加载失败时完整显示纯文本。
- 预览只为可见代码块启动着色；超过 100,000 UTF-16 字符的单块保留纯文本，卸载取消未完成工作。

## 影响与范围

前端编辑、预览、样式、依赖与测试发生变化；沿用文档会话、保存事务和 UTF-8 Markdown 文件，不增加 Rust API、数据迁移、富文本编辑、TXT 导入或自动推断标题。新增语言模块本地打包，不使用网络服务。首版历史性能延期项目不属于本次完整验收。

## 成功标准

选区在实际截图中可见；工具栏可靠保留内容与撤销；TXT 换行保持；所有支持语言在两种模式中可着色；原有保存、分屏、链接与安全展示回归通过。类型检查、单元/界面测试、生产构建通过，并用独立测试笔记完成 Windows WebView2 验收及独立目录打包。

---

## Archive Information

**Archived:** 2026-09-14T11:09:18+08:00
**Duration:** 3 天（2026-09-11 完成实现与交付，2026-09-14 复核归档）
**Outcome:** 编辑器高亮与便捷排版已实现，本次质量检查与 WebView2 验收通过，正式程序及安装包已交付。
**Implementation Commit:** `38fbbd8`

### 归档依据

用户在实现完成后调用 `openspec-archive`。全部 8 项任务已完成；归档时重新通过类型检查、69 项前端单元测试、17 项界面回归、生产构建、9 项 Rust 测试及 Clippy，并核对原交付哈希。选区失焦测试改为等待 CodeMirror 的焦点样式更新，连续 5 次复测通过；未修改应用源码或重新打包原生程序。详细结果见 [验证记录](verification.md)。首版延期的性能与安装兼容性等验收保持原状态。

### Files Modified

- `src/editor.ts`、`src/markdown.ts`、`src/style.css`：编辑器接入、预览换行与着色、选区及工具栏样式。
- `src/code-languages.ts`、`src/formatting.ts`、`src/format-toolbar.ts`：共享语言注册表、格式事务与工具栏。
- `package.json`、`package-lock.json`：本地按需语言模块与高亮依赖。
- `tests/formatting.test.ts`、`tests/code-languages.test.ts`、`tests/fixtures/code-samples.ts`、`tests/e2e/formatting.spec.ts`：格式、语言及界面回归。
- `scripts/editor-native-config.json`、`scripts/editor-native-smoke.mjs`：隔离 WebView2 验收配置与脚本。
- `docs/verification/editor-formatting-native-*.png`、`docs/verification/raw/editor-formatting-*.json`：实机截图、结果与交付哈希。
- `README.md`、`docs/verification/README.md`、`openspec/project.md`：使用说明、验收入口与归档状态。
- 本归档目录：提案、任务、增量规格与验证记录。

### Specs Updated

- [markdown-editor.md](../../specs/markdown-editor.md)：EDIT-03 补充换行与语言着色，新增 EDIT-05 可见选区、EDIT-06 格式工具栏；原有语法、图片与安全规则保留。
- [runtime-resources.md](../../specs/runtime-resources.md)：新增 PERF-05 按需、有界、可取消的预览着色；原有性能要求保留。
