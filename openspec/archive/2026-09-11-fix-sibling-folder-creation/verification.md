# 同级文件夹修复验证记录

**日期：** 2026-09-11（Asia/Singapore，UTC+08:00）
**Change ID：** `fix-sibling-folder-creation`

## 自动化检查

| 检查 | 结果与执行时点 |
| --- | --- |
| `npm run check` | 归档前复核通过 |
| `npm test` | 归档前复核通过：27 项，其中路径 14 项、会话与保存状态 13 项 |
| `npm run test:e2e` | 归档前复核通过：9 项，最后完整运行退出码 0；使用配置允许复用的本地 Vite 服务 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 归档前复核通过：9 项 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 归档前复核通过 |
| `npm run build` | 修复实施期间通过，包含 TypeScript 检查与 Vite 生产构建 |
| `npm run package` | 修复实施期间通过，15:48 生成 Windows x64 程序及 NSIS 安装包 |

构建后到归档期间未再次修改应用源代码、依赖或构建配置，因此归档沿用该发布构建结果。Vite 提示编辑器分块大于 500 kB，未导致构建失败。

新增三项浏览器用例验证：

1. 点击笔记库名称或树空白处返回根目录，连续创建三个顶层目录，清除旧选择并保留已打开笔记窗格。
2. 工具栏仍可创建子目录，右键菜单可在同一父目录下创建同级目录，也可在顶层创建同级目录。
3. 空白处右键新建以根目录为目标，重命名与回收站禁用，菜单不超出窗口下边界。

测试文件：`tests/e2e/workbench.spec.ts`。浏览器测试使用演示仓库；Rust 测试使用临时文件目录。本次没有对用户笔记执行测试写入。

## 发布产物

构建时设置 `CARGO_TARGET_DIR=D:\lxWorkspace\src-tauri\target\folder-fix`，以便保留运行中的旧版程序。

| 产物 | 仓库相对路径 | SHA-256 |
| --- | --- | --- |
| 修复版程序 | `src-tauri/target/folder-fix/release/shiye.exe` | `1b79153dc22839bd38306cc7d35b1e1628282e28d2c066cb1628beddba8d4c73` |
| NSIS 安装包 | `src-tauri/target/folder-fix/release/bundle/nsis/拾页_0.1.0_x64-setup.exe` | `bc1b8cdcd963d70b04f72504e17f27f5041507e950638dfa7147f39ebcbc6bf5` |

用户通过“设置 → 退出拾页”正常退出旧版，再启动修复版。构建产物遵循现有 `.gitignore`，不提交二进制文件。

## 验证边界

同级目录操作已通过浏览器交互回归，文件系统层已有测试复核通过；本次未新增原生 WebView 手工操作、安装／升级流程或性能验收。原首版的待验收项继续保留在 `docs/verification/deferred-tests.md`，不因本修复归档而标记完成。
