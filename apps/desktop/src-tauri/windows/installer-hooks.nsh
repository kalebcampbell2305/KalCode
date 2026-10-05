!include LogicLib.nsh

; Tauri !includes this file at the top level of its installer script, so this installer attribute applies to every
; File command. A locked kalcode.exe (e.g. an exiting process that has not released its image yet) must fail the install
; instead of being skipped: with the NSIS default, a silent /S install answers the write error with Ignore, exits 0 and
; leaves the old binary in place (update-over-087 investigation). The in-app updater then sees the old build start and
; falls back to its restart prompt instead of reporting a successful update.
AllowSkipFiles off

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

; Builds up to 0.1.9+1816 installed kalcode-update-helper.exe (it was a bin of the desktop crate). The helper is
; macOS-only and is no longer in the Windows payload, so this uninstaller would not know the file: an install updated
; from one of those builds kept it and uninstall could never empty the folder. Remove it on update and on uninstall.
!macro KALCODE_REMOVE_RETIRED_FILES
  Delete "$INSTDIR\kalcode-update-helper.exe"
!macroend

; Tauri calls PREINSTALL after SetOutPath has created the destination directory.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro KALCODE_CANONICAL_INSTALL_PATH
  !insertmacro KALCODE_REMOVE_RETIRED_FILES
!macroend

; Tauri calls PREUNINSTALL before deleting files, protocol registrations, or shortcuts.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KALCODE_CANONICAL_INSTALL_PATH
  !insertmacro KALCODE_REMOVE_RETIRED_FILES
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
