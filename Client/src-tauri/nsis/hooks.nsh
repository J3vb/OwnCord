; NSIS hooks that Tauri's installer template includes
; (`bundle.windows.nsis.installerHooks` in tauri.conf.json). Macro names are
; Tauri's: NSIS_HOOK_PREINSTALL runs in `Section Install` right before the
; template's running-app check and its `File` copy of the main executable.

!macro NSIS_HOOK_PREINSTALL
  ; An update (`/UPDATE`, launched by tauri-plugin-updater) starts this
  ; installer and only then exits the old process. Its executable stays locked
  ; until Windows has torn that process down, while the template sleeps just
  ; 500 ms before `File` overwrites it. A silent installer skips a file it
  ; cannot open and `/R` then relaunches the OLD binary; a passive one blocks
  ; on a Retry/Ignore dialog. Wait, bounded, until the old executable opens for
  ; writing. Manual installs over a running app keep the template's kill flow.
  ${If} $UpdateMode = 1
  ${AndIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    DetailPrint "Waiting for the previous ${MAINBINARYNAME}.exe to exit"
    StrCpy $R9 0
    ${Do}
      ClearErrors
      FileOpen $R8 "$INSTDIR\${MAINBINARYNAME}.exe" a
      ${IfNot} ${Errors}
        FileClose $R8
        ${ExitDo}
      ${EndIf}
      IntOp $R9 $R9 + 1
      ; ponytail: fixed 30 s ceiling (150 x 200 ms); past it the template's
      ; own behaviour applies. Raise it only with evidence of slower teardown.
      ${If} $R9 >= 150
        DetailPrint "${MAINBINARYNAME}.exe is still locked after 30 s; continuing"
        ${ExitDo}
      ${EndIf}
      Sleep 200
    ${Loop}
  ${EndIf}
!macroend
