param([string]$Executable = 'src-tauri/target/release/shiye.exe')
$ErrorActionPreference='Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$source = if ([IO.Path]::IsPathRooted($Executable)) { [IO.Path]::GetFullPath($Executable) } else { Join-Path $workspace $Executable }
$testData = Join-Path $workspace '.qa/smoke-data'
$testNotes = Join-Path $workspace '.qa/smoke-notes'
[IO.Directory]::CreateDirectory($testData) | Out-Null
[IO.Directory]::CreateDirectory($testNotes) | Out-Null
Set-Content -LiteralPath (Join-Path $testNotes 'A.md') -Encoding utf8 -Value "# 工作台验收`n`n[打开 B](B.md)`n`n这是用于实机测试的笔记。`n"
Set-Content -LiteralPath (Join-Path $testNotes 'B.md') -Encoding utf8 -Value "# 关联笔记 B`n`n[继续打开 C](C.md)`n`n[回到 A](A.md)`n"
Set-Content -LiteralPath (Join-Path $testNotes 'C.md') -Encoding utf8 -Value "# 关联笔记 C`n`n连续跳转后，左侧应当显示 B。`n"
$settings=@{root=$testNotes;floating=$true;floatX=40;floatY=180;session=@{module='notes';expanded=@();panes=@(@{path='A.md';mode='edit';cursor=0;scroll=0})}}
[IO.File]::WriteAllText((Join-Path $testData 'settings.json'), ($settings | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
$target = Join-Path $testData 'shiye.exe'
Copy-Item -LiteralPath $source -Destination $target -Force
$env:SHIYE_DATA_DIR=$testData
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'
$env:SHIYE_PROFILE='1'
$process=Start-Process -FilePath $target -WorkingDirectory $workspace -WindowStyle Hidden -PassThru
$process.Id | Set-Content -LiteralPath (Join-Path $testData 'pid.txt')
[pscustomobject]@{pid=$process.Id;exe=$target;data=$testData;notes=$testNotes} | ConvertTo-Json -Compress
