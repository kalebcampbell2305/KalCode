!include LogicLib.nsh

; Shell links store long paths even when /D= or the uninstaller was invoked through an 8.3
; alias. Tauri compares shortcut targets after deleting the payload, when normalization is
; too late. Resolve the existing directory first, retaining its exact filesystem identity.
; Do this during installation too so protocol/registry commands use the same representation.
!macro KALCODE_CANONICAL_INSTALL_PATH
  Push $0
  Push $1
  System::Call 'kernel32::GetLongPathNameW(w "$INSTDIR", w .r0, i ${NSIS_MAX_STRLEN}) i.r1'
  ${If} $1 > 0
  ${AndIf} $1 < ${NSIS_MAX_STRLEN}
    StrCpy $INSTDIR $0
    Pop $1
    Pop $0
  ${Else}
    Pop $1
    Pop $0
    SetErrorLevel 2
    Abort "KalCode could not resolve the installation folder."
  ${EndIf}
!macroend

; Tauri calls PREINSTALL after SetOutPath has created the destination directory.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro KALCODE_CANONICAL_INSTALL_PATH
!macroend

; Tauri calls PREUNINSTALL before deleting files, protocol registrations, or shortcuts.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KALCODE_CANONICAL_INSTALL_PATH
!macroend

; KalCode installs a staged same-version build silently (/S /UPDATE, no /R) after the user closes
; it. A KalCode launched while that install ran stepped aside and left this marker (see
; `apply_lease.rs`); open the new build for it now. Any other launch removes a stale marker.
!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$INSTDIR\kalcode-reopen-after-update"
    Delete "$INSTDIR\kalcode-reopen-after-update"
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
  ${EndIf}
!macroend
