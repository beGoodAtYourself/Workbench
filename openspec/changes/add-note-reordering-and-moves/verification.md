# 单篇 Markdown 笔记整理验收

日期：2026-09-14。变更：`add-note-reordering-and-moves`。

## 实现与回归范围

单篇笔记支持同组拖动排序、跨目录插入、移入文件夹和移回根目录，菜单可上移／下移或浏览目标。文件夹优先，两组独立应用保存顺序；旧版仅文件夹偏好无需迁移。笔记移动沿用保存互斥、旧请求失效与文档路径映射，保留正文撤销。笔记拖进编辑正文仍插入链接。

新增前端单元覆盖混合顺序、旧记录、外部变化、重命名／回收、大小写改名、名称以 `.md` 结尾的真实文件夹、文件移动与失败恢复。整合审查修正演示仓库在外部删除目标后尚未刷新时重命名到旧名的重复排序项；桌面后端原有目标清理已正确处理。

新增 13 项笔记界面回归，包含菜单边界、根目录移动、指定跨父目录插入、两阶段取消、确认期间重名、锚点消失、双窗格保存／撤销、冲突、纯排序失败、元数据重试及正文链接拖动。既有文件夹测试按真实目录集合检查目录组顺序，新测试另外断言完整混合偏好，保留两类验证。

## 自动化结果

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 148 项通过：路径 14、会话 28、排序 64、格式 21、语言 21 |
| `npm run test:e2e` | 最终 52 项全部通过，1.1 分钟，正常退出；文件夹 22、笔记移动 13、编辑器 8、原工作台 9 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 31 项通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过 |
| 前端生产构建／隔离原生构建 | 通过，25 个前端资源 |
| Windows WebView2 原生验收 | 7 组全部通过 |
| `npm run package` | 通过，正式标识 Windows x64 程序与 NSIS 安装包 |

浏览器及四张原生截图已目视检查：笔记插入线与文件夹移入边框可区分，文件夹仍在笔记组之前，移动后的双窗格路径和部分成功重试信息可见。

一轮沙箱内界面回归在全部 52 条用例输出成功后，停在测试子进程清理阶段，该进程已中止，没有据此判断套件完成。随后以允许正常管理 Edge／Vite 子进程的环境重新执行，52 项全部通过并以状态 0 退出。

## 原生结果

[原始报告](../../../docs/verification/raw/note-moves-native.json)包含 7 组检查、测试目录、文件内容哈希、程序哈希及 25 个资源哈希：

1. 文件夹与笔记独立排序，插入线可见，保存顺序不改变文件字节。
2. 单篇 Markdown 真实移动，双窗格历史保留，后续保存分别使用正确路径，保留 BOM／CRLF。
3. 移入、移回根目录及跨父目录笔记锚点插入，退出重启恢复顺序与两个窗格路径。
4. 取消不改变磁盘；确认期间出现真实同名文件时拒绝覆盖两份内容。
5. 外部保存冲突阻止移动，保留本地未保存缓冲，明确重新载入后恢复使用。
6. 两份真实笔记库排序隔离，拒绝失效笔记锚点、不同类型的锚点和非 Markdown 来源。
7. 只读偏好文件阻止纯排序；磁盘移动成功后保留新路径，解除只读后重试保存顺序成功。

首次原生脚本对冲突文案只接受“同名”，而 Windows 正确返回“文件已存在（os error 183）”，导致测试断言中断。现同时接受两种实际错误表达，保留原始文件字节断言，完整重跑 7 组通过；无需修改应用代码。

截图：[插入线](../../../docs/verification/note-native-insert.png)、[移入目录](../../../docs/verification/note-native-inside.png)、[移动后双窗格](../../../docs/verification/note-native-split.png)、[偏好保存失败与重试](../../../docs/verification/note-native-partial.png)。

隔离验收程序保留在 `src-tauri/target/note-moves/qa/shiye.exe`，SHA-256 为 `61ec3b92d3ce60f8cc275f824507bab39047854c88ad6198a3b768eb40d0356b`。正式构建的 25 个前端资源与原生验收逐文件哈希相同；应用标识及打包标记不同，因此不称为直接测试交付二进制。

复现命令：

```powershell
$env:CARGO_TARGET_DIR='D:\lxWorkspace\src-tauri\target\note-moves'
$env:CARGO_NET_OFFLINE='true'
npm run tauri -- build --no-bundle --config D:\lxWorkspace\scripts\note-native-config.json
# 将隔离程序保留到同目标目录的 qa/shiye.exe 后执行：
node scripts/note-moves-native-smoke.mjs src-tauri/target/note-moves/qa/shiye.exe
npm run package
```

## 验收边界

Windows 原生验收使用 `scripts/note-native-config.json` 的隔离标识 `local.shiye.workbench.noteqa`，同源码和前端资源，独立 `.qa/` 测试笔记库；用户正在运行的正式程序保持不动。程序操作通过 WebView2 CDP 和真实 Tauri IPC 验证，不称为物理鼠标／键盘手工验收。

单篇笔记移动只移动 `.md` 文件，附件保留原处；相对链接和图片引用不会自动改写。此次不重新执行首版延期的完整性能、DPI 和安装／升级／卸载兼容性验收，也不改变历史记录的结论。

## 最终交付

正式标识为 `local.shiye.workbench`，程序确认不含 QA 标识，NSIS 构建成功。两份产物从独立 `src-tauri/target/note-moves/release/` 输出；[原始交付记录](../../../docs/verification/raw/note-moves-delivery.json)含路径、大小、SHA-256 及 25 个匹配原生验收的资源哈希。

| 产物 | 大小 / bytes | SHA-256 |
| --- | ---: | --- |
| `shiye.exe` | 6,332,928 | `9bffea640ac5e756e467f897a18c3b9748d758c83a9ec17ffb4a9ee02dc607be` |
| `bundle/nsis/拾页_0.1.0_x64-setup.exe` | 2,177,031 | `509d840bebfe31b09edea1dc628e4a26b5af48d515ebecb52c0a098c18fdda5d` |

旧文件夹版程序与其历史验收文件保留。所有实施任务已完成，正式规格待依赖顺序归档时合并。
