use crate::{
    app,
    files::{Fault, Result},
    settings::AppState,
};
use serde::Serialize;
use std::{
    ptr::{null, null_mut},
    sync::{
        atomic::{AtomicBool, AtomicIsize, Ordering},
        Mutex, OnceLock,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::Gdi::*,
    System::{DataExchange::*, LibraryLoader::*, Memory::*},
    UI::{HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};
static APP: OnceLock<AppHandle> = OnceLock::new();
static WINDOW: AtomicIsize = AtomicIsize::new(0);
static WATCHING: AtomicBool = AtomicBool::new(false);
struct Drag {
    down: bool,
    moved: bool,
    start: POINT,
    origin: POINT,
}
static DRAG: Mutex<Drag> = Mutex::new(Drag {
    down: false,
    moved: false,
    start: POINT { x: 0, y: 0 },
    origin: POINT { x: 0, y: 0 },
});
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
fn hwnd() -> HWND {
    WINDOW.load(Ordering::SeqCst) as HWND
}
fn size() -> i32 {
    unsafe {
        let dpi = if hwnd().is_null() {
            GetDpiForSystem()
        } else {
            GetDpiForWindow(hwnd())
        };
        (52 * dpi.max(96) / 96) as i32
    }
}
pub fn clamp(x: i32, y: i32, width: i32, height: i32) -> [i32; 4] {
    unsafe {
        let monitor = MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..std::mem::zeroed()
        };
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return [x, y, width, height];
        }
        let r = info.rcWork;
        let width = width.min(r.right - r.left).max(1);
        let height = height.min(r.bottom - r.top).max(1);
        [
            x.clamp(r.left, r.right - width),
            y.clamp(r.top, r.bottom - height),
            width,
            height,
        ]
    }
}
unsafe extern "system" fn procedure(window: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_MOUSEACTIVATE => MA_NOACTIVATE as isize,
        WM_LBUTTONDOWN => {
            let mut cursor = POINT { x: 0, y: 0 };
            GetCursorPos(&mut cursor);
            let mut rect = std::mem::zeroed();
            GetWindowRect(window, &mut rect);
            *DRAG.lock().unwrap() = Drag {
                down: true,
                moved: false,
                start: cursor,
                origin: POINT {
                    x: rect.left,
                    y: rect.top,
                },
            };
            SetCapture(window);
            0
        }
        WM_MOUSEMOVE => {
            let mut drag = DRAG.lock().unwrap();
            if drag.down {
                let mut p = POINT { x: 0, y: 0 };
                GetCursorPos(&mut p);
                let dx = p.x - drag.start.x;
                let dy = p.y - drag.start.y;
                if dx.abs() + dy.abs() > 4 {
                    drag.moved = true;
                }
                if drag.moved {
                    let [x, y, w, h] =
                        clamp(drag.origin.x + dx, drag.origin.y + dy, size(), size());
                    SetWindowPos(window, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE);
                }
            }
            0
        }
        WM_LBUTTONUP => {
            let (down, moved) = {
                let mut drag = DRAG.lock().unwrap();
                let result = (drag.down, drag.moved);
                drag.down = false;
                result
            };
            ReleaseCapture();
            if down {
                if moved {
                    let mut rect = std::mem::zeroed();
                    GetWindowRect(window, &mut rect);
                    if let Some(app) = APP.get() {
                        let _ = app.state::<AppState>().change(|s| {
                            s.float_x = rect.left;
                            s.float_y = rect.top;
                        });
                    }
                } else if let Some(handle) = APP.get() {
                    app::show(handle);
                }
            }
            0
        }
        WM_CAPTURECHANGED => {
            DRAG.lock().unwrap().down = false;
            0
        }
        WM_DISPLAYCHANGE | WM_DPICHANGED => {
            let mut rect = std::mem::zeroed();
            GetWindowRect(window, &mut rect);
            let [x, y, w, h] = clamp(rect.left, rect.top, size(), size());
            SetWindowPos(window, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE);
            SetWindowRgn(window, CreateRoundRectRgn(0, 0, w + 1, h + 1, 16, 16), 1);
            0
        }
        WM_CLIPBOARDUPDATE => {
            if WATCHING.load(Ordering::SeqCst) {
                if let Some(app) = APP.get() {
                    let _ = app.emit_to("main", "clipboard-changed", ());
                }
            }
            0
        }
        WM_PAINT => {
            let mut ps = std::mem::zeroed();
            let dc = BeginPaint(window, &mut ps);
            let brush = CreateSolidBrush(0x003c5129);
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: size(),
                bottom: size(),
            };
            FillRect(dc, &rect, brush);
            DeleteObject(brush);
            SetBkMode(dc, TRANSPARENT as i32);
            SetTextColor(dc, 0x00f4f3e8);
            let text = wide("拾");
            DrawTextW(
                dc,
                text.as_ptr(),
                1,
                &mut rect,
                DT_CENTER | DT_VCENTER | DT_SINGLELINE,
            );
            EndPaint(window, &ps);
            0
        }
        _ => DefWindowProcW(window, msg, wp, lp),
    }
}
pub fn create(handle: AppHandle) {
    let config = handle.state::<AppState>().get();
    let _ = APP.set(handle);
    unsafe {
        let name = wide("ShiyeFloat");
        let instance = GetModuleHandleW(null());
        let class = WNDCLASSW {
            lpfnWndProc: Some(procedure),
            hInstance: instance,
            lpszClassName: name.as_ptr(),
            hCursor: LoadCursorW(null_mut(), IDC_HAND),
            ..std::mem::zeroed()
        };
        RegisterClassW(&class);
        let [x, y, w, h] = clamp(config.float_x, config.float_y, size(), size());
        let window = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            name.as_ptr(),
            wide("拾页悬浮入口").as_ptr(),
            WS_POPUP,
            x,
            y,
            w,
            h,
            null_mut(),
            null_mut(),
            instance,
            null(),
        );
        WINDOW.store(window as isize, Ordering::SeqCst);
        if !window.is_null() {
            SetWindowRgn(window, CreateRoundRectRgn(0, 0, w + 1, h + 1, 16, 16), 1);
        }
        visible(config.floating);
    }
}
pub fn visible(value: bool) {
    unsafe {
        if !hwnd().is_null() {
            ShowWindow(hwnd(), if value { SW_SHOWNOACTIVATE } else { SW_HIDE });
        }
    }
}
pub fn watch(enabled: bool) -> Result<()> {
    if WATCHING.load(Ordering::SeqCst) == enabled {
        return Ok(());
    }
    unsafe {
        if hwnd().is_null() {
            return Err(Fault::new("clipboard", "剪贴板监听窗口不可用。"));
        }
        let ok = if enabled {
            AddClipboardFormatListener(hwnd())
        } else {
            RemoveClipboardFormatListener(hwnd())
        };
        if ok == 0 {
            return Err(Fault::new("clipboard", "无法更新剪贴板监听状态。"));
        }
    }
    WATCHING.store(enabled, Ordering::SeqCst);
    Ok(())
}
#[derive(Serialize)]
pub struct Clipboard {
    pub status: String,
    pub text: String,
    pub truncated: bool,
}
pub fn clipboard() -> Result<Clipboard> {
    unsafe {
        if IsClipboardFormatAvailable(13) == 0 {
            return Ok(Clipboard {
                status: if CountClipboardFormats() == 0 {
                    "empty"
                } else {
                    "unsupported"
                }
                .into(),
                text: String::new(),
                truncated: false,
            });
        }
        if OpenClipboard(null_mut()) == 0 {
            return Err(Fault::new(
                "clipboard",
                "剪贴板暂时被其他应用占用，请稍后刷新。",
            ));
        }
        struct Close;
        impl Drop for Close {
            fn drop(&mut self) {
                unsafe {
                    CloseClipboard();
                }
            }
        }
        let _close = Close;
        let data = GetClipboardData(13);
        if data.is_null() {
            return Err(Fault::new("clipboard", "无法读取剪贴板文本。"));
        }
        let count = GlobalSize(data) / 2;
        let ptr = GlobalLock(data) as *const u16;
        if ptr.is_null() {
            return Err(Fault::new("clipboard", "无法读取剪贴板文本。"));
        }
        struct Unlock(HGLOBAL);
        impl Drop for Unlock {
            fn drop(&mut self) {
                unsafe {
                    GlobalUnlock(self.0);
                }
            }
        }
        let _unlock = Unlock(data);
        const LIMIT: usize = 1024 * 1024;
        let units = std::slice::from_raw_parts(ptr, count.min(LIMIT + 2));
        let terminated = units.contains(&0);
        let mut text = String::with_capacity(4096);
        let mut truncated = !terminated && count > units.len();
        for c in char::decode_utf16(units.iter().copied().take_while(|c| *c != 0)) {
            let c = c.unwrap_or(char::REPLACEMENT_CHARACTER);
            if text.len() + c.len_utf8() > LIMIT {
                truncated = true;
                break;
            }
            text.push(c);
        }
        Ok(Clipboard {
            status: if text.is_empty() { "empty" } else { "text" }.into(),
            text,
            truncated,
        })
    }
}
