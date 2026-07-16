!macro failSilentUninstall
  IfErrors 0 +4
    DetailPrint "Uninstall was not successful. Not able to launch uninstaller."
    SetErrorLevel 2
    Quit

  ${if} $R0 != 0
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    ${EndIf}
    DetailPrint "Uninstall was not successful. Uninstaller error code: $R0."
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

!macro customUnInstallCheck
  !insertmacro failSilentUninstall
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro failSilentUninstall
!macroend
