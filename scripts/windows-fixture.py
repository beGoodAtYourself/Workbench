"""Isolated Windows API fixtures for clipboard and shortcut integration tests.

No UI input is synthesized. A test starts the helper, waits for READY, then closes
stdin to release the owned clipboard lock/hotkey. Clipboard writes are explicit
test data and are never read into logs.
"""
import ctypes as c
from ctypes import wintypes as w
import sys

u = c.WinDLL('user32', use_last_error=True)
k = c.WinDLL('kernel32', use_last_error=True)
u.OpenClipboard.argtypes = [w.HWND]
u.GetClipboardData.argtypes = [w.UINT]
u.GetClipboardData.restype = w.HANDLE
u.SetClipboardData.argtypes = [w.UINT, w.HANDLE]
u.SetClipboardData.restype = w.HANDLE
k.GlobalAlloc.argtypes = [w.UINT, c.c_size_t]
k.GlobalAlloc.restype = w.HGLOBAL
k.GlobalLock.argtypes = [w.HGLOBAL]
k.GlobalLock.restype = c.c_void_p
k.GlobalUnlock.argtypes = [w.HGLOBAL]

mode = sys.argv[1]
if mode == 'hotkey':
    assert u.RegisterHotKey(None, 42, 0x4003, 0x7B), c.get_last_error()  # Ctrl+Alt+F12
    print('READY', flush=True)
    try: sys.stdin.read()
    finally: u.UnregisterHotKey(None, 42)
elif mode == 'busy':
    # A real owner HWND is needed; NULL ownership can be shared by NULL callers.
    u.CreateWindowExW.argtypes = [w.DWORD, w.LPCWSTR, w.LPCWSTR, w.DWORD, c.c_int, c.c_int, c.c_int, c.c_int, w.HWND, w.HMENU, w.HINSTANCE, c.c_void_p]
    u.CreateWindowExW.restype = w.HWND
    u.DestroyWindow.argtypes = [w.HWND]
    owner = u.CreateWindowExW(0, 'STATIC', 'Shiye QA clipboard lock', 0, 0, 0, 1, 1, w.HWND(-3), None, None, None)
    assert owner
    assert u.OpenClipboard(owner), c.get_last_error()
    print('READY', flush=True)
    try: sys.stdin.read()
    finally:
        u.CloseClipboard()
        u.DestroyWindow(owner)
else:
    assert u.OpenClipboard(None), c.get_last_error()
    try:
        assert u.EmptyClipboard()
        if mode != 'empty':
            if mode == 'nontext':
                u.RegisterClipboardFormatW.argtypes = [w.LPCWSTR]
                fmt = u.RegisterClipboardFormatW('Shiye-QA-NonText')
                payload = b'fixture\0'
            else:
                fmt = 13
                text = ('\u4e2d\U0001f4dd' * 300000) if mode == 'large' else '\u526a\u8d34\u677f\u9a8c\u6536 Shiye 2026'
                payload = (text + '\0').encode('utf-16-le')
            handle = k.GlobalAlloc(0x0002, len(payload))
            pointer = k.GlobalLock(handle)
            assert pointer
            c.memmove(pointer, payload, len(payload))
            k.GlobalUnlock(handle)
            assert u.SetClipboardData(fmt, handle)
    finally: u.CloseClipboard()
    print('READY', flush=True)
