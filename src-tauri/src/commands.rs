use crate::{
    app,
    autostart::{Autostart, Change, Status},
    files::{Entry, Fault, Note, Result},
    folder_order::{FolderAction, FolderOrder, FolderResult, FolderStore},
    native,
    settings::{AppState, Settings, Snapshot},
    startup::PendingFiles,
    text_files::{self, TextFile, TextSave},
    text_session::{ProfileTextStatus, TextCommit, TextOpenResult, TextReadReply, TextSnapshot},
};
use std::sync::Mutex;
use tauri::{Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    state.get()
}
#[tauri::command]
pub fn get_autostart_status(autostart: State<Autostart>) -> Status {
    autostart.status()
}
#[tauri::command]
pub async fn set_workspace(root: String, state: State<'_, AppState>) -> Result<Settings> {
    let _guard = state.io.lock().unwrap();
    let ws = crate::files::Workspace::new(std::path::Path::new(&root))?;
    let root = ws
        .root
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_string();
    let settings = state.change(|s| {
        s.root = Some(root);
        s.session = Snapshot::default();
    })?;
    state.folders.lock().unwrap().clear();
    state.text.lock().unwrap().clear_notes();
    Ok(settings)
}
#[tauri::command]
pub async fn list_entries(parent: String, state: State<'_, AppState>) -> Result<Vec<Entry>> {
    let _g = state.io.lock().unwrap();
    let ws = state.workspace()?;
    let entries = ws.list(&parent)?;
    let canonical_parent = ws.rel(&ws.resolve(&parent)?);
    state
        .folders
        .lock()
        .unwrap()
        .listed(&ws, &state.data, &canonical_parent, &entries);
    Ok(entries)
}
#[tauri::command]
pub async fn folder_order(state: State<'_, AppState>) -> Result<FolderOrder> {
    let _g = state.io.lock().unwrap();
    let ws = state.workspace()?;
    Ok(state.folders.lock().unwrap().snapshot(&ws, &state.data))
}
#[tauri::command]
pub async fn arrange_folder(
    action: FolderAction,
    state: State<'_, AppState>,
) -> Result<FolderResult> {
    let _g = state.io.lock().unwrap();
    let ws = state.workspace()?;
    let mut moved_source = None;
    if !matches!(action.placement, crate::folder_order::Placement::Reset) {
        let full = ws.resolve(&action.source)?;
        let destination = ws.resolve(&action.parent)?;
        // Same-parent ordering is metadata only. Only actual disk moves are blocked.
        if full.parent() != Some(destination.as_path()) {
            state.text.lock().unwrap().protect(&full)?;
            moved_source = Some(full);
        }
    }
    let result = state
        .folders
        .lock()
        .unwrap()
        .arrange(&ws, &state.data, action)?;
    if result.moved {
        if let Some(source) = moved_source {
            state
                .text
                .lock()
                .unwrap()
                .notes_moved(&source, &ws.resolve(&result.path)?, &ws.root);
        }
    }
    Ok(result)
}
#[tauri::command]
pub async fn retry_folder_order(root: String, state: State<'_, AppState>) -> Result<FolderOrder> {
    let _g = state.io.lock().unwrap();
    let ws = state.workspace()?;
    FolderStore::check_root(&ws, &root)?;
    state.folders.lock().unwrap().retry(&ws, &state.data, &root)
}
#[tauri::command]
pub async fn read_note(
    path: String,
    allow_large: bool,
    state: State<'_, AppState>,
) -> Result<Note> {
    let _g = state.io.lock().unwrap();
    let ws = state.workspace()?;
    let full = ws.resolve(&path)?;
    if state.text.lock().unwrap().note_owner(&full)?.is_some() {
        return Err(Fault::new(
            "text-owned",
            "该文件已在文本编辑中打开，请切换到已有标签。",
        ));
    }
    let note = ws.read(&path, allow_large)?;
    state
        .text
        .lock()
        .unwrap()
        .remember_note(full, note.path.clone())?;
    Ok(note)
}
#[tauri::command]
pub async fn save_note(
    path: String,
    text: String,
    version: String,
    state: State<'_, AppState>,
) -> Result<String> {
    let _g = state.io.lock().unwrap();
    let ws = state.workspace()?;
    let full = ws.resolve(&path)?;
    if state.text.lock().unwrap().note_owner(&full)?.is_some() {
        return Err(Fault::new("text-owned", "该文件已由文本编辑会话占用。"));
    }
    let version = ws.save(&path, &text, &version)?;
    state.text.lock().unwrap().note_saved(&full);
    Ok(version)
}
#[tauri::command]
pub async fn create_entry(
    parent: String,
    name: String,
    folder: bool,
    state: State<'_, AppState>,
) -> Result<String> {
    let _g = state.io.lock().unwrap();
    state.workspace()?.create(&parent, &name, folder)
}

/// 文件选择期间释放文件锁，提交前再次确认笔记库与目标目录。
#[tauri::command]
pub async fn import_markdown(
    parent: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>> {
    let (workspace_root, destination) = {
        let _guard = state.io.lock().unwrap();
        let workspace = state.workspace()?;
        let destination = workspace.resolve(&parent)?;
        if !destination.is_dir() {
            return Err(Fault::new("directory", "请选择笔记文件夹。"));
        }
        (workspace.root, destination)
    };
    let mut dialog = app
        .dialog()
        .file()
        .set_title("导入 Markdown")
        .add_filter("Markdown", &["md"]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let Some(selected) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    let source = selected
        .into_path()
        .map_err(|error| Fault::new("authorization", error.to_string()))?;

    let _guard = state.io.lock().unwrap();
    let workspace = state.workspace()?;
    if workspace.root != workspace_root || workspace.resolve(&parent)? != destination {
        return Err(Fault::new(
            "workspace",
            "笔记目录已改变，请重新选择文件导入。",
        ));
    }
    workspace.import_markdown(&parent, &source).map(Some)
}

#[tauri::command]
pub async fn rename_entry(
    path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<String> {
    let _g = state.io.lock().unwrap();
    let ws = state.workspace()?;
    let full = ws.resolve(&path)?;
    let old = ws.rel(&full);
    state.text.lock().unwrap().protect(&full)?;
    let mut folders = state.folders.lock().unwrap();
    folders.snapshot(&ws, &state.data);
    let result = ws.rename(&path, &name)?;
    state
        .text
        .lock()
        .unwrap()
        .notes_moved(&full, &ws.resolve(&result)?, &ws.root);
    folders.renamed(&ws, &state.data, &old, &result);
    Ok(result)
}
#[tauri::command]
pub async fn recycle_entry(path: String, state: State<'_, AppState>) -> Result<()> {
    let _g = state.io.lock().unwrap();
    let ws = state.workspace()?;
    let full = ws.resolve(&path)?;
    let canonical = ws.rel(&full);
    state.text.lock().unwrap().protect(&full)?;
    let mut folders = state.folders.lock().unwrap();
    folders.snapshot(&ws, &state.data);
    ws.recycle(&path)?;
    state.text.lock().unwrap().notes_recycled(&full);
    folders.recycled(&ws, &state.data, &canonical);
    Ok(())
}
#[tauri::command]
pub async fn read_image(path: String, state: State<'_, AppState>) -> Result<String> {
    let _g = state.io.lock().unwrap();
    state.workspace()?.image(&path)
}
#[tauri::command]
pub fn save_snapshot(snapshot: Snapshot, state: State<AppState>) -> Result<()> {
    if snapshot.panes.len() > 2
        || snapshot.expanded.len() > 300
        || serde_json::to_vec(&snapshot).unwrap_or_default().len() > 32768
    {
        return Err(Fault::new("config", "恢复记录过大。"));
    }
    state.change(|s| s.session = snapshot)?;
    Ok(())
}
#[tauri::command]
pub fn update_settings(
    shortcut: String,
    floating: bool,
    autostart: Option<Change>,
    app: tauri::AppHandle,
    state: State<AppState>,
    registration: State<Autostart>,
) -> Result<Settings> {
    let _configuration = state.configuration.lock().unwrap();
    let previous = state.get();
    let changed_shortcut = shortcut != previous.shortcut;
    let previous_was_registered = app
        .global_shortcut()
        .is_registered(previous.shortcut.as_str());
    if changed_shortcut {
        app.global_shortcut()
            .register(shortcut.as_str())
            .map_err(|e| Fault::new("shortcut", format!("快捷键不可用：{e}")))?;
    }
    let mut old_shortcut_removed = false;
    let result = registration.update(autostart.as_ref(), || {
        if changed_shortcut && previous_was_registered {
            app.global_shortcut()
                .unregister(previous.shortcut.as_str())
                .map_err(|e| Fault::new("shortcut", format!("旧快捷键未能注销：{e}")))?;
            old_shortcut_removed = true;
        }
        state.change(|s| {
            s.shortcut = shortcut.clone();
            s.floating = floating;
            if changed_shortcut {
                s.startup_error = state.config_warning.clone();
            }
        })
    });
    if let Err(mut fault) = result {
        let mut recovery_errors = Vec::new();
        if old_shortcut_removed {
            if let Err(e) = app.global_shortcut().register(previous.shortcut.as_str()) {
                recovery_errors.push(format!("原快捷键未能恢复：{e}"));
            }
        }
        if changed_shortcut {
            if let Err(e) = app.global_shortcut().unregister(shortcut.as_str()) {
                recovery_errors.push(format!("新快捷键未能撤销：{e}"));
            }
        }
        if !recovery_errors.is_empty() {
            fault.code = "settings_partial".into();
            fault.message.push_str(&format!(
                " 部分快捷键变更未恢复：{}",
                recovery_errors.join("；")
            ));
            state.settings.lock().unwrap().startup_error = Some(fault.message.clone());
        }
        return Err(fault);
    }
    native::visible(floating);
    result
}
#[tauri::command]
pub fn hide_window(app: tauri::AppHandle) -> Result<()> {
    app::hide(&app)
}
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let _io = state.io.lock().unwrap();
    let text = state.text.lock().unwrap();
    text.lifecycle_ready()?;
    let _ = native::watch(false);
    app.exit(0);
    Ok(())
}
#[tauri::command]
pub fn read_clipboard() -> Result<native::Clipboard> {
    native::clipboard()
}
#[tauri::command]
pub fn watch_clipboard(enabled: bool) -> Result<()> {
    native::watch(enabled)
}
#[tauri::command]
pub fn open_external(url: String) -> Result<()> {
    let parsed = tauri::Url::parse(&url).map_err(|_| Fault::new("url", "链接无效。"))?;
    if !["http", "https"].contains(&parsed.scheme()) || parsed.host_str().is_none() {
        return Err(Fault::new("url", "只能在浏览器中打开 HTTP 或 HTTPS 链接。"));
    }
    open::that_detached(url).map_err(|e| Fault::new("browser", e.to_string()))
}
#[tauri::command]
pub fn frontend_ready(app: tauri::AppHandle, pending: State<Mutex<PendingFiles>>) -> bool {
    use std::io::Write;
    let state = app.state::<AppState>();
    let wake = state.wake.lock().unwrap().take();
    if let Some((start, cold)) = wake {
        if state.profile {
            let sample =
                serde_json::json!({"cold":cold,"elapsedMs":start.elapsed().as_secs_f64()*1000.0});
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(state.data.join("wake.jsonl"))
            {
                let _ = writeln!(file, "{sample}");
            }
        }
    }
    !pending.lock().unwrap().paths.is_empty()
}
/// Profiling-only fast-forward of the idle timer; never destroys a visible editor.
#[tauri::command]
pub fn profile_unload(app: tauri::AppHandle) -> Result<()> {
    if !app.state::<AppState>().profile {
        return Err(Fault::new("profile", "性能采样未启用。"));
    }
    let state = app.state::<AppState>();
    let _io = state.io.lock().unwrap();
    let text = state.text.lock().unwrap();
    text.lifecycle_ready()?;
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(true) {
            return Err(Fault::new("profile", "请先保存并隐藏主窗口。"));
        }
        window
            .destroy()
            .map_err(|e| Fault::new("window", e.to_string()))?;
    }
    Ok(())
}

/// Dialogs run on Tauri's blocking command pool; the shared disk mutex is acquired
/// only after the selection/confirmation, never while the UI waits for the dialog.
#[tauri::command]
pub async fn text_open(
    encoding: Option<text_files::Encoding>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<TextOpenResult> {
    let queued = state.text_selection.lock().unwrap().open.take();
    if let Some(paths) = queued {
        profile_text_root(&state)?;
        let _io = state.io.lock().unwrap();
        let mut result = TextOpenResult::default();
        for path in paths {
            let path = profile_text_path(&state, &path.to_string_lossy(), true)?;
            match state
                .text
                .lock()
                .unwrap()
                .open_selected_with_encoding(&path, encoding)
            {
                Ok(Ok(file)) => result.files.push(file),
                Ok(Err(note)) => result.notes.push(note),
                Err(error) => {
                    let stop = matches!(error.code.as_str(), "text-tabs" | "text-quota");
                    result.errors.push(error);
                    if stop {
                        break;
                    }
                }
            }
        }
        return Ok(result);
    }
    let mut dialog = app.dialog().file().set_title("打开文本或代码文件");
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let paths = dialog.blocking_pick_files();
    let Some(paths) = paths else {
        return Ok(TextOpenResult::default());
    };
    open_text_paths(
        paths.into_iter().map(|selected| {
            selected
                .into_path()
                .map_err(|error| Fault::new("authorization", error.to_string()))
        }),
        encoding,
        &app,
        &state,
    )
}

#[tauri::command]
pub async fn text_open_dropped(
    token: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<TextOpenResult> {
    let paths = state.text_drops.lock().unwrap().take(&token)?;
    open_text_paths(paths.into_iter().map(Ok), None, &app, &state)
}

#[tauri::command]
pub async fn text_open_launch(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    pending: State<'_, Mutex<PendingFiles>>,
) -> Result<TextOpenResult> {
    let batch = std::mem::take(&mut *pending.lock().unwrap());
    let mut result = open_text_paths(batch.paths.into_iter().map(Ok), None, &app, &state)?;
    if batch.overflow {
        result.errors.push(Fault::new(
            "text-tabs",
            "一次最多接收 12 个文件，其余文件请稍后打开。",
        ));
    }
    Ok(result)
}

/// 文件选择、原生拖放和系统打开方式共用校验、较大文件确认和会话授权流程。
fn open_text_paths(
    paths: impl IntoIterator<Item = Result<std::path::PathBuf>>,
    encoding: Option<text_files::Encoding>,
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<TextOpenResult> {
    let mut result = TextOpenResult::default();
    for selected in paths {
        let path = match selected {
            Ok(path) => path,
            Err(error) => {
                result.errors.push(error);
                continue;
            }
        };
        let large = std::fs::metadata(&path)
            .map(|meta| {
                meta.len() > text_files::LARGE_FILE && meta.len() <= text_files::FILE_LIMIT as u64
            })
            .unwrap_or(false);
        if large
            && !app
                .dialog()
                .message(format!(
                    "{} 超过 2 MiB，继续打开可能占用较多内存。是否继续？",
                    text_files::display_path(&path)
                ))
                .title("打开较大文本")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::YesNo)
                .blocking_show()
        {
            continue;
        }
        let _io = state.io.lock().unwrap();
        match state
            .text
            .lock()
            .unwrap()
            .open_selected_with_encoding(&path, encoding)
        {
            Ok(Ok(file)) => result.files.push(file),
            Ok(Err(note)) => result.notes.push(note),
            Err(error) => {
                let stop = matches!(error.code.as_str(), "text-tabs" | "text-quota");
                result.errors.push(error);
                if stop {
                    break;
                }
            }
        }
    }
    Ok(result)
}
#[tauri::command]
pub async fn text_read(
    id: String,
    known_version: Option<String>,
    encoding: Option<text_files::Encoding>,
    state: State<'_, AppState>,
) -> Result<TextReadReply> {
    let _io = state.io.lock().unwrap();
    let mut store = state.text.lock().unwrap();
    if let Some(encoding) = encoding {
        if known_version.is_some() {
            return Err(Fault::new(
                "encoding",
                "指定编码重载不能与版本探测同时执行。",
            ));
        }
        store.reopen(&id, encoding).map(TextReadReply::Full)
    } else {
        store.read_reply(&id, known_version.as_deref())
    }
}
#[tauri::command]
pub async fn text_save(value: TextSave, state: State<'_, AppState>) -> Result<TextFile> {
    let _io = state.io.lock().unwrap();
    state.text.lock().unwrap().save(value)
}
#[tauri::command]
pub async fn text_save_as(
    value: TextSave,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<TextFile>> {
    let queued = state.text_selection.lock().unwrap().save.take();
    if let Some(selection) = queued {
        profile_text_root(&state)?;
        let Some(path) = selection.path else {
            return Ok(None);
        };
        let path = profile_text_path(
            &state,
            &path.to_string_lossy(),
            selection.baseline.is_some(),
        )?;
        let _io = state.io.lock().unwrap();
        return state
            .text
            .lock()
            .unwrap()
            .save_selected(value, &path, selection.baseline)
            .map(Some);
    }
    let selected = app
        .dialog()
        .file()
        .set_title("文本另存为")
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|e| Fault::new("authorization", e.to_string()))?;
    let baseline = if path.exists() {
        let (bytes, identity) = text_files::read_bytes(&path, None)?;
        let baseline = (identity, crate::files::version(&bytes));
        if !app
            .dialog()
            .message(format!(
                "确认覆盖 {}？提交前仍会检查文件是否变化。",
                text_files::display_path(&path)
            ))
            .title("确认覆盖文本")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNo)
            .blocking_show()
        {
            return Ok(None);
        }
        Some(baseline)
    } else {
        None
    };
    let _io = state.io.lock().unwrap();
    state
        .text
        .lock()
        .unwrap()
        .save_selected(value, &path, baseline)
        .map(Some)
}
#[tauri::command]
pub async fn text_restore(state: State<'_, AppState>) -> Result<TextSnapshot> {
    let _io = state.io.lock().unwrap();
    state.text.lock().unwrap().restore()
}
#[tauri::command]
pub async fn text_recover(id: String, state: State<'_, AppState>) -> Result<String> {
    let _io = state.io.lock().unwrap();
    state.text.lock().unwrap().recover(&id)
}
#[tauri::command]
pub async fn text_checkpoint(
    value: TextSnapshot,
    state: State<'_, AppState>,
) -> Result<TextCommit> {
    let _io = state.io.lock().unwrap();
    state.text.lock().unwrap().checkpoint(value)
}
#[tauri::command]
pub async fn text_invalidate(generation: u64, state: State<'_, AppState>) -> Result<()> {
    state.text.lock().unwrap().invalidate(generation);
    Ok(())
}
#[tauri::command]
pub async fn text_close(id: String, state: State<'_, AppState>) -> Result<()> {
    let _io = state.io.lock().unwrap();
    state.text.lock().unwrap().close(&id)
}
#[tauri::command]
pub async fn text_notes(paths: Vec<String>, state: State<'_, AppState>) -> Result<()> {
    let _io = state.io.lock().unwrap();
    if paths.is_empty() {
        state.text.lock().unwrap().clear_notes();
        return Ok(());
    }
    let ws = state.workspace()?;
    let mut canonical = Vec::new();
    for path in paths {
        let full = ws.resolve(&path)?;
        let relative = ws.rel(&full);
        canonical.push((full, relative));
    }
    state.text.lock().unwrap().sync_notes(canonical)
}
#[tauri::command]
pub async fn text_note_owner(path: String, state: State<'_, AppState>) -> Result<Option<String>> {
    let _io = state.io.lock().unwrap();
    let full = state.workspace()?.resolve(&path)?;
    state.text.lock().unwrap().note_owner(&full)
}

fn profile_text_root(state: &AppState) -> Result<std::path::PathBuf> {
    if !state.profile {
        return Err(Fault::new("profile", "性能采样未启用。"));
    }
    let root = std::env::var_os("SHIYE_TEXT_TEST_ROOT")
        .ok_or_else(|| Fault::new("profile", "未指定独立文本测试目录。"))?;
    let root = std::fs::canonicalize(root)?;
    if !root.is_dir() {
        return Err(Fault::new("profile", "文本测试根必须是已存在的独立目录。"));
    }
    Ok(root)
}
fn profile_text_path(state: &AppState, path: &str, existing: bool) -> Result<std::path::PathBuf> {
    let root = profile_text_root(state)?;
    let path = text_files::ordinary_path(std::path::Path::new(path), existing)?;
    if !path.starts_with(&root) || path == root {
        return Err(Fault::new(
            "profile",
            "测试文件必须位于 SHIYE_TEXT_TEST_ROOT 内。",
        ));
    }
    Ok(path)
}
/// QA-only fixture selection; both environment gates are required in release builds too.
#[tauri::command]
pub async fn profile_text_open(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<TextOpenResult> {
    profile_text_root(&state)?;
    let _io = state.io.lock().unwrap();
    let mut result = TextOpenResult::default();
    for path in paths {
        let path = profile_text_path(&state, &path, true)?;
        match state.text.lock().unwrap().open_selected(&path) {
            Ok(Ok(file)) => result.files.push(file),
            Ok(Err(note)) => result.notes.push(note),
            Err(error) => {
                let stop = matches!(error.code.as_str(), "text-tabs" | "text-quota");
                result.errors.push(error);
                if stop {
                    break;
                }
            }
        }
    }
    Ok(result)
}
#[tauri::command]
pub async fn profile_text_save_as(
    value: TextSave,
    path: String,
    overwrite: bool,
    state: State<'_, AppState>,
) -> Result<TextFile> {
    let path = profile_text_path(&state, &path, std::path::Path::new(&path).exists())?;
    let _io = state.io.lock().unwrap();
    let baseline = if path.exists() {
        if !overwrite {
            return Err(Fault::new("exists", "测试目标已存在且未明确选择覆盖。"));
        }
        let (bytes, identity) = text_files::read_bytes(&path, None)?;
        Some((identity, crate::files::version(&bytes)))
    } else {
        None
    };
    state
        .text
        .lock()
        .unwrap()
        .save_selected(value, &path, baseline)
}
#[tauri::command]
pub async fn profile_text_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ProfileTextStatus> {
    profile_text_root(&state)?;
    let mut status = state.text.lock().unwrap().profile_status()?;
    status.window_visible = app
        .get_webview_window("main")
        .map(|window| window.is_visible().unwrap_or(false));
    status.idle_pending = state.idle.lock().unwrap().is_some();
    Ok(status)
}
#[tauri::command]
pub async fn profile_text_queue_open(paths: Vec<String>, state: State<'_, AppState>) -> Result<()> {
    profile_text_root(&state)?;
    if paths.len() > 100 {
        return Err(Fault::new("profile", "测试选取队列过大。"));
    }
    let mut selected = Vec::new();
    for path in paths {
        selected.push(profile_text_path(&state, &path, true)?);
    }
    state.text_selection.lock().unwrap().open = Some(selected);
    Ok(())
}
#[tauri::command]
pub async fn profile_text_queue_save(
    path: Option<String>,
    overwrite: bool,
    state: State<'_, AppState>,
) -> Result<()> {
    profile_text_root(&state)?;
    let path = path
        .map(|path| profile_text_path(&state, &path, std::path::Path::new(&path).exists()))
        .transpose()?;
    let baseline = if let Some(path) = path.as_ref().filter(|path| path.exists()) {
        if !overwrite {
            return Err(Fault::new("exists", "测试目标已存在且未明确选择覆盖。"));
        }
        let (bytes, identity) = text_files::read_bytes(path, None)?;
        Some((identity, crate::files::version(&bytes)))
    } else {
        None
    };
    state.text_selection.lock().unwrap().save =
        Some(crate::text_session::ProfileSaveSelection { path, baseline });
    Ok(())
}
