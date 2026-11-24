param(
    [Parameter(Mandatory=$true)][int]$AppPid,
    [ValidateRange(1,3600)][int]$Samples = 30,
    [ValidateRange(20,60000)][int]$IntervalMs = 1000,
    [string]$OutputPath = '.qa/text-memory.json'
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ShiyeTextMemoryQuery {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
  struct Entry {
    public uint size,usage,pid; public UIntPtr heap;
    public uint module,threads,parent; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string exe;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Counters {
    public uint cb,pageFaultCount;
    public UIntPtr peakWorkingSet,workingSet,peakPaged,paged,peakNonPaged,nonPaged,pagefile,peakPagefile,privateUsage;
  }
  public class ProcessSample {
    public int pid,parentPid; public string name;
    public ulong privateWorkingSet,privateBytes,workingSet,peakWorkingSet;
    public bool valid,exitedDuringProbe; public string error,exitProof;
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot,ref Entry entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot,ref Entry entry);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("psapi.dll",SetLastError=true)] static extern bool GetProcessMemoryInfo(IntPtr process,ref Counters counters,uint size);
  [DllImport("psapi.dll",SetLastError=true)] static extern bool QueryWorkingSet(IntPtr process,IntPtr buffer,int bytes);
  static Dictionary<int,Entry> Processes() {
    var snapshot=CreateToolhelp32Snapshot(2,0);
    if(snapshot==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());
    var all=new Dictionary<int,Entry>();
    try {var entry=new Entry();entry.size=(uint)Marshal.SizeOf(typeof(Entry));
      if(!Process32FirstW(snapshot,ref entry))throw new Win32Exception(Marshal.GetLastWin32Error());
      do {all[(int)entry.pid]=entry;}while(Process32NextW(snapshot,ref entry));
      int finalError=Marshal.GetLastWin32Error();
      if(finalError!=18)throw new Win32Exception(finalError); // ERROR_NO_MORE_FILES is the only complete traversal.
    }finally{CloseHandle(snapshot);}return all;
  }
  static ulong PrivateResident(IntPtr process) {
    int capacity=1024*1024;
    while(capacity<=64*1024*1024) {
      IntPtr buffer=Marshal.AllocHGlobal(capacity);
      try {
        if(!QueryWorkingSet(process,buffer,capacity)) {
          int code=Marshal.GetLastWin32Error();if(code==24){capacity*=2;continue;}throw new Win32Exception(code);
        }
        ulong count=IntPtr.Size==8?(ulong)Marshal.ReadInt64(buffer):(uint)Marshal.ReadInt32(buffer);
        if(count>(ulong)(capacity/IntPtr.Size-1))throw new InvalidOperationException("Invalid working-set entry count");
        ulong pages=0;
        for(ulong i=0;i<count;i++) {
          int offset=checked((int)((i+1)*(ulong)IntPtr.Size));
          ulong flags=IntPtr.Size==8?(ulong)Marshal.ReadInt64(buffer,offset):(uint)Marshal.ReadInt32(buffer,offset);
          // PSAPI_WORKING_SET_BLOCK.Shared is bit 8. Non-shareable resident pages form the private working set.
          if((flags&0x100UL)==0)pages++;
        }
        return pages*(ulong)Environment.SystemPageSize;
      }finally{Marshal.FreeHGlobal(buffer);}
    }
    throw new InvalidOperationException("Working-set buffer exceeded 64 MiB");
  }
  static bool Exited(IntPtr process) {
    // A signaled process object proves termination. Failed OpenProcess (including
    // ERROR_INVALID_PARAMETER) alone does not prove this PID exited.
    return process!=IntPtr.Zero&&WaitForSingleObject(process,0)==0;
  }
  public static ProcessSample[] Sample(int root) {
    var all=Processes();if(!all.ContainsKey(root))throw new InvalidOperationException("Owner process has exited");
    var ids=new HashSet<int>();ids.Add(root);bool added;
    do {added=false;foreach(var pair in all)if(ids.Contains((int)pair.Value.parent)&&ids.Add(pair.Key))added=true;}while(added);
    var samples=new List<ProcessSample>();
    var waitHandles=new Dictionary<int,IntPtr>();
    // Pin identities for the entire process-tree frame before any potentially
    // expensive resident-page enumeration can let a short-lived child vanish.
    foreach(int id in ids)waitHandles[id]=OpenProcess(0x100000,false,id);
    try {
    foreach(int id in ids) {
      var entry=all[id];var sample=new ProcessSample{pid=id,parentPid=(int)entry.parent,name=entry.exe};
      IntPtr waitProcess=waitHandles[id];
      IntPtr process=OpenProcess(0x400|0x10,false,id);
      if(process==IntPtr.Zero){
        sample.error=new Win32Exception(Marshal.GetLastWin32Error()).Message;
        sample.exitedDuringProbe=id!=root&&Exited(waitProcess);sample.valid=sample.exitedDuringProbe;
        if(sample.exitedDuringProbe)sample.exitProof="WaitForSingleObject(SYNCHRONIZE handle,0) == WAIT_OBJECT_0";
        samples.Add(sample);continue;
      }
      try {
        var counters=new Counters();counters.cb=(uint)Marshal.SizeOf(typeof(Counters));
        if(!GetProcessMemoryInfo(process,ref counters,counters.cb))throw new Win32Exception(Marshal.GetLastWin32Error());
        sample.privateWorkingSet=PrivateResident(process);sample.privateBytes=counters.privateUsage.ToUInt64();
        sample.workingSet=counters.workingSet.ToUInt64();sample.peakWorkingSet=counters.peakWorkingSet.ToUInt64();sample.valid=true;
      }catch(Exception error){sample.error=error.Message;sample.exitedDuringProbe=id!=root&&Exited(waitProcess);sample.valid=sample.exitedDuringProbe;
        if(sample.exitedDuringProbe)sample.exitProof="WaitForSingleObject(SYNCHRONIZE handle,0) == WAIT_OBJECT_0";
      }finally{CloseHandle(process);}
      samples.Add(sample);
    }
    return samples.ToArray();
    }finally{foreach(var handle in waitHandles.Values)if(handle!=IntPtr.Zero)CloseHandle(handle);}
  }
}
'@
$records = [Collections.Generic.List[object]]::new()
$clock = [Diagnostics.Stopwatch]::StartNew()
for ($index=0; $index -lt $Samples; $index++) {
    $due=([int64]$index+1)*$IntervalMs
    $remaining=$due-$clock.ElapsedMilliseconds
    if($remaining -gt 0){Start-Sleep -Milliseconds $remaining}
    $started=[DateTime]::UtcNow
    $processes=@([ShiyeTextMemoryQuery]::Sample($AppPid))
    $invalid=@($processes|Where-Object {-not $_.valid})
    $records.Add([pscustomobject]@{
        timestamp=$started.ToString('o');elapsedMs=$clock.Elapsed.TotalMilliseconds;valid=$invalid.Count -eq 0
        privateWorkingSet=($processes|Measure-Object privateWorkingSet -Sum).Sum
        privateBytes=($processes|Measure-Object privateBytes -Sum).Sum
        workingSet=($processes|Measure-Object workingSet -Sum).Sum
        processes=$processes
    })
}
$valid=@($records|Where-Object valid)
$ordered=@($valid.privateWorkingSet|Sort-Object)
$privateOrdered=@($valid.privateBytes|Sort-Object)
$intervals=@(for($i=1;$i -lt $records.Count;$i++){([DateTime]::Parse($records[$i].timestamp)-[DateTime]::Parse($records[$i-1].timestamp)).TotalSeconds})
$report=[pscustomobject]@{
    method='Toolhelp owner + recursive descendants; PSAPI QueryWorkingSet non-shared resident pages; GetProcessMemoryInfo PROCESS_MEMORY_COUNTERS_EX.PrivateUsage; failed child queries count as zero only after a previously opened SYNCHRONIZE handle signals termination'
    terminationProof='WaitForSingleObject(handle,0) returns immediately; WAIT_OBJECT_0 proves a process object is signaled, which Microsoft documents as termination. SYNCHRONIZE is sufficient; QUERY_LIMITED_INFORMATION is not a substitute for wait rights. Failed OpenProcess, including error 87, is not proof and remains invalid. Owner failures always remain invalid.'
    references=@('https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-psapi_working_set_block','https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-queryworkingset','https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex','https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject','https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights','https://learn.microsoft.com/en-us/windows/win32/procthread/terminating-a-process','https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess','https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/nf-tlhelp32-process32nextw','https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/nf-tlhelp32-createtoolhelp32snapshot')
    appPid=$AppPid;sampleCount=$records.Count;validSamples=$valid.Count;complete=$valid.Count -eq $Samples
    observationWindowMs=$clock.Elapsed.TotalMilliseconds
    pageSize=[Environment]::SystemPageSize
    p95MiB=if($ordered.Count){$ordered[[Math]::Ceiling($ordered.Count*0.95)-1]/1MB}else{$null}
    peakMiB=if($ordered.Count){$ordered[-1]/1MB}else{$null}
    privateBytesP95MiB=if($privateOrdered.Count){$privateOrdered[[Math]::Ceiling($privateOrdered.Count*0.95)-1]/1MB}else{$null}
    privateBytesPeakMiB=if($privateOrdered.Count){$privateOrdered[-1]/1MB}else{$null}
    meanIntervalSeconds=if($intervals.Count){($intervals|Measure-Object -Average).Average}else{0}
    samples=$records
}
$absolute=[IO.Path]::GetFullPath($OutputPath)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($absolute))|Out-Null
[IO.File]::WriteAllText($absolute,($report|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
$report|Select-Object appPid,sampleCount,validSamples,complete,p95MiB,peakMiB,privateBytesP95MiB,meanIntervalSeconds|ConvertTo-Json -Compress
