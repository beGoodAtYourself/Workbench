; Current-user Run lifecycle. This file never touches StartupApproved.
; The accompanying template captures state before its reinstall page runs.
!if "${BUNDLEID}" == "local.shiye.workbench"
  !define SHIYE_STARTUP_VALUE "local.shiye.workbench"
!else if "${BUNDLEID}" == "local.shiye.workbench.startupqa"
  !define SHIYE_STARTUP_VALUE "local.shiye.workbench.startupqa"
!else
  !error "Unsupported Shiye installer identity: ${BUNDLEID}"
!endif
!define SHIYE_STARTUP_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

Var ShiyeStartupCommand
Var ShiyeStartupState
Var ShiyeStartupError
Var ShiyeStartupBytes
Var ShiyeStartupExpectedPath
Var ShiyeStartupOwned
Var ShiyeStartupSnapshotCommand
Var ShiyeStartupSnapshotBytes
Var ShiyeStartupSnapshotEnabled
Var ShiyeStartupPreviousDirectory

!macro ShiyeStartupFailure message
  DetailPrint "${message}"
  IfSilent +2 0
    MessageBox MB_OK|MB_ICONSTOP "${message}"
  SetErrorLevel 2
  Abort "${message}"
!macroend

; Results: missing/string/other; errors are distinguished from absence. Only
; well-formed REG_SZ commands within the Run limit are eligible for mutation.
!macro ShiyeStartupReadFunction prefix
Function ${prefix}ShiyeStartupRead
  System::Store "s"
  StrCpy $ShiyeStartupState "missing"
  StrCpy $ShiyeStartupError 0
  StrCpy $ShiyeStartupCommand ""
  StrCpy $ShiyeStartupBytes 0
  System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "${SHIYE_STARTUP_KEY}", i 0, i 0x101, *p .r1) i .r0'
  ${If} $0 = 2
    Goto shiye_read_done
  ${ElseIf} $0 <> 0
    StrCpy $ShiyeStartupError $0
    Goto shiye_read_done
  ${EndIf}
  System::Call 'advapi32::RegQueryValueExW(p r1, w "${SHIYE_STARTUP_VALUE}", p 0, *i .r2, p 0, *i .r3) i .r0'
  ${If} $0 = 2
    Goto shiye_read_close
  ${ElseIf} $0 <> 0
    StrCpy $ShiyeStartupError $0
    Goto shiye_read_close
  ${EndIf}
  StrCpy $ShiyeStartupState "other"
  StrCpy $ShiyeStartupBytes $3
  ${If} $2 <> 1
  ${OrIf} $3 < 2
  ${OrIf} $3 > 522
    Goto shiye_read_close
  ${EndIf}
  ; Two extra zero bytes protect against a REG_SZ without its terminator.
  System::Call '*(&w262 "") p .r5'
  ${If} $5 = 0
    StrCpy $ShiyeStartupError 8
    Goto shiye_read_close
  ${EndIf}
  System::Call 'advapi32::RegQueryValueExW(p r1, w "${SHIYE_STARTUP_VALUE}", p 0, *i .r2, p r5, *i r3 .r3) i .r0'
  ${If} $0 = 2
    StrCpy $ShiyeStartupState "missing"
    StrCpy $ShiyeStartupBytes 0
  ${ElseIf} $0 <> 0
    StrCpy $ShiyeStartupError $0
  ${ElseIf} $2 = 1
    System::Call '*$5(&w262 .r4)'
    StrLen $6 $4
    IntOp $6 $6 + 1
    IntOp $6 $6 * 2
    ; Reject embedded/trailing NUL data, unterminated strings and type changes.
    ${If} $3 = $6
      StrCpy $ShiyeStartupState "string"
      StrCpy $ShiyeStartupCommand $4
      StrCpy $ShiyeStartupBytes $3
    ${EndIf}
  ${EndIf}
  System::Free $5
  shiye_read_close:
  System::Call 'advapi32::RegCloseKey(p r1)'
  shiye_read_done:
  System::Store "l"
FunctionEnd
!macroend
!insertmacro ShiyeStartupReadFunction ""
!insertmacro ShiyeStartupReadFunction "un."

; Compare the executable argument, never a substring or a directory prefix.
; Absolute paths are normalized and compared using Windows ordinal case rules.
!macro ShiyeStartupOwnedFunction prefix
Function ${prefix}ShiyeStartupCheckOwned
  System::Store "s"
  StrCpy $ShiyeStartupOwned 0
  ${If} $ShiyeStartupState != "string"
    Goto shiye_owned_done
  ${EndIf}
  StrCpy $0 $ShiyeStartupCommand
  System::Call 'shell32::CommandLineToArgvW(w r0, *i .r2) p .r1'
  ${If} $1 = 0
    Goto shiye_owned_done
  ${EndIf}
  System::Call '*$1(p .r3)'
  System::Call '*$3(&w262 .r4)'
  System::Call 'kernel32::LocalFree(p r1)'
  StrCpy $3 $4 4
  ${If} $3 == "\\?\"
    StrCpy $4 $4 "" 4
    StrCpy $3 $4 4
    ${If} $3 == "UNC\"
      StrCpy $4 $4 "" 4
      StrCpy $4 "\\$4"
    ${EndIf}
  ${EndIf}
  StrCpy $3 $4 2
  ${If} $3 != "\\"
    StrCpy $3 $4 1 1
    ${If} $3 != ":"
      Goto shiye_owned_done
    ${EndIf}
    StrCpy $3 $4 1 2
    ${If} $3 != "\"
    ${AndIf} $3 != "/"
      Goto shiye_owned_done
    ${EndIf}
  ${EndIf}
  System::Call 'kernel32::GetFullPathNameW(w r4, i ${NSIS_MAX_STRLEN}, w .r5, p 0) i .r7'
  ${If} $7 = 0
  ${OrIf} $7 >= ${NSIS_MAX_STRLEN}
    Goto shiye_owned_done
  ${EndIf}
  StrCpy $0 $ShiyeStartupExpectedPath
  System::Call 'kernel32::GetFullPathNameW(w r0, i ${NSIS_MAX_STRLEN}, w .r6, p 0) i .r7'
  ${If} $7 = 0
  ${OrIf} $7 >= ${NSIS_MAX_STRLEN}
    Goto shiye_owned_done
  ${EndIf}
  System::Call 'kernel32::CompareStringOrdinal(w r5, i -1, w r6, i -1, i 1) i .r7'
  ${If} $7 = 2
    StrCpy $ShiyeStartupOwned 1
  ${EndIf}
  shiye_owned_done:
  System::Store "l"
FunctionEnd
!macroend
!insertmacro ShiyeStartupOwnedFunction ""
!insertmacro ShiyeStartupOwnedFunction "un."

; Read-only: cancellation or a fresh installation cannot create a Run value.
Function ShiyeStartupSnapshot
  System::Store "s"
  StrCpy $ShiyeStartupSnapshotEnabled 0
  ReadRegStr $ShiyeStartupPreviousDirectory HKCU "${MANUPRODUCTKEY}" ""
  Call ShiyeStartupRead
  ${If} $ShiyeStartupError <> 0
    System::Store "l"
    !insertmacro ShiyeStartupFailure "无法读取开机自启动状态（错误代码 $ShiyeStartupError）。启动项未更改，请重试安装。"
  ${EndIf}
  ${If} $ShiyeStartupPreviousDirectory != ""
    StrCpy $ShiyeStartupExpectedPath "$ShiyeStartupPreviousDirectory\${MAINBINARYNAME}.exe"
    Call ShiyeStartupCheckOwned
    ${If} $ShiyeStartupOwned = 1
      StrCpy $ShiyeStartupSnapshotEnabled 1
      StrCpy $ShiyeStartupSnapshotCommand $ShiyeStartupCommand
      StrCpy $ShiyeStartupSnapshotBytes $ShiyeStartupBytes
    ${EndIf}
  ${EndIf}
  System::Store "l"
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  Call ShiyeStartupRelocate
!macroend

Function ShiyeStartupRelocate
  System::Store "s"
  ${If} $ShiyeStartupSnapshotEnabled <> 1
    Goto shiye_relocate_done
  ${EndIf}
  Call ShiyeStartupRead
  ${If} $ShiyeStartupError <> 0
    System::Store "l"
    !insertmacro ShiyeStartupFailure "程序文件已安装，但无法复核开机自启动状态（错误代码 $ShiyeStartupError）。请打开拾页设置检查后重试。"
  ${EndIf}
  ; Preserve an external deletion/change instead of recreating cached state.
  ${If} $ShiyeStartupState != "string"
  ${OrIf} $ShiyeStartupCommand S!= $ShiyeStartupSnapshotCommand
  ${OrIf} $ShiyeStartupBytes <> $ShiyeStartupSnapshotBytes
    DetailPrint "自启动项在安装期间已变更，保留当前系统状态。"
    Goto shiye_relocate_done
  ${EndIf}
  StrCpy $ShiyeStartupExpectedPath "$INSTDIR\${MAINBINARYNAME}.exe"
  Call ShiyeStartupCheckOwned
  ${If} $ShiyeStartupOwned = 1
    Goto shiye_relocate_done
  ${EndIf}
  StrCpy $0 '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --autostart'
  StrLen $1 $0
  ${If} $1 > 260
    System::Store "l"
    !insertmacro ShiyeStartupFailure "程序文件已安装，但新路径的自启动命令超过 260 字符。原启动项未更改，请选择更短的安装路径。"
  ${EndIf}
  IntOp $1 $1 + 1
  IntOp $1 $1 * 2
  System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "${SHIYE_STARTUP_KEY}", i 0, i 0x103, *p .r2) i .r3'
  ${If} $3 = 0
    System::Call 'advapi32::RegSetValueExW(p r2, w "${SHIYE_STARTUP_VALUE}", i 0, i 1, w r0, i r1) i .r3'
    System::Call 'advapi32::RegCloseKey(p r2)'
  ${EndIf}
  ${If} $3 <> 0
    StrCpy $ShiyeStartupError $3
    System::Store "l"
    !insertmacro ShiyeStartupFailure "程序文件已安装，但无法更新自启动路径（错误代码 $ShiyeStartupError）。请打开拾页设置检查后重试。"
  ${EndIf}
  StrCpy $ShiyeStartupSnapshotCommand $0
  Call ShiyeStartupRead
  ${If} $ShiyeStartupError <> 0
  ${OrIf} $ShiyeStartupState != "string"
  ${OrIf} $ShiyeStartupCommand S!= $ShiyeStartupSnapshotCommand
    System::Store "l"
    !insertmacro ShiyeStartupFailure "程序文件已安装，但自启动路径更新后无法确认。请打开拾页设置读取实际状态后重试。"
  ${EndIf}
  DetailPrint "已保留开机自启动并更新程序路径。"
  shiye_relocate_done:
  System::Store "l"
FunctionEnd

; Cleanup runs only after files are removed, so an uninstall cancellation in
; Tauri's running-process prompt leaves the user's enabled state untouched.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    Call un.ShiyeStartupCleanup
  ${EndIf}
!macroend

Function un.ShiyeStartupCleanup
  System::Store "s"
  Call un.ShiyeStartupRead
  ${If} $ShiyeStartupError <> 0
    System::Store "l"
    !insertmacro ShiyeStartupFailure "程序文件已卸载，但无法读取开机自启动项（错误代码 $ShiyeStartupError）。请在 Windows 启动设置中检查残留项。"
  ${EndIf}
  StrCpy $ShiyeStartupExpectedPath "$INSTDIR\${MAINBINARYNAME}.exe"
  Call un.ShiyeStartupCheckOwned
  ${If} $ShiyeStartupOwned = 1
    System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "${SHIYE_STARTUP_KEY}", i 0, i 0x103, *p .r1) i .r0'
    ${If} $0 = 0
      System::Call 'advapi32::RegDeleteValueW(p r1, w "${SHIYE_STARTUP_VALUE}") i .r0'
      System::Call 'advapi32::RegCloseKey(p r1)'
    ${EndIf}
    ; A concurrently removed value is already clean.
    ${If} $0 <> 0
    ${AndIf} $0 <> 2
      StrCpy $ShiyeStartupError $0
      System::Store "l"
      !insertmacro ShiyeStartupFailure "程序文件已卸载，但无法删除本副本的自启动项（错误代码 $ShiyeStartupError）。请在 Windows 启动设置中检查残留项。"
    ${EndIf}
    Call un.ShiyeStartupRead
    Call un.ShiyeStartupCheckOwned
    ${If} $ShiyeStartupError <> 0
    ${OrIf} $ShiyeStartupOwned = 1
      System::Store "l"
      !insertmacro ShiyeStartupFailure "程序文件已卸载，但无法确认本副本的自启动项已清理。请在 Windows 启动设置中检查残留项。"
    ${EndIf}
    DetailPrint "已删除本副本的开机自启动项。"
  ${EndIf}
  System::Store "l"
FunctionEnd
