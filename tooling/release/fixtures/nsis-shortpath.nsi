; Native regression fixture only. It creates/deletes fake payloads and shortcuts exclusively
; beside its own executable; it never touches product registry keys or user shell folders.
Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
OutFile "${OUTPUT}"
!include LogicLib.nsh
!include Win\COM.nsh
!ifdef HOOK_FILE
  !include "${HOOK_FILE}"
!endif

Var CanonicalDir
Var ShortDir
Var InstallCanonical
Var UninstallCanonical

; Exact raw-target comparison used by Tauri's generated utils.nsh. Keeping this comparison
; unchanged proves the hook fixes path representation without relaxing shortcut ownership.
!macro IsShortcutTarget shortcut target
  StrCpy $3 0
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
  ${If} $0 P<> 0
    ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}", .r1)'
    ${If} $1 P<> 0
      ${IPersistFile::Load} $1 '("${shortcut}", ${STGM_READ})'
      System::Alloc 260
      Pop $2
      ${IShellLink::GetPath} $0 '(.r2, 260, 0, 0x4)'
      ${If} $2 == "${target}"
        StrCpy $3 1
      ${EndIf}
      System::Free $2
      ${IUnknown::Release} $1 ""
    ${EndIf}
    ${IUnknown::Release} $0 ""
  ${EndIf}
  Push $3
!macroend

Section
  StrCpy $CanonicalDir "$EXEDIR\App Data Ünicode\KalCode Payload"
  StrCpy $INSTDIR $CanonicalDir
  SetOutPath $INSTDIR
  GetFullPathName /SHORT $ShortDir $INSTDIR
  StrCpy $INSTDIR $ShortDir
  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif
  StrCpy $InstallCanonical $INSTDIR
  FileOpen $0 "$INSTDIR\kalcode.exe" w
  FileWrite $0 "inert fixture payload"
  FileClose $0
  FileOpen $0 "$EXEDIR\unrelated.exe" w
  FileWrite $0 "unrelated inert payload"
  FileClose $0
  CreateShortcut "$EXEDIR\owned.lnk" "$CanonicalDir\kalcode.exe"
  CreateShortcut "$EXEDIR\unrelated.lnk" "$EXEDIR\unrelated.exe"

  ; The uninstall executable may itself be invoked through an 8.3 alias. Mirror the template's
  ; hook-before-delete and shortcut-check-after-delete ordering, including directory removal.
  StrCpy $INSTDIR $ShortDir
  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif
  StrCpy $UninstallCanonical $INSTDIR
  SetOutPath $EXEDIR
  Delete "$INSTDIR\kalcode.exe"
  RMDir "$INSTDIR"
  !insertmacro IsShortcutTarget "$EXEDIR\owned.lnk" "$INSTDIR\kalcode.exe"
  Pop $0
  ${If} $0 = 1
    Delete "$EXEDIR\owned.lnk"
  ${EndIf}
  !insertmacro IsShortcutTarget "$EXEDIR\unrelated.lnk" "$INSTDIR\kalcode.exe"
  Pop $0
  ${If} $0 = 1
    Delete "$EXEDIR\unrelated.lnk"
  ${EndIf}
  WriteINIStr "$EXEDIR\result.ini" "paths" "canonical" "$CanonicalDir"
  WriteINIStr "$EXEDIR\result.ini" "paths" "short" "$ShortDir"
  WriteINIStr "$EXEDIR\result.ini" "paths" "install" "$InstallCanonical"
  WriteINIStr "$EXEDIR\result.ini" "paths" "uninstall" "$UninstallCanonical"
SectionEnd
