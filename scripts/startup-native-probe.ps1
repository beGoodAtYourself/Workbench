param(
    [ValidateSet('process', 'read', 'write', 'delete')][string]$Action = 'process',
    [int]$OwnerProcessId = 0,
    [string]$Value = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$qaValueName = 'local.shiye.workbench.startupqa'
$runPath = 'Software\Microsoft\Windows\CurrentVersion\Run'
if ($Action -ne 'process') {
    $registryKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runPath, $Action -ne 'read')
    try {
        if ($Action -eq 'read') {
            $qaValue = if ($registryKey) { $registryKey.GetValue($qaValueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
            $formalValue = if ($registryKey) { $registryKey.GetValue('local.shiye.workbench', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
            $qaKind = if ($null -ne $qaValue) { $registryKey.GetValueKind($qaValueName).ToString() } else { $null }
            $formalKind = if ($null -ne $formalValue) { $registryKey.GetValueKind('local.shiye.workbench').ToString() } else { $null }
            @{qa=$qaValue; qaKind=$qaKind; formal=$formalValue; formalKind=$formalKind} | ConvertTo-Json -Compress
        } elseif ($Action -eq 'write') {
            if (-not $registryKey) { throw 'Run key is missing; test fixture refuses to create it.' }
            $registryKey.SetValue($qaValueName, $Value, [Microsoft.Win32.RegistryValueKind]::String)
        } elseif ($registryKey) {
            $registryKey.DeleteValue($qaValueName, $false)
        }
    } finally { if ($registryKey) { $registryKey.Dispose() } }
    exit
}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class StartupNativeProbe {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct ProcessEntry {
        public uint size, usage, processId;
        public UIntPtr heap;
        public uint moduleId, threads, parentProcessId;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string executable;
    }
    public delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint process);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr window, StringBuilder text, int length);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder text, int length);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    public static object Inspect(uint owner) {
        var all = new List<ProcessEntry>();
        var snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) throw new Exception("Cannot enumerate processes.");
        try {
            var entry = new ProcessEntry { size=(uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (Process32FirstW(snapshot, ref entry)) {
                do { all.Add(entry); } while (Process32NextW(snapshot, ref entry));
            }
        } finally { CloseHandle(snapshot); }
        var descendants = new HashSet<uint> { owner };
        bool added;
        do { added=false; foreach(var entry in all) if(descendants.Contains(entry.parentProcessId)) added |= descendants.Add(entry.processId); } while(added);
        var children = new List<object>();
        foreach(var entry in all) if(entry.processId!=owner && descendants.Contains(entry.processId)) children.Add(new { processId=entry.processId, parent=entry.parentProcessId, name=entry.executable });
        var windows = new List<object>();
        EnumWindows((window, parameter) => {
            uint process; GetWindowThreadProcessId(window, out process);
            if(process==owner) {
                var text=new StringBuilder(512); GetWindowTextW(window,text,text.Capacity);
                var name=new StringBuilder(256); GetClassNameW(window,name,name.Capacity);
                Rect rect; GetWindowRect(window,out rect);
                windows.Add(new { handle=window.ToInt64(), title=text.ToString(), className=name.ToString(), visible=IsWindowVisible(window), width=rect.right-rect.left, height=rect.bottom-rect.top });
            }
            return true;
        }, IntPtr.Zero);
        var foreground=GetForegroundWindow(); uint foregroundProcess; GetWindowThreadProcessId(foreground,out foregroundProcess);
        return new { children, windows, foreground=foreground.ToInt64(), foregroundProcess };
    }
}
'@
[StartupNativeProbe]::Inspect([uint32]$OwnerProcessId) | ConvertTo-Json -Depth 6 -Compress
