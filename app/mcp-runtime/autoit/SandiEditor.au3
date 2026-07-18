#include-once

; Atomic editor insertion has a fixed budget because callers cannot make global input safe by waiting longer.
Global Const $SANDI_EDITOR_ERROR_PAYLOAD = 40
Global Const $SANDI_EDITOR_ERROR_TARGET = 41
Global Const $SANDI_EDITOR_ERROR_UNSUPPORTED = 42
Global Const $SANDI_EDITOR_ERROR_CLIPBOARD = 43
Global Const $SANDI_EDITOR_ERROR_TIMEOUT = 44

Global Const $__SANDI_EDITOR_MAX_CHARS = 65536
Global Const $__SANDI_EDITOR_MAX_DURATION_MS = 5000
Global Const $__SANDI_EDITOR_CLIPBOARD_LOCAL = 1
Global Const $__SANDI_EDITOR_CLIPBOARD_SUPERVISOR = 2
Global Const $__SANDI_EDITOR_MAX_CLIPBOARD_FORMATS = 128

Global $__g_SandiEditorClipboardMode = 0
Global $__g_SandiEditorClipboardFormats[$__SANDI_EDITOR_MAX_CLIPBOARD_FORMATS]
Global $__g_SandiEditorClipboardHandles[$__SANDI_EDITOR_MAX_CLIPBOARD_FORMATS]
Global $__g_SandiEditorClipboardFormatCount = 0

Func SandiEditor_InsertText($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $sText, _
        $sClassName = "", $sPath = "")
    Local $hTimer = TimerInit()
    Local $sNormalized = __SandiEditor_NormalizeNewlines($sText)
    Local $iLength = StringLen($sNormalized)
    If $iLength < 1 Or $iLength > $__SANDI_EDITOR_MAX_CHARS Then _
            Return SetError($SANDI_EDITOR_ERROR_PAYLOAD, $iLength, False)

    Local $oElement = SandiUIA_Find($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $sClassName, $sPath)
    Local $iError = @error
    Local $iExtended = @extended
    If $iError Then Return SetError($iError, $iExtended, False)
    If Not __SandiUIA_FocusedMatches($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $sClassName, $sPath) Then _
            Return SetError($SANDI_EDITOR_ERROR_TARGET, 0, False)

    Local $oValue = __SandiUIA_Pattern($oElement, $__SANDI_UIA_VALUE_PATTERN)
    Local $iValueError = @error
    If Not $iValueError Then
        Local $bReadOnly = 1
        Local $iHr = $oValue.CurrentIsReadOnly($bReadOnly)
        If $iHr <> 0 Then Return SetError($SANDI_UIA_ERROR_COM, $iHr, False)
        If Not $bReadOnly Then
            $iHr = $oValue.SetValue($sNormalized)
            If $iHr <> 0 Then Return SetError($SANDI_UIA_ERROR_COM, $iHr, False)
            If TimerDiff($hTimer) > $__SANDI_EDITOR_MAX_DURATION_MS Then _
                    Return SetError($SANDI_EDITOR_ERROR_TIMEOUT, 0, False)
            If Not __SandiUIA_FocusedMatches($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $sClassName, $sPath) Then _
                    Return SetError($SANDI_EDITOR_ERROR_TARGET, 1, False)
            Return True
        EndIf
    EndIf

    If Not __SandiEditor_CanPaste($oElement, $iControlType) Then _
            Return SetError($SANDI_EDITOR_ERROR_UNSUPPORTED, $iControlType, False)
    If Not __SandiEditor_SetClipboard($sNormalized, $hTimer) Then
        $iError = @error
        $iExtended = @extended
        __SandiInput_Release()
        Return SetError($iError, $iExtended, False)
    EndIf
    If Not __SandiInput_Valid($hWnd, $iPid, $sAutomationId, $iControlType, $sName, True, $sClassName, $sPath) Then
        __SandiInput_Release()
        Return SetError($SANDI_EDITOR_ERROR_TARGET, 2, False)
    EndIf
    Local $bSent = Send("^v")
    Sleep(50)
    Local $bStillFocused = __SandiInput_Valid($hWnd, $iPid, $sAutomationId, $iControlType, $sName, True, $sClassName, $sPath)
    Local $bReleased = __SandiInput_Release()
    $iError = @error
    If Not $bReleased Then Return SetError($iError, 0, False)
    If Not $bSent Then Return SetError($SANDI_EDITOR_ERROR_UNSUPPORTED, 0, False)
    If Not $bStillFocused Then Return SetError($SANDI_EDITOR_ERROR_TARGET, 3, False)
    If TimerDiff($hTimer) > $__SANDI_EDITOR_MAX_DURATION_MS Then _
            Return SetError($SANDI_EDITOR_ERROR_TIMEOUT, 0, False)
    Return True
EndFunc

Func __SandiEditor_NormalizeNewlines($sText)
    Local $sNormalized = StringReplace(String($sText), @CRLF, @LF)
    $sNormalized = StringReplace($sNormalized, @CR, @LF)
    Return StringReplace($sNormalized, @LF, @CRLF)
EndFunc

Func __SandiEditor_CanPaste($oElement, $iControlType)
    If $iControlType <> $SANDI_UIA_EDIT And $iControlType <> $SANDI_UIA_DOCUMENT And _
            $iControlType <> $SANDI_UIA_CUSTOM Then Return False
    Local $pPattern = 0
    Local $iHr = $oElement.GetCurrentPattern($__SANDI_EDITOR_TEXT_PATTERN, $pPattern)
    If $iHr <> 0 Or Not $pPattern Then Return False
    __SandiEditor_ReleaseCom($pPattern)
    Return True
EndFunc

Func __SandiEditor_SetClipboard($sText, $hTimer)
    If Not __SandiEditor_CaptureClipboard($hTimer) Then Return SetError(@error, @extended, False)
    ClipPut($sText)
    If ClipGet() <> $sText Then
        __SandiEditor_RestoreClipboard()
        Return SetError($SANDI_EDITOR_ERROR_CLIPBOARD, 1, False)
    EndIf
    If TimerDiff($hTimer) > $__SANDI_EDITOR_MAX_DURATION_MS Then
        __SandiEditor_RestoreClipboard()
        Return SetError($SANDI_EDITOR_ERROR_TIMEOUT, 1, False)
    EndIf
    Return True
EndFunc

Func __SandiEditor_CaptureClipboard($hTimer)
    If $__g_SandiEditorClipboardMode <> 0 Then Return SetError($SANDI_EDITOR_ERROR_CLIPBOARD, 2, False)
    Local $sRequest = EnvGet("SANDI_AUTOIT_CLIPBOARD_REQUEST")
    Local $sReady = EnvGet("SANDI_AUTOIT_CLIPBOARD_READY")
    Local $sRestore = EnvGet("SANDI_AUTOIT_CLIPBOARD_RESTORE")
    Local $sRestored = EnvGet("SANDI_AUTOIT_CLIPBOARD_RESTORED")
    If $sRequest <> "" And $sReady <> "" And $sRestore <> "" And $sRestored <> "" Then
        FileDelete($sRequest)
        FileDelete($sReady)
        FileDelete($sRestore)
        FileDelete($sRestored)
        If Not FileWrite($sRequest, "capture") Then Return SetError($SANDI_EDITOR_ERROR_CLIPBOARD, 3, False)
        While Not FileExists($sReady)
            If TimerDiff($hTimer) > $__SANDI_EDITOR_MAX_DURATION_MS Then _
                    Return SetError($SANDI_EDITOR_ERROR_TIMEOUT, 2, False)
            Sleep(10)
        WEnd
        If StringStripWS(FileRead($sReady), 3) <> "ok" Then _
                Return SetError($SANDI_EDITOR_ERROR_CLIPBOARD, 6, False)
        $__g_SandiEditorClipboardMode = $__SANDI_EDITOR_CLIPBOARD_SUPERVISOR
        Return True
    EndIf

    If Not __SandiEditor_CaptureLocalClipboard() Then _
            Return SetError($SANDI_EDITOR_ERROR_CLIPBOARD, 4, False)
    $__g_SandiEditorClipboardMode = $__SANDI_EDITOR_CLIPBOARD_LOCAL
    Return True
EndFunc

Func __SandiEditor_RestoreClipboard()
    If $__g_SandiEditorClipboardMode = 0 Then Return True
    Local $bRestored = False
    If $__g_SandiEditorClipboardMode = $__SANDI_EDITOR_CLIPBOARD_LOCAL Then
        $bRestored = __SandiEditor_RestoreLocalClipboard()
    Else
        Local $sRestore = EnvGet("SANDI_AUTOIT_CLIPBOARD_RESTORE")
        Local $sRestored = EnvGet("SANDI_AUTOIT_CLIPBOARD_RESTORED")
        If $sRestore <> "" And $sRestored <> "" And FileWrite($sRestore, "restore") Then
            Local $hTimer = TimerInit()
            While Not FileExists($sRestored) And TimerDiff($hTimer) <= $__SANDI_EDITOR_MAX_DURATION_MS
                Sleep(10)
            WEnd
            $bRestored = FileExists($sRestored) And StringStripWS(FileRead($sRestored), 3) = "ok"
        EndIf
    EndIf
    If Not $bRestored Then Return SetError($SANDI_EDITOR_ERROR_CLIPBOARD, 5, False)
    $__g_SandiEditorClipboardMode = 0
    Return True
EndFunc

Func __SandiEditor_CaptureLocalClipboard()
    If Not __SandiEditor_OpenClipboard() Then Return False
    $__g_SandiEditorClipboardFormatCount = 0
    Local $iFormat = 0
    While $__g_SandiEditorClipboardFormatCount < $__SANDI_EDITOR_MAX_CLIPBOARD_FORMATS
        Local $aNext = DllCall("user32.dll", "uint", "EnumClipboardFormats", "uint", $iFormat)
        If @error Or $aNext[0] = 0 Then ExitLoop
        $iFormat = $aNext[0]
        Local $aSource = DllCall("user32.dll", "handle", "GetClipboardData", "uint", $iFormat)
        If @error Or Not $aSource[0] Then
            DllCall("user32.dll", "bool", "CloseClipboard")
            Return False
        EndIf
        Local $aCopy = DllCall("ole32.dll", "handle", "OleDuplicateData", "handle", $aSource[0], "uint", $iFormat, "uint", 0)
        If @error Or Not $aCopy[0] Then
            DllCall("user32.dll", "bool", "CloseClipboard")
            Return False
        EndIf
        $__g_SandiEditorClipboardFormats[$__g_SandiEditorClipboardFormatCount] = $iFormat
        $__g_SandiEditorClipboardHandles[$__g_SandiEditorClipboardFormatCount] = $aCopy[0]
        $__g_SandiEditorClipboardFormatCount += 1
    WEnd
    If $__g_SandiEditorClipboardFormatCount = $__SANDI_EDITOR_MAX_CLIPBOARD_FORMATS Then
        Local $aExtra = DllCall("user32.dll", "uint", "EnumClipboardFormats", "uint", $iFormat)
        If Not @error And $aExtra[0] <> 0 Then
            DllCall("user32.dll", "bool", "CloseClipboard")
            Return False
        EndIf
    EndIf
    DllCall("user32.dll", "bool", "CloseClipboard")
    Return True
EndFunc

Func __SandiEditor_RestoreLocalClipboard()
    If Not __SandiEditor_OpenClipboard() Then Return False
    Local $aEmpty = DllCall("user32.dll", "bool", "EmptyClipboard")
    If @error Or Not $aEmpty[0] Then
        DllCall("user32.dll", "bool", "CloseClipboard")
        Return False
    EndIf
    For $iIndex = 0 To $__g_SandiEditorClipboardFormatCount - 1
        Local $aSet = DllCall("user32.dll", "handle", "SetClipboardData", "uint", $__g_SandiEditorClipboardFormats[$iIndex], "handle", $__g_SandiEditorClipboardHandles[$iIndex])
        If @error Or Not $aSet[0] Then
            DllCall("user32.dll", "bool", "CloseClipboard")
            Return False
        EndIf
        $__g_SandiEditorClipboardHandles[$iIndex] = 0
    Next
    DllCall("user32.dll", "bool", "CloseClipboard")
    $__g_SandiEditorClipboardFormatCount = 0
    Return True
EndFunc

Func __SandiEditor_OpenClipboard()
    Local $hTimer = TimerInit()
    Do
        Local $aOpened = DllCall("user32.dll", "bool", "OpenClipboard", "hwnd", 0)
        If Not @error And $aOpened[0] Then Return True
        Sleep(10)
    Until TimerDiff($hTimer) >= $__SANDI_EDITOR_MAX_DURATION_MS
    Return False
EndFunc

Func __SandiEditor_ReleaseCom($pObject)
    If Not $pObject Then Return
    Local $tObject = DllStructCreate("ptr", $pObject)
    Local $pVtable = DllStructGetData($tObject, 1)
    If Not $pVtable Then Return
    Local $tVtable = DllStructCreate("ptr QueryInterface;ptr AddRef;ptr Release", $pVtable)
    Local $pRelease = DllStructGetData($tVtable, "Release")
    If $pRelease Then DllCallAddress("ulong", $pRelease, "ptr", $pObject)
EndFunc
