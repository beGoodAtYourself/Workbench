use crate::{
    autostart::Autostart,
    commands,
    files::{Fault, Result},
    native,
    settings::AppState,
    startup::{Launch, PendingFiles},
};
use std::{
    path::Path,
    sync::{atomic::Ordering, Mutex},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
pub fn show(app: &tauri::AppHandle) {
    // Win32 entry points can run inside WNDPROC. Creating the first WebView
    // there blocks synchronous single-instance IPC and WebView2 initialization.
    // Dispatch from a worker so even a main-thread native callback queues the task.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let target = handle.clone();
        if let Err(error) = handle.run_on_main_thread(move || show_now(&target)) {
            eprintln!("Window activation dispatch failed: {error}");
        }
    });
}
fn show_now(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    state.epoch.fetch_add(1, Ordering::SeqCst);
    *state.idle.lock().unwrap() = None;
    state.idle_changed.notify_one();
    *state.wake.lock().unwrap() = Some((
        std::time::Instant::now(),
        app.get_webview_window("main").is_none(),
    ));
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("restored", ());
        return;
    }
    let state = app.state::<AppState>();
    let config = state.get();
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("拾页 · 个人工作台")
        .inner_size(1180., 780.)
        .min_inner_size(780., 500.)
        .data_directory(state.data.join("webview"));
    match builder.build() {
        Ok(window) => {
            if let Some([x, y, w, h]) = config.window {
                let [x, y, w, h] = native::clamp(x, y, w, h);
                let _ = window.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
                let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            }
            let drop_handle = app.clone();
            // 主窗口内容的原生拖放由窗口事件派发，WebView 事件仅用于子 WebView。
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::DragDrop(event) = event {
                    match event {
                        tauri::DragDropEvent::Enter { .. } => {
                            let _ = drop_handle.emit_to("main", "text-file-hover", true);
                        }
                        tauri::DragDropEvent::Leave => {
                            let _ = drop_handle.emit_to("main", "text-file-hover", false);
                        }
                        tauri::DragDropEvent::Drop { paths, .. } => {
                            let _ = drop_handle.emit_to("main", "text-file-hover", false);
                            let state = drop_handle.state::<AppState>();
                            let offered = state.text_drops.lock().unwrap().offer(paths.clone());
                            match offered {
                                Ok(token) => {
                                    if drop_handle
                                        .emit_to("main", "text-files-dropped", &token)
                                        .is_err()
                                    {
                                        let _ = state.text_drops.lock().unwrap().take(&token);
                                    }
                                }
                                Err(error) => {
                                    let _ = drop_handle.emit_to("main", "text-drop-error", error);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            });
            let handle = app.clone();
            window.on_window_event(move |event| match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = handle.emit_to("main", "request-hide", ());
                }
                tauri::WindowEvent::Focused(true) => {
                    let _ = handle.emit_to("main", "refresh-files", ());
                }
                _ => {}
            });
        }
        Err(e) => {
            eprintln!("Window creation failed: {e}");
        }
    }
}
pub fn toggle(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
            let _ = window.emit("request-hide", ());
            return;
        }
    }
    show(app);
}
pub fn hide(app: &tauri::AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let _io = state.io.lock().unwrap();
    let text = state.text.lock().unwrap();
    text.lifecycle_ready()?;
    if let Some(window) = app.get_webview_window("main") {
        if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
            state.change(|s| {
                s.window = Some([
                    position.x,
                    position.y,
                    size.width as i32,
                    size.height as i32,
                ])
            })?;
        }
        native::watch(false)?;
        window
            .hide()
            .map_err(|e| Fault::new("window", e.to_string()))?;
    }
    state.epoch.fetch_add(1, Ordering::SeqCst);
    *state.idle.lock().unwrap() =
        Some(std::time::Instant::now() + std::time::Duration::from_secs(60));
    state.idle_changed.notify_one();
    Ok(())
}
fn idle_worker(handle: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        let state = handle.state::<AppState>();
        let mut deadline = state.idle.lock().unwrap();
        loop {
            match *deadline {
                None => deadline = state.idle_changed.wait(deadline).unwrap(),
                Some(time) => {
                    let remaining = time.saturating_duration_since(std::time::Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    deadline = state
                        .idle_changed
                        .wait_timeout(deadline, remaining)
                        .unwrap()
                        .0;
                }
            }
        }
        *deadline = None;
        let epoch = state.epoch.load(Ordering::SeqCst);
        drop(deadline);
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let state = app.state::<AppState>();
            let _io = state.io.lock().unwrap();
            if state.epoch.load(Ordering::SeqCst) != epoch {
                return;
            }
            let text = state.text.lock().unwrap();
            if let Err(error) = text.lifecycle_ready() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.emit("text-lifecycle-error", error);
                }
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                if !window.is_visible().unwrap_or(true) {
                    let _ = window.destroy();
                }
            }
        });
    });
}
fn tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "显示拾页", true, None::<&str>)?;
    let float_item = MenuItem::with_id(app, "float", "切换悬浮入口", true, None::<&str>)?;
    let exit_item = MenuItem::with_id(app, "exit", "退出拾页", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &float_item, &exit_item])?;
    TrayIconBuilder::new()
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/icon.png"
        ))?)
        .tooltip("拾页 · 本地工作台")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show(app),
            "float" => {
                let state = app.state::<AppState>();
                let value = !state.get().floating;
                if state.change(|s| s.floating = value).is_ok() {
                    native::visible(value);
                    let _ = app.emit("settings-changed", ());
                }
            }
            "exit" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.emit("request-exit", ());
                } else {
                    app.exit(0);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
pub fn run() {
    let mut pending = PendingFiles::default();
    let cwd = std::env::current_dir().unwrap_or_default();
    let show_on_start = pending.activate(Launch::parse(std::env::args_os(), &cwd));
    tauri::Builder::default()
        .manage(Mutex::new(pending))
        .plugin(tauri_plugin_single_instance::init(|app, arguments, cwd| {
            let launch = Launch::parse(arguments, Path::new(&cwd));
            let pending = app.state::<Mutex<PendingFiles>>();
            if pending.lock().unwrap().activate(launch) {
                show(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::get_autostart_status,
            commands::set_workspace,
            commands::list_entries,
            commands::folder_order,
            commands::arrange_folder,
            commands::retry_folder_order,
            commands::read_note,
            commands::save_note,
            commands::create_entry,
            commands::import_markdown,
            commands::rename_entry,
            commands::recycle_entry,
            commands::read_image,
            commands::save_snapshot,
            commands::update_settings,
            commands::hide_window,
            commands::exit_app,
            commands::read_clipboard,
            commands::watch_clipboard,
            commands::open_external,
            commands::frontend_ready,
            commands::profile_unload,
            commands::text_open,
            commands::text_open_dropped,
            commands::text_open_launch,
            commands::text_read,
            commands::text_save,
            commands::text_save_as,
            commands::text_restore,
            commands::text_recover,
            commands::text_checkpoint,
            commands::text_invalidate,
            commands::text_close,
            commands::text_notes,
            commands::text_note_owner,
            commands::profile_text_open,
            commands::profile_text_save_as,
            commands::profile_text_status,
            commands::profile_text_queue_open,
            commands::profile_text_queue_save
        ])
        .setup(move |app| {
            app.manage(Autostart::new(app.handle()));
            let state =
                AppState::load(app.handle()).map_err(|e| std::io::Error::other(e.message))?;
            let settings = state.get();
            app.manage(state);
            if let Err(e) = app.global_shortcut().register(settings.shortcut.as_str()) {
                let state = app.state::<AppState>();
                let mut current = state.settings.lock().unwrap();
                let message = format!("快捷键注册失败，请在设置中修改：{e}");
                current.startup_error = Some(match current.startup_error.take() {
                    Some(previous) => format!("{previous} {message}"),
                    None => message,
                });
            }
            native::create(app.handle().clone());
            idle_worker(app.handle().clone());
            tray(app.handle())?;
            if show_on_start {
                show(app.handle());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("无法启动拾页")
        .run(|_, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
