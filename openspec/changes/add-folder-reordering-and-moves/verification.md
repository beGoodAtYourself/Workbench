# 文件夹排序与移动验收

日期：2026-09-14。变更：`add-folder-reordering-and-moves`。

## 实现

- 文件夹同级拖动排序、跨父目录插入、移入目标文件夹及移回根目录；中文提示、可见插入线和目标框，菜单上移／下移、目标浏览、恢复同级默认排序。
- 排序偏好独立保存在应用配置目录的 `tree-order/<根路径摘要>.json`，每库上限 1 MiB；默认名称排序，已有自定义次序中的新增项持续追加。成功列出目录才整理偏好，重命名／移动映射后代记录。
- 后端规范路径检查、提交时禁止覆盖的 Windows 目录移动，完整保留非 Markdown 文件；不使用复制后删除回退。
- 移动前处理保存，失效旧导航和刷新请求；移动后保留文档对象、模式、滚动、光标与正文撤销，后续保存使用新路径。纯排序失败保留原次序；磁盘成功后的偏好／快照失败保留新路径并可重试。

## 自动化结果

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 128 项通过：路径 14、会话 28、文件夹 44、格式 21、语言 21 |
| `npm run test:e2e` | 最终 39 项全部通过，34.4 秒；文件夹 22、编辑器 8、原工作台 9 |
| TXT 模式切换连续复测 | 5 次全部通过，9.6 秒 |
| `npm run build` | 通过，语言模块继续本地按需加载 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 24 项通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过 |
| Windows WebView2 原生目录验收 | 7 组通过，详见下方原始报告 |
| Windows WebView2 真实隐藏卸载与唤醒 | 通过，60,057.5091 毫秒后关闭 WebView，同一宿主恢复顺序和新路径会话 |

单元和界面测试覆盖同级及跨父目录插入、取消确认、Esc／blur／pointercancel、非法落点、同名竞态、锚点消失、虚拟列表自动滚动、两库隔离、损坏／超限／写失败、部分成功重试、双窗格移动后保存与撤销。Rust 使用真实临时目录验证任意字节保留、独占锁、junction 和实际提交时目标冲突。

集成复核还修复了旧目录刷新失败迟到时清理新状态的问题；点击／悬停展开和目标浏览现在同步最新排序记录，避免分批外部新增时 UI 暂时按旧顺序显示。达到 300 个展开目录上限时，移动成功后定位可见目标祖先并保留明确提示。后两项增加了专门界面回归。

完整套件曾暴露一处旧 TXT 测试时序：点击编辑模式后立即读取 `.cm-line`，异步编辑器尚未挂载时返回空列表。测试现等待编辑器可见并轮询完整正文，5 次连续复测和最终全套通过；没有降低对正文完整性的断言。

## 原生环境与证据

用户已有正式程序在运行，本次使用源码与资源相同、应用标识为 `local.shiye.workbench.folderqa` 的隔离构建。`scripts/folder-native-config.json` 只覆盖测试标识；脚本为每轮创建独立 `.qa/folder-native-*` 数据和笔记库，通过 WebView2 CDP 驱动界面及真实 Tauri IPC，不操作用户笔记，不宣称物理鼠标／键盘手工验收。

原始报告：[folder-moves-native.json](../../../docs/verification/raw/folder-moves-native.json)。记录程序哈希、25 个前端资源哈希、测试目录以及移动前后每个文件的字节数／SHA-256。7 组检查分别为：

1. 插入线及同级排序持久化，排序前后正文和附件哈希相同。
2. 完整目录移动、非 Markdown 附件、真实 BOM/CRLF、双窗格路径与撤销／重做，后续保存只写新路径。
3. 移回根目录、跨父目录锚点插入，退出重开后恢复排序和两个新路径会话。
4. 外部修改引起真实保存冲突，移动被阻止，本地缓冲和磁盘内容保留，明确重新载入后继续使用。
5. 外部增删改、两份真实笔记库的独立排序。
6. 同名、自身／后代、根目录及锚点消失的后端拒绝，不覆盖已有文件。
7. 只读排序文件导致纯排序失败；实际目录移动成功时保留新路径和待保存顺序，解除只读后重试记录成功。

脚本初次在保存后文件树重绘期间调用 `scrollIntoViewIfNeeded`，因旧行脱离 DOM 失败。现等待文件操作完成并使用可重试的 `hover` 定位后开始拖动；重跑 7 组全部通过。

另以同一隔离程序和新的 `.qa/folder-idle-*` 测试库验证真实隐藏计时：[folder-moves-idle.json](../../../docs/verification/raw/folder-moves-idle.json)。隐藏后等待 60,057.5091 毫秒，观察 WebView 页面实际关闭，宿主 PID 仍存活；第二次启动唤醒原宿主，恢复根目录顺序 `C、B`、子目录 `B/A` 及 `B/A/doc.md` 的编辑模式、光标和展开项。文件 SHA-256 前后一致。本次没有调用 `profile_unload` 快进，也不据此扩展内存或唤起性能结论。

已目视检查浏览器三张截图及原生四张截图：[插入线](../../../docs/verification/folder-native-insert.png)、[移入目标](../../../docs/verification/folder-native-inside.png)、[移动后双窗格](../../../docs/verification/folder-native-split.png)、[磁盘成功但偏好写入失败](../../../docs/verification/folder-native-partial.png)。深绿插入线与整行绿色边框可区分，长错误信息可换行，重试入口可见。Impeccable 检测只报告既有 Markdown 引用样式，与此次交互无关，沿用原界面视觉。

## 复现构建

```powershell
$env:CARGO_TARGET_DIR='D:\lxWorkspace\src-tauri\target\folder-moves'
$env:CARGO_NET_OFFLINE='true'
npm run tauri -- build --no-bundle --config D:\lxWorkspace\scripts\folder-native-config.json
node scripts/folder-native-smoke.mjs src-tauri/target/folder-moves/release/shiye.exe
node scripts/folder-native-idle.mjs src-tauri/target/folder-moves/release/shiye.exe
# 保存隔离验收程序后，再以正式标识生成交付。
npm run package
```

本次没有重新进行首版延期的完整内存预算、唤起性能、物理 DPI、安装／升级／卸载或缺少 WebView2 的干净系统验收；对应历史延期状态保持不变。移动不自动修复 Markdown 相对链接或图片引用，使用说明和确认框均已写明。突然退出导致恢复记录仍为旧路径时只提示缺失，不通过自动保存重新创建旧文件。

## 最终交付

正式程序与 NSIS 安装包输出至独立目录 `src-tauri/target/folder-moves/release/`，应用标识为 `local.shiye.workbench`，已确认程序不含 QA 标识。与隔离验收构建的 25 个前端资源逐文件 SHA-256 完全一致；正式程序包含 NSIS bundle 标记。原始记录见 [folder-moves-delivery.json](../../../docs/verification/raw/folder-moves-delivery.json)。

| 产物 | 大小 / bytes | SHA-256 |
| --- | ---: | --- |
| `shiye.exe` | 6,330,368 | `9d688d95e90149e5a0446f1c9d5da0ce1503b7b9b0a2063f6ae6c632e6da25f3` |
| `bundle/nsis/拾页_0.1.0_x64-setup.exe` | 2,174,978 | `486637164284ccb7efbc4162335c2dec6d24fe0280495172ecadc9c16db26ba9` |

隔离原生验收程序 SHA-256 为 `405c4b52bc21b978faa1a845b80a2d943efa2509cabb2a3f0b2ae957e131e75a`，保留在 `src-tauri/target/folder-moves/qa/shiye.exe`。应用标识与 bundle 标记不同，因此不将隔离实测描述为直接运行交付二进制。
