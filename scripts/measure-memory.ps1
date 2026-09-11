param(
    [Parameter(Mandatory=$true)][int]$AppPid,
    [int]$Samples = 30,
    [string]$OutputPath = '.qa/memory.json'
)
$ErrorActionPreference = 'Stop'
$records = @()
for ($sample = 0; $sample -lt $Samples; $sample++) {
    $processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name)
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($AppPid)
    do {
        $added = $false
        foreach ($item in $processes) {
            if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $added=$true }
        }
    } while ($added)
    $counters = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids.Contains([int]$_.IDProcess) })
    if ($counters.Count -eq 0) { throw 'Application exited before measurement completed.' }
    $records += [pscustomobject]@{
        timestamp = [DateTime]::UtcNow.ToString('o')
        privateWorkingSet = ($counters | Measure-Object WorkingSetPrivate -Sum).Sum
        privateBytes = ($counters | Measure-Object PrivateBytes -Sum).Sum
        processes = @($counters | Select-Object IDProcess,Name,WorkingSetPrivate,PrivateBytes)
    }
    Start-Sleep -Seconds 1
}
$ordered = @($records.privateWorkingSet | Sort-Object)
$report = [pscustomobject]@{
    appPid=$AppPid
    sampleCount=$records.Count
    p95MiB=[Math]::Round($ordered[[Math]::Ceiling($ordered.Count * 0.95)-1] / 1MB, 2)
    peakMiB=[Math]::Round(($ordered | Select-Object -Last 1) / 1MB, 2)
    samples=$records
}
$absolute=if ([IO.Path]::IsPathRooted($OutputPath)) { [IO.Path]::GetFullPath($OutputPath) } else { [IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputPath)) }
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($absolute)) | Out-Null
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $absolute -Encoding UTF8
$report | Select-Object appPid,sampleCount,p95MiB,peakMiB | ConvertTo-Json -Compress
