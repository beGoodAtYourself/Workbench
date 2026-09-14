# 编辑器高亮与便捷排版验收

日期：2026-09-11。变更：`improve-editor-formatting`。

## 实现与验证范围

- 选区遮挡已通过原有页面复现：CodeMirror 的选区位于文字下层，而当前行背景不透明。半透明行背景修复遮挡；聚焦、失焦和预览分别设置选区样式。
- 工具栏修改经 CodeMirror 单一事务进入现有保存流程，撤销边界独立；标题转换后保留正文选区，可继续加粗。长代码里的反引号采用线性扫描选择安全围栏；中文全角缩进保留。
- 编辑与预览共享 18 个语言选项和静态 token 配色。预览在代码块进入视口后加载本地模块；100,000 UTF-16 字符以上不解析，不截断。关闭窗格后，尚未完成的语言加载不会继续解析旧正文或改写页面。
- 显示模式保留单次换行；没有为此增加正文转换、数据库或 Rust API。

## 自动化结果

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 69 项通过：路径 14、会话/保存 13、格式 21、语言 21 |
| `npm run test:e2e` | 17 项全部通过，最终运行 23.1 秒 |
| Vite 生产构建 | 通过；语言模块拆分为本地动态加载文件 |
| Windows WebView2 | 7 组检查通过，包含全部 18 个语言选项的编辑/预览、本地保存与退出重开 |
| Windows 正式标识程序与 NSIS 安装包 | 最终构建通过，使用正式标识；25 个前端资源与实机验证版本的 SHA-256 完全一致 |

格式测试覆盖占位、中文与全角空格、整行转换、跨行选择、末行边界、切换格式、撤销/重做、反引号与链接转义。语言测试覆盖全部选项、常见别名、未知/空语言、超长代码及加载后取消解析。

界面回归包括工具栏、标题后继续加粗、取消弹窗保留选区、已有代码块修改语言、CRLF 纯文本粘贴、18 个语言选项在两种模式的着色、超长/未知代码、安全 HTML、延迟及失败的语言加载，并执行原有文件操作、保存、分屏、链接与剪贴板回归。

已目视检查 `.qa/formatting-selection-focused.png`、`formatting-selection-blurred.png`、`formatting-selection-wrapped.png`、`formatting-selection-mouse.png`、`formatting-selection-split.png` 与代码预览截图。选区可见，窄分屏工具栏换行且不横向溢出。

## WebView2 与交付的复现方式

用户的旧版仍在运行，因此原生验收使用生产源码与资源、仅应用标识不同的隔离构建。`scripts/editor-native-config.json` 将标识设为 `local.shiye.workbench.editorqa`，不更改正式配置；`scripts/editor-native-smoke.mjs` 检查标识并创建独立的 `.qa/editor-native-*` 笔记及设置，不操作用户笔记。操作通过 WebView2 CDP 自动化执行，不宣称物理鼠标/键盘手工验收。

```powershell
$env:CARGO_TARGET_DIR='D:\lxWorkspace\src-tauri\target\editor-improvements'
$env:CARGO_NET_OFFLINE='true'
npm run tauri -- build --no-bundle --config D:\lxWorkspace\scripts\editor-native-config.json
node scripts/editor-native-smoke.mjs src-tauri/target/editor-improvements/release/shiye.exe
# 完成隔离验收后，使用正式标识重新生成交付程序和安装包。
npm run package
```

实机报告保存到 `docs/verification/raw/editor-formatting-native.json`，包含测试标识、独立笔记路径、程序 SHA-256、前端资源 SHA-256 和逐项检查。正式构建后比较前端资源哈希，确保与实机验证的资源一致。

本次实机逐项通过：工具栏焦点与连续格式操作、一步撤销/重做、真实文件 BOM/CRLF 保留、普通换行显示、双窗格选区与工具栏、全部语言在两种模式的本地加载和着色、代码块创建/语言修改、退出重开恢复，且未发现外部网络请求。测试报告将相关步骤归为 7 组。

实机截图已目视检查：[选区与工具栏](../../../docs/verification/editor-formatting-native-selection.png)、[双窗格](../../../docs/verification/editor-formatting-native-split.png)、[代码显示](../../../docs/verification/editor-formatting-native-code.png)。

本次不修改 Rust 行为；没有重做首版延期的完整内存预算、唤起性能、物理 DPI、安装/升级/卸载或缺少 WebView2 的干净系统验收。对应历史延期项目保持原状态。

## 最终交付

程序和安装包使用正式标识 `local.shiye.workbench`，独立输出到 `src-tauri/target/editor-improvements/release/`。已核对交付程序不含 QA 应用标识。机器可读记录见 [editor-formatting-delivery.json](../../../docs/verification/raw/editor-formatting-delivery.json)。

| 产物 | 大小 / bytes | SHA-256 |
| --- | ---: | --- |
| `shiye.exe` | 6,211,584 | `59ad0b41e8bfa7ce57b03e2a84f1b275d899eb5992704a37a6525a336594acc4` |
| `bundle/nsis/拾页_0.1.0_x64-setup.exe` | 2,132,790 | `ea52afc02455306b7617ffebdf7e083773fd960ed94f7e8ce19ea029e30dc789` |

程序构建完成后由 Tauri 写入 NSIS bundle 标记。隔离实机程序的 SHA-256 为 `62a467cd51187ecdd0883c793c193b37fa82453521938f4f24a9203570392293`；与交付程序不同是因为应用标识和 bundle 标记不同。已逐文件核对其 25 个前端资源与交付构建一致，不将隔离测试描述为对交付二进制本身的直接运行。

## 2026-09-14 归档复核

全部任务已完成，增量规格合并到正式规格，原有 Markdown 安全、图片规则和首版延期事项保持不变。

| 检查 | 归档复核结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 69 项通过 |
| `npm run test:e2e` | 最终 17 项全部通过，17.6 秒 |
| 选区测试连续复测 | 5 次全部通过，11.7 秒 |
| `npm run build` | 通过；25 个前端资源哈希与原交付记录一致 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 9 项通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过 |
| 正式程序与安装包 | 文件大小、SHA-256 与上表及交付 JSON 一致 |

首次界面复核中，失焦颜色断言在 CodeMirror 异步更新焦点类之前读取样式而失败。已将测试改为等待原生焦点切换及 `.cm-focused` 类更新后断言颜色，再连续复测 5 次并运行完整界面套件；未减弱颜色可辨认的断言，应用源码不变。

本轮仅修正测试时序、合并规格并更新归档文档，没有重新进行 WebView2 原生验收或重新打包；上方 2026-09-11 的原生证据和交付记录继续保留，不将本次归档复核描述为新一轮原生验收。
