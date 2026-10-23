# Default install directory for a fresh setup. An upgrade keeps the directory
# already recorded for this app, so the previous copy is replaced in place.

!macro preInit
  !ifndef BUILD_UNINSTALLER
    ${If} ${UAC_IsAdmin}
      SetRegView 64
      ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $0 == ""
        WriteRegStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\hongguo"
      ${EndIf}
      SetRegView 32
      ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $0 == ""
        WriteRegStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\hongguo"
      ${EndIf}
      SetRegView 64
    ${EndIf}
  !endif
!macroend

# The assisted installer appends the app folder when the chosen path does not
# already contain it. C:\hongguo is the requested root, so keep that path as entered.
!macro customPageAfterChangeDir
  !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !define MUI_PAGE_CUSTOMFUNCTION_PRE KeepInstallDirectory
  Function KeepInstallDirectory
    System::Call 'kernel32::lstrcmpiW(w "$INSTDIR", w "C:\hongguo") i.r0'
    ${If} $0 == 0
      StrCpy $INSTDIR "C:\hongguo"
      Return
    ${EndIf}
    System::Call 'kernel32::lstrcmpiW(w "$INSTDIR", w "C:\hongguo\") i.r0'
    ${If} $0 == 0
      StrCpy $INSTDIR "C:\hongguo"
      Return
    ${EndIf}
    Call instFilesPre
  FunctionEnd
!macroend
