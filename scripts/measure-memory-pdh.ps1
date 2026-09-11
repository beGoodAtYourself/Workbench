param(
    [Parameter(Mandatory=$true)][int]$AppPid,
    [int]$Samples = 30,
    [string]$OutputPath = '.qa/memory.json'
)
$ErrorActionPreference = 'Stop'
# Toolhelp supplies parent PIDs without a separate WMI provider query per sample.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ShiyeProcessTree {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Entry {
    public uint size, usage, pid; public UIntPtr heap;
    public uint module, threads, parent; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe;
  }
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot,ref Entry entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot,ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static HashSet<int> Descendants(int root) {
    var parents=new Dictionary<int,int>(); var snapshot=CreateToolhelp32Snapshot(2,0);
    if(snapshot==new IntPtr(-1))throw new InvalidOperationException("Process snapshot failed");
    try { var entry=new Entry(); entry.size=(uint)Marshal.SizeOf(typeof(Entry));
      if(Process32FirstW(snapshot,ref entry))do { parents[(int)entry.pid]=(int)entry.parent; }while(Process32NextW(snapshot,ref entry));
    }finally { CloseHandle(snapshot); }
    var ids=new HashSet<int>();ids.Add(root);bool added;
    do { added=false; foreach(var pair in parents)if(ids.Contains(pair.Value)&&ids.Add(pair.Key))added=true; }while(added);
    return ids;
  }
}
'@
$records = [Collections.Generic.List[object]]::new()
$paths = @('\Process(*)\ID Process','\Process(*)\Working Set - Private','\Process(*)\Private Bytes')
$frames = [Collections.Generic.List[object]]::new()
Get-Counter -Counter $paths -SampleInterval 1 -MaxSamples $Samples -ErrorAction SilentlyContinue | ForEach-Object {
    $frames.Add(@{frame=$_;ids=[ShiyeProcessTree]::Descendants($AppPid)})
}
foreach ($sample in $frames) {
    $frame = $sample.frame
    $ids = $sample.ids
    $instances = @{}
    foreach ($counter in $frame.CounterSamples) {
        if ($counter.Status -notin @(0,1)) { continue }
        $name = [regex]::Match($counter.Path,'(?i)\\process\((.*)\)\\').Groups[1].Value
        if (-not $instances.ContainsKey($name)) { $instances[$name] = @{} }
        $leaf = $counter.Path.Substring($counter.Path.LastIndexOf('\')+1).ToLowerInvariant()
        $instances[$name][$leaf] = [double]$counter.CookedValue
    }
    $seen = [Collections.Generic.HashSet[int]]::new()
    $related = @(foreach ($pair in $instances.GetEnumerator()) {
        $value=$pair.Value; $id=[int]$value['id process']
        if ($ids.Contains($id) -and $seen.Add($id)) {
            [pscustomobject]@{IDProcess=$id;Name=$pair.Key;WorkingSetPrivate=$value['working set - private'];PrivateBytes=$value['private bytes']}
        }
    })
    if ($related.Count -eq 0 -or -not $seen.Contains($AppPid)) { throw 'Application exited or its counters are unavailable.' }
    $records.Add([pscustomobject]@{
        timestamp=$frame.Timestamp.ToUniversalTime().ToString('o')
        privateWorkingSet=($related | Measure-Object WorkingSetPrivate -Sum).Sum
        privateBytes=($related | Measure-Object PrivateBytes -Sum).Sum
        processes=$related
    })
}
$ordered = @($records.privateWorkingSet | Sort-Object)
$intervals = @(for($i=1;$i -lt $records.Count;$i++){([DateTime]::Parse($records[$i].timestamp)-[DateTime]::Parse($records[$i-1].timestamp)).TotalSeconds})
$report = [pscustomobject]@{
    method='PDH Process counters + Toolhelp descendant PID snapshot'
    appPid=$AppPid; sampleCount=$records.Count
    p95MiB=[Math]::Round($ordered[[Math]::Ceiling($ordered.Count*0.95)-1]/1MB,2)
    peakMiB=[Math]::Round(($ordered | Select-Object -Last 1)/1MB,2)
    meanIntervalSeconds=if($intervals.Count){($intervals | Measure-Object -Average).Average}else{0}
    samples=$records
}
$absolute=if([IO.Path]::IsPathRooted($OutputPath)){[IO.Path]::GetFullPath($OutputPath)}else{[IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputPath))}
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($absolute)) | Out-Null
[IO.File]::WriteAllText($absolute,($report | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
$report | Select-Object appPid,sampleCount,p95MiB,peakMiB,meanIntervalSeconds | ConvertTo-Json -Compress
