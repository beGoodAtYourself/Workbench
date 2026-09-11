use crate::{
    app,
    files::{Entry, Fault, Note, Result},
    native,
    settings::{AppState, Settings, Snapshot},
};
use tauri::{Manager, State};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    state.get()
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
    state.change(|s| {
        s.root = Some(root);
        s.session = Snapshot::default();
    })
}
#[tauri::command]
pub async fn list_entries(parent: String, state: State<'_, AppState>) -> Result<Vec<Entry>> {
    let _g = state.io.lock().unwrap();
    state.workspace()?.list(&parent)
}
#[tauri::command]
pub async fn read_note(
    path: String,
    allow_large: bool,
    state: State<'_, AppState>,
) -> Result<Note> {
    let _g = state.io.lock().unwrap();
    state.workspace()?.read(&path, allow_large)
}
#[tauri::command]
pub async fn save_note(
    path: String,
    text: String,
    version: String,
    state: State<'_, AppState>,
) -> Result<String> {
    let _g = state.io.lock().unwrap();
    state.workspace()?.save(&path, &text, &version)
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
#[tauri::command]
pub async fn rename_entry(
    path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<String> {
    let _g = state.io.lock().unwrap();
    state.workspace()?.rename(&path, &name)
}
#[tauri::command]
pub async fn recycle_entry(path: String, state: State<'_, AppState>) -> Result<()> {
    let _g = state.io.lock().unwrap();
    state.workspace()?.recycle(&path)
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
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<Settings> {
    let previous = state.get();
    if shortcut != previous.shortcut {
        app.global_shortcut()
            .register(shortcut.as_str())
            .map_err(|e| Fault::new("shortcut", format!("快捷键不可用：{e}")))?;
    }
    let result = state.change(|s| {
        s.shortcut = shortcut.clone();
        s.floating = floating;
    });
    if result.is_err() {
        if shortcut != previous.shortcut {
            let _ = app.global_shortcut().unregister(shortcut.as_str());
        }
        return result;
    }
    if shortcut != previous.shortcut {
        let _ = app.global_shortcut().unregister(previous.shortcut.as_str());
    }
    native::visible(floating);
    result
}
#[tauri::command]
pub fn hide_window(app: tauri::AppHandle) -> Result<()> {
    app::hide(&app)
}
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) {
    let _ = native::watch(false);
    app.exit(0);
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
pub fn frontend_ready(app: tauri::AppHandle) {
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
}
/// Profiling-only fast-forward of the idle timer; never destroys a visible editor.
#[tauri::command]
pub fn profile_unload(app: tauri::AppHandle) -> Result<()> {
    if !app.state::<AppState>().profile {
        return Err(Fault::new("profile", "性能采样未启用。"));
    }
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
