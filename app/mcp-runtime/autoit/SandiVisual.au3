#include-once

Global Const $SANDI_VISUAL_ERROR_ARGUMENT = 50
Global Const $SANDI_VISUAL_ERROR_TARGET = 51
Global Const $SANDI_VISUAL_ERROR_GEOMETRY = 52
Global Const $SANDI_VISUAL_ERROR_INPUT = 53

; The public point is normalized; absolute screen pixels exist only inside this guarded action.
Func SandiVisual_Click($hWnd, $iPid, $nNormalizedX, $nNormalizedY, $bObservedActive, _
        $iObservedClientX, $iObservedClientY, $iObservedClientWidth, $iObservedClientHeight, _
        $iObservedOriginX, $iObservedOriginY, $iObservedDpi, _
        $iObservedScreenshotWidth, $iObservedScreenshotHeight)
    If Not __SandiVisual_ObservationValid($nNormalizedX, $nNormalizedY, $bObservedActive, _
            $iObservedClientX, $iObservedClientY, $iObservedClientWidth, $iObservedClientHeight, _
            $iObservedDpi, $iObservedScreenshotWidth, $iObservedScreenshotHeight) Then _
            Return SetError($SANDI_VISUAL_ERROR_ARGUMENT, 0, False)

    Local $hPriorDpiContext = __SandiVisual_EnterDpiContext()
    If @error Then Return SetError($SANDI_VISUAL_ERROR_GEOMETRY, 0, False)

    Local $bInputReady = False
    If IsAdmin() Then
        $bInputReady = __SandiInput_Begin($hWnd, $iPid, "", 0, "", False)
    Else
        $bInputReady = Not $__g_SandiInputBlocked And __SandiInput_Valid($hWnd, $iPid, "", 0, "", False)
    EndIf
    If Not $bInputReady Then
        __SandiInput_Release()
        __SandiVisual_LeaveDpiContext($hPriorDpiContext)
        Return SetError($SANDI_VISUAL_ERROR_TARGET, 0, False)
    EndIf

    If Not __SandiVisual_GeometryMatches($hWnd, $iPid, $iObservedClientX, $iObservedClientY, _
            $iObservedClientWidth, $iObservedClientHeight, $iObservedOriginX, $iObservedOriginY, _
            $iObservedDpi) Then
        __SandiInput_Release()
        __SandiVisual_LeaveDpiContext($hPriorDpiContext)
        Return SetError($SANDI_VISUAL_ERROR_GEOMETRY, 0, False)
    EndIf

    Local $iScreenX = 0
    Local $iScreenY = 0
    If Not __SandiVisual_ConvertPoint($nNormalizedX, $nNormalizedY, _
            $iObservedClientX, $iObservedClientY, $iObservedClientWidth, $iObservedClientHeight, _
            $iObservedOriginX, $iObservedOriginY, $iObservedDpi, _
            $iObservedScreenshotWidth, $iObservedScreenshotHeight, $iScreenX, $iScreenY) Then
        __SandiInput_Release()
        __SandiVisual_LeaveDpiContext($hPriorDpiContext)
        Return SetError($SANDI_VISUAL_ERROR_ARGUMENT, 0, False)
    EndIf

    Local $aMoved = DllCall("user32.dll", "bool", "SetCursorPos", "int", $iScreenX, "int", $iScreenY)
    If @error Or Not IsArray($aMoved) Or Not $aMoved[0] Or _
            Not __SandiInput_Valid($hWnd, $iPid, "", 0, "", False) Or _
            Not __SandiVisual_GeometryMatches($hWnd, $iPid, $iObservedClientX, $iObservedClientY, _
            $iObservedClientWidth, $iObservedClientHeight, $iObservedOriginX, $iObservedOriginY, _
            $iObservedDpi) Then
        __SandiInput_Release()
        __SandiVisual_LeaveDpiContext($hPriorDpiContext)
        Return SetError($SANDI_VISUAL_ERROR_TARGET, 0, False)
    EndIf

    MouseDown("left")
    $__g_SandiInputMouseButton = "left"
    MouseUp("left")
    $__g_SandiInputMouseButton = ""
    Local $bReleased = __SandiInput_Release()
    __SandiVisual_LeaveDpiContext($hPriorDpiContext)
    If Not $bReleased Then Return SetError($SANDI_VISUAL_ERROR_INPUT, 0, False)
    Return True
EndFunc

Func __SandiVisual_ObservationValid($nNormalizedX, $nNormalizedY, $bObservedActive, _
        $iClientX, $iClientY, $iClientWidth, $iClientHeight, $iDpi, _
        $iScreenshotWidth, $iScreenshotHeight)
    If Not IsNumber($nNormalizedX) Or Not IsNumber($nNormalizedY) Or _
            $nNormalizedX < 0 Or $nNormalizedX >= 1 Or _
            $nNormalizedY < 0 Or $nNormalizedY >= 1 Or Not $bObservedActive Then Return False
    If $iClientX <> 0 Or $iClientY <> 0 Or $iClientWidth <= 0 Or $iClientHeight <= 0 Or _
            $iDpi < 48 Or $iDpi > 768 Then Return False
    Return __SandiVisual_ScaleValid($iClientWidth, $iClientHeight, $iScreenshotWidth, $iScreenshotHeight)
EndFunc

Func __SandiVisual_ScaleValid($iClientWidth, $iClientHeight, $iScreenshotWidth, $iScreenshotHeight)
    If $iScreenshotWidth <= 0 Or $iScreenshotHeight <= 0 Or _
            $iScreenshotWidth > $iClientWidth Or $iScreenshotHeight > $iClientHeight Then Return False
    Local $iCrossError = Abs(($iScreenshotWidth * $iClientHeight) - ($iScreenshotHeight * $iClientWidth))
    Local $iTolerance = $iClientWidth
    If $iClientHeight > $iTolerance Then $iTolerance = $iClientHeight
    Return $iCrossError <= $iTolerance
EndFunc

Func __SandiVisual_ConvertPoint($nNormalizedX, $nNormalizedY, _
        $iClientX, $iClientY, $iClientWidth, $iClientHeight, $iOriginX, $iOriginY, $iDpi, _
        $iScreenshotWidth, $iScreenshotHeight, ByRef $iScreenX, ByRef $iScreenY)
    If Not __SandiVisual_ObservationValid($nNormalizedX, $nNormalizedY, True, _
            $iClientX, $iClientY, $iClientWidth, $iClientHeight, $iDpi, _
            $iScreenshotWidth, $iScreenshotHeight) Then Return False
    Local $iScreenshotX = Floor($nNormalizedX * $iScreenshotWidth)
    Local $iScreenshotY = Floor($nNormalizedY * $iScreenshotHeight)
    Local $iClientPointX = Floor($iScreenshotX * $iClientWidth / $iScreenshotWidth)
    Local $iClientPointY = Floor($iScreenshotY * $iClientHeight / $iScreenshotHeight)
    If $iClientPointX < $iClientX Or $iClientPointX >= $iClientX + $iClientWidth Or _
            $iClientPointY < $iClientY Or $iClientPointY >= $iClientY + $iClientHeight Then Return False
    $iScreenX = $iOriginX + ($iClientPointX - $iClientX)
    $iScreenY = $iOriginY + ($iClientPointY - $iClientY)
    Return True
EndFunc

Func __SandiVisual_GeometryMatches($hWnd, $iPid, $iClientX, $iClientY, $iClientWidth, _
        $iClientHeight, $iOriginX, $iOriginY, $iDpi)
    Local $iCurrentClientX = 0
    Local $iCurrentClientY = 0
    Local $iCurrentClientWidth = 0
    Local $iCurrentClientHeight = 0
    Local $iCurrentOriginX = 0
    Local $iCurrentOriginY = 0
    Local $iCurrentDpi = 0
    If Not __SandiVisual_ReadGeometry($hWnd, $iPid, $iCurrentClientX, $iCurrentClientY, _
            $iCurrentClientWidth, $iCurrentClientHeight, $iCurrentOriginX, $iCurrentOriginY, _
            $iCurrentDpi) Then Return False
    Return $iCurrentClientX = $iClientX And $iCurrentClientY = $iClientY And _
            $iCurrentClientWidth = $iClientWidth And $iCurrentClientHeight = $iClientHeight And _
            $iCurrentOriginX = $iOriginX And $iCurrentOriginY = $iOriginY And $iCurrentDpi = $iDpi
EndFunc

Func __SandiVisual_ReadGeometry($hWnd, $iPid, ByRef $iClientX, ByRef $iClientY, _
        ByRef $iClientWidth, ByRef $iClientHeight, ByRef $iOriginX, ByRef $iOriginY, ByRef $iDpi)
    $hWnd = HWnd($hWnd)
    If $hWnd = 0 Or $iPid <= 0 Then Return False
    Local $aWindow = DllCall("user32.dll", "bool", "IsWindow", "hwnd", $hWnd)
    Local $aPid = DllCall("user32.dll", "dword", "GetWindowThreadProcessId", "hwnd", $hWnd, "dword*", 0)
    Local $aForeground = DllCall("user32.dll", "hwnd", "GetForegroundWindow")
    If @error Or Not IsArray($aWindow) Or Not $aWindow[0] Or Not IsArray($aPid) Or _
            $aPid[0] = 0 Or $aPid[2] <> $iPid Or Not IsArray($aForeground) Or _
            $aForeground[0] <> $hWnd Then Return False

    Local $tRect = DllStructCreate("long Left;long Top;long Right;long Bottom")
    Local $aRect = DllCall("user32.dll", "bool", "GetClientRect", "hwnd", $hWnd, "struct*", $tRect)
    If @error Or Not IsArray($aRect) Or Not $aRect[0] Then Return False
    Local $tOrigin = DllStructCreate("long X;long Y")
    DllStructSetData($tOrigin, "X", DllStructGetData($tRect, "Left"))
    DllStructSetData($tOrigin, "Y", DllStructGetData($tRect, "Top"))
    Local $aOrigin = DllCall("user32.dll", "bool", "ClientToScreen", "hwnd", $hWnd, "struct*", $tOrigin)
    Local $aDpi = DllCall("user32.dll", "uint", "GetDpiForWindow", "hwnd", $hWnd)
    If @error Or Not IsArray($aOrigin) Or Not $aOrigin[0] Or Not IsArray($aDpi) Or $aDpi[0] = 0 Then Return False

    $iClientX = DllStructGetData($tRect, "Left")
    $iClientY = DllStructGetData($tRect, "Top")
    $iClientWidth = DllStructGetData($tRect, "Right") - $iClientX
    $iClientHeight = DllStructGetData($tRect, "Bottom") - $iClientY
    $iOriginX = DllStructGetData($tOrigin, "X")
    $iOriginY = DllStructGetData($tOrigin, "Y")
    $iDpi = $aDpi[0]
    Return $iClientWidth > 0 And $iClientHeight > 0
EndFunc

Func __SandiVisual_EnterDpiContext()
    Local $aContext = DllCall("user32.dll", "handle", "SetThreadDpiAwarenessContext", "handle", -4)
    If @error Or Not IsArray($aContext) Or $aContext[0] = 0 Then Return SetError(1, 0, 0)
    Return $aContext[0]
EndFunc

Func __SandiVisual_LeaveDpiContext($hPriorDpiContext)
    If $hPriorDpiContext Then _
            DllCall("user32.dll", "handle", "SetThreadDpiAwarenessContext", "handle", $hPriorDpiContext)
EndFunc
