#include-once
#include <AutoItConstants.au3>

; Sandi's narrow HWND-scoped UIA and guarded global-input facade.

Global Const $SANDI_UIA_BUTTON = 50000
Global Const $SANDI_UIA_CHECKBOX = 50002
Global Const $SANDI_UIA_COMBOBOX = 50003
Global Const $SANDI_UIA_EDIT = 50004
Global Const $SANDI_UIA_HYPERLINK = 50005
Global Const $SANDI_UIA_LISTITEM = 50007
Global Const $SANDI_UIA_LIST = 50008
Global Const $SANDI_UIA_MENUITEM = 50011
Global Const $SANDI_UIA_RADIOBUTTON = 50013
Global Const $SANDI_UIA_TABITEM = 50019
Global Const $SANDI_UIA_TREEITEM = 50024
Global Const $SANDI_UIA_CUSTOM = 50025
Global Const $SANDI_UIA_DOCUMENT = 50030

Global Const $SANDI_UIA_ERROR_CLIENT = 1
Global Const $SANDI_UIA_ERROR_ROOT = 2
Global Const $SANDI_UIA_ERROR_SELECTOR = 3
Global Const $SANDI_UIA_ERROR_NOT_FOUND = 4
Global Const $SANDI_UIA_ERROR_AMBIGUOUS = 5
Global Const $SANDI_UIA_ERROR_PATTERN = 6
Global Const $SANDI_UIA_ERROR_COM = 7
Global Const $SANDI_UIA_ERROR_LIMIT = 8

Global Const $SANDI_INPUT_ERROR_BUSY = 20
Global Const $SANDI_INPUT_ERROR_BLOCK = 21
Global Const $SANDI_INPUT_ERROR_TARGET = 22
Global Const $SANDI_INPUT_ERROR_ARGUMENT = 23

Global Const $__SANDI_CLSID_UIA = "{FF48DBA4-60EF-4201-AA87-54103EEF594E}"
Global Const $__SANDI_IID_UIA = "{30CBE57D-D9D0-452A-AB13-7AC5AC4825EE}"
Global Const $__SANDI_IID_ELEMENT = "{D22108AA-8AC5-49A5-837B-37BBB3D7591E}"
Global Const $__SANDI_IID_ELEMENT_ARRAY = "{14314595-B4BC-4055-95F2-58F2E42C9855}"
Global Const $__SANDI_IID_INVOKE = "{FB377FBE-8EA6-46D5-9C73-6499642D3059}"
Global Const $__SANDI_IID_VALUE = "{A94CD8B1-0844-4CD6-9D2D-640537AB39E9}"
Global Const $__SANDI_IID_SELECTION_ITEM = "{A8EFA66A-0FDA-421A-9194-38021F3578EA}"
Global Const $__SANDI_IID_TOGGLE = "{94CF8058-9B8D-4AB9-8BFD-4CD0A33C8C70}"

Global Const $__SANDI_TAG_UIA = _
        "CompareElements hresult(ptr;ptr;long*);" & _
        "CompareRuntimeIds hresult(ptr;ptr;long*);" & _
        "GetRootElement hresult(ptr*);" & _
        "ElementFromHandle hresult(hwnd;ptr*);" & _
        "ElementFromPoint hresult(struct;ptr*);" & _
        "GetFocusedElement hresult(ptr*);" & _
        "GetRootElementBuildCache hresult(ptr;ptr*);" & _
        "ElementFromHandleBuildCache hresult(hwnd;ptr;ptr*);" & _
        "ElementFromPointBuildCache hresult(struct;ptr;ptr*);" & _
        "GetFocusedElementBuildCache hresult(ptr;ptr*);" & _
        "CreateTreeWalker hresult(ptr;ptr*);" & _
        "ControlViewWalker hresult(ptr*);" & _
        "ContentViewWalker hresult(ptr*);" & _
        "RawViewWalker hresult(ptr*);" & _
        "RawViewCondition hresult(ptr*);" & _
        "ControlViewCondition hresult(ptr*);" & _
        "ContentViewCondition hresult(ptr*);" & _
        "CreateCacheRequest hresult(ptr*);" & _
        "CreateTrueCondition hresult(ptr*);"
Global Const $__SANDI_TAG_ELEMENT = _
        "SetFocus hresult();" & _
        "GetRuntimeId hresult(ptr*);" & _
        "FindFirst hresult(long;ptr;ptr*);" & _
        "FindAll hresult(long;ptr;ptr*);" & _
        "FindFirstBuildCache hresult(long;ptr;ptr;ptr*);" & _
        "FindAllBuildCache hresult(long;ptr;ptr;ptr*);" & _
        "BuildUpdatedCache hresult(ptr;ptr*);" & _
        "GetCurrentPropertyValue hresult(int;variant*);" & _
        "GetCurrentPropertyValueEx hresult(int;long;variant*);" & _
        "GetCachedPropertyValue hresult(int;variant*);" & _
        "GetCachedPropertyValueEx hresult(int;long;variant*);" & _
        "GetCurrentPatternAs hresult(int;ptr;ptr*);" & _
        "GetCachedPatternAs hresult(int;ptr;ptr*);" & _
        "GetCurrentPattern hresult(int;ptr*);"
Global Const $__SANDI_TAG_ELEMENT_ARRAY = _
        "Length hresult(int*);" & _
        "GetElement hresult(int;ptr*);"
Global Const $__SANDI_TAG_INVOKE = "Invoke hresult();"
Global Const $__SANDI_TAG_VALUE = _
        "SetValue hresult(wstr);" & _
        "CurrentValue hresult(bstr*);" & _
        "CurrentIsReadOnly hresult(long*);" & _
        "CachedValue hresult(bstr*);" & _
        "CachedIsReadOnly hresult(long*);"
Global Const $__SANDI_TAG_SELECTION_ITEM = _
        "Select hresult();" & _
        "AddToSelection hresult();" & _
        "RemoveFromSelection hresult();" & _
        "CurrentIsSelected hresult(long*);" & _
        "CurrentSelectionContainer hresult(ptr*);" & _
        "CachedIsSelected hresult(long*);" & _
        "CachedSelectionContainer hresult(ptr*);"
Global Const $__SANDI_TAG_TOGGLE = _
        "Toggle hresult();" & _
        "CurrentToggleState hresult(int*);" & _
        "CachedToggleState hresult(int*);"

Global Const $__SANDI_UIA_PROCESS_ID = 30002
Global Const $__SANDI_UIA_CONTROL_TYPE = 30003
Global Const $__SANDI_UIA_NAME = 30005
Global Const $__SANDI_UIA_HAS_KEYBOARD_FOCUS = 30008
Global Const $__SANDI_UIA_AUTOMATION_ID = 30011
Global Const $__SANDI_UIA_CLASS_NAME = 30012
Global Const $__SANDI_UIA_NATIVE_WINDOW_HANDLE = 30020
Global Const $__SANDI_UIA_TREE_SCOPE_CHILDREN = 2
Global Const $__SANDI_UIA_INVOKE_PATTERN = 10000
Global Const $__SANDI_UIA_VALUE_PATTERN = 10002
Global Const $__SANDI_UIA_SELECTION_ITEM_PATTERN = 10010
Global Const $__SANDI_EDITOR_TEXT_PATTERN = 10014
Global Const $__SANDI_UIA_TOGGLE_PATTERN = 10015
Global Const $__SANDI_UIA_MAX_NODES = 256
Global Const $__SANDI_UIA_MAX_CANDIDATES = 8
Global Const $__SANDI_UIA_INSPECT_DEFAULT_NODES = 64
Global Const $__SANDI_UIA_INSPECT_DEFAULT_RESULTS = 32
Global Const $__SANDI_UIA_INSPECT_MAX_RESULTS = 128
Global Const $__SANDI_INPUT_TEXT_CHUNK = 8
Global Const $__SANDI_INPUT_MOVE_PIXELS = 24

Global $__g_SandiUIA = ObjCreateInterface($__SANDI_CLSID_UIA, $__SANDI_IID_UIA, $__SANDI_TAG_UIA)
Global $__g_SandiUIATrueCondition = 0
Global $__g_SandiInputBlocked = False
Global $__g_SandiInputMouseButton = ""

OnAutoItExitRegister("__SandiInput_Release")

Func SandiUIA_Root($hWnd, $iPid)
    $hWnd = HWnd($hWnd)
    If $hWnd = 0 Or Not WinExists($hWnd) Or $iPid <= 0 Then _
            Return SetError($SANDI_UIA_ERROR_ROOT, 0, 0)
    Local $iActualPid = WinGetProcess($hWnd)
    If @error Or $iActualPid <> $iPid Then _
            Return SetError($SANDI_UIA_ERROR_ROOT, $iActualPid, 0)
    If Not IsObj($__g_SandiUIA) Then _
            Return SetError($SANDI_UIA_ERROR_CLIENT, 0, 0)

    Local $pRoot = 0
    Local $iHr = $__g_SandiUIA.ElementFromHandle($hWnd, $pRoot)
    If $iHr <> 0 Or Not $pRoot Then _
            Return SetError($SANDI_UIA_ERROR_ROOT, $iHr, 0)
    Local $oRoot = ObjCreateInterface($pRoot, $__SANDI_IID_ELEMENT, $__SANDI_TAG_ELEMENT)
    If Not IsObj($oRoot) Then Return SetError($SANDI_UIA_ERROR_ROOT, 0, 0)
    Local $vRootPid = 0
    If Not __SandiUIA_Property($oRoot, $__SANDI_UIA_PROCESS_ID, $vRootPid) Or $vRootPid <> $iPid Then _
            Return SetError($SANDI_UIA_ERROR_ROOT, $vRootPid, 0)
    Return $oRoot
EndFunc

; Paths let later actions re-resolve inspector output without retaining cross-process COM objects.
Func SandiUIA_Inspect($hWnd, $iPid, $sAutomationId = "", $iControlType = 0, $sName = "", _
        $sClassName = "", $bIncludeDocumentChildren = False, _
        $iMaxNodes = $__SANDI_UIA_INSPECT_DEFAULT_NODES, _
        $iMaxResults = $__SANDI_UIA_INSPECT_DEFAULT_RESULTS)
    If $iControlType < 0 Or $iMaxNodes < 1 Or $iMaxNodes > $__SANDI_UIA_MAX_NODES Or _
            $iMaxResults < 1 Or $iMaxResults > $__SANDI_UIA_INSPECT_MAX_RESULTS Or _
            Int($iMaxNodes) <> $iMaxNodes Or Int($iMaxResults) <> $iMaxResults Then _
            Return SetError($SANDI_UIA_ERROR_SELECTOR, 0, "")
    Local $oRoot = SandiUIA_Root($hWnd, $iPid)
    Local $iRootError = @error
    Local $iRootExtended = @extended
    If $iRootError Then Return SetError($iRootError, $iRootExtended, "")
    Local $bConditionReady = __SandiUIA_EnsureTrueCondition()
    Local $iConditionError = @error
    Local $iConditionExtended = @extended
    If Not $bConditionReady Then Return SetError($iConditionError, $iConditionExtended, "")

    Local $aQueue[$__SANDI_UIA_MAX_NODES]
    Local $aPaths[$__SANDI_UIA_MAX_NODES]
    Local $aResults[$__SANDI_UIA_INSPECT_MAX_RESULTS]
    Local $iHead = 0
    Local $iTail = 1
    Local $iVisited = 0
    Local $iMatched = 0
    Local $iReturned = 0
    Local $iDocumentSubtreesSkipped = 0
    Local $bNodeTruncated = False
    Local $bResultTruncated = False
    $aQueue[0] = $oRoot
    $aPaths[0] = ""

    While $iHead < $iTail
        If $iVisited >= $iMaxNodes Then
            $bNodeTruncated = True
            ExitLoop
        EndIf
        Local $oParent = $aQueue[$iHead]
        Local $sParentPath = $aPaths[$iHead]
        $iHead += 1
        Local $pChildren = 0
        Local $iHr = $oParent.FindAll($__SANDI_UIA_TREE_SCOPE_CHILDREN, $__g_SandiUIATrueCondition, $pChildren)
        If $iHr <> 0 Or Not $pChildren Then _
                Return SetError($SANDI_UIA_ERROR_COM, $iHr, "")
        Local $oChildren = ObjCreateInterface($pChildren, $__SANDI_IID_ELEMENT_ARRAY, $__SANDI_TAG_ELEMENT_ARRAY)
        If Not IsObj($oChildren) Then Return SetError($SANDI_UIA_ERROR_COM, 0, "")
        Local $iLength = 0
        $iHr = $oChildren.Length($iLength)
        If $iHr <> 0 Then Return SetError($SANDI_UIA_ERROR_COM, $iHr, "")

        For $iIndex = 0 To $iLength - 1
            If $iVisited >= $iMaxNodes Then
                $bNodeTruncated = True
                ExitLoop
            EndIf
            Local $pElement = 0
            $iHr = $oChildren.GetElement($iIndex, $pElement)
            If $iHr <> 0 Or Not $pElement Then ContinueLoop
            Local $oElement = ObjCreateInterface($pElement, $__SANDI_IID_ELEMENT, $__SANDI_TAG_ELEMENT)
            If Not IsObj($oElement) Then ContinueLoop
            $iVisited += 1

            Local $vElementPid = 0
            Local $vElementType = 0
            If Not __SandiUIA_Property($oElement, $__SANDI_UIA_PROCESS_ID, $vElementPid) Or _
                    Not __SandiUIA_Property($oElement, $__SANDI_UIA_CONTROL_TYPE, $vElementType) Then ContinueLoop
            If $vElementPid <> $iPid Then ContinueLoop
            Local $sElementPath = String($iIndex)
            If $sParentPath <> "" Then $sElementPath = $sParentPath & "/" & $sElementPath

            If __SandiUIA_FilterMatches($oElement, $sAutomationId, $iControlType, $sName, $sClassName) Then
                $iMatched += 1
                If $iReturned < $iMaxResults Then
                    Local $sElementJson = __SandiUIA_ElementJson($oElement, $sElementPath)
                    Local $iElementError = @error
                    Local $iElementExtended = @extended
                    If $iElementError Then Return SetError($iElementError, $iElementExtended, "")
                    $aResults[$iReturned] = $sElementJson
                    $iReturned += 1
                Else
                    $bResultTruncated = True
                EndIf
            EndIf

            If $vElementType = $SANDI_UIA_DOCUMENT And Not $bIncludeDocumentChildren Then
                $iDocumentSubtreesSkipped += 1
            ElseIf $iTail < $iMaxNodes And $iTail < $__SANDI_UIA_MAX_NODES Then
                $aQueue[$iTail] = $oElement
                $aPaths[$iTail] = $sElementPath
                $iTail += 1
            Else
                $bNodeTruncated = True
            EndIf
        Next
        If $bNodeTruncated And $iVisited >= $iMaxNodes Then ExitLoop
    WEnd

    Local $sElements = "["
    For $iIndex = 0 To $iReturned - 1
        If $iIndex > 0 Then $sElements &= ","
        $sElements &= $aResults[$iIndex]
    Next
    $sElements &= "]"
    Local $bTruncated = $bNodeTruncated Or $bResultTruncated
    Return "{" & _
            '"root":{"pid":' & $iPid & ',"hwnd":' & Number(HWnd($hWnd)) & "}," & _
            '"filters":{"automationId":' & __SandiUIA_JsonString($sAutomationId) & _
            ',"controlType":' & $iControlType & ',"name":' & __SandiUIA_JsonString($sName) & _
            ',"className":' & __SandiUIA_JsonString($sClassName) & "}," & _
            '"limits":{"nodes":' & $iMaxNodes & ',"results":' & $iMaxResults & "}," & _
            '"includeDocumentChildren":' & __SandiUIA_JsonBoolean($bIncludeDocumentChildren) & "," & _
            '"visited":' & $iVisited & ',"matched":' & $iMatched & ',"returned":' & $iReturned & "," & _
            '"documentSubtreesSkipped":' & $iDocumentSubtreesSkipped & "," & _
            '"truncated":' & __SandiUIA_JsonBoolean($bTruncated) & "," & _
            '"truncation":{"nodes":' & __SandiUIA_JsonBoolean($bNodeTruncated) & _
            ',"results":' & __SandiUIA_JsonBoolean($bResultTruncated) & "}," & _
            '"elements":' & $sElements & "}"
EndFunc

Func SandiUIA_Find($hWnd, $iPid, $sAutomationId, $iControlType, $sName = "", $sClassName = "", $sPath = "")
    If $iControlType <= 0 Then _
            Return SetError($SANDI_UIA_ERROR_SELECTOR, 0, 0)
    Local $oRoot = SandiUIA_Root($hWnd, $iPid)
    Local $iRootError = @error
    Local $iRootExtended = @extended
    If $iRootError Then Return SetError($iRootError, $iRootExtended, 0)
    Local $bConditionReady = __SandiUIA_EnsureTrueCondition()
    Local $iConditionError = @error
    Local $iConditionExtended = @extended
    If Not $bConditionReady Then Return SetError($iConditionError, $iConditionExtended, 0)

    Local $aQueue[$__SANDI_UIA_MAX_NODES]
    Local $aDepth[$__SANDI_UIA_MAX_NODES]
    Local $aPaths[$__SANDI_UIA_MAX_NODES]
    Local $aCandidates[$__SANDI_UIA_MAX_CANDIDATES]
    Local $iHead = 0
    Local $iTail = 1
    Local $iMatchCount = 0
    Local $iCandidateCount = 0
    Local $bTruncated = False
    Local $oMatch = 0
    $aQueue[0] = $oRoot
    $aDepth[0] = 0
    $aPaths[0] = ""

    While $iHead < $iTail
        Local $oParent = $aQueue[$iHead]
        Local $iDepth = $aDepth[$iHead]
        Local $sParentPath = $aPaths[$iHead]
        $iHead += 1
        Local $pChildren = 0
        Local $iHr = $oParent.FindAll($__SANDI_UIA_TREE_SCOPE_CHILDREN, $__g_SandiUIATrueCondition, $pChildren)
        If $iHr <> 0 Or Not $pChildren Then _
                Return SetError($SANDI_UIA_ERROR_COM, $iHr, 0)
        Local $oChildren = ObjCreateInterface($pChildren, $__SANDI_IID_ELEMENT_ARRAY, $__SANDI_TAG_ELEMENT_ARRAY)
        If Not IsObj($oChildren) Then Return SetError($SANDI_UIA_ERROR_COM, 0, 0)
        Local $iLength = 0
        $iHr = $oChildren.Length($iLength)
        If $iHr <> 0 Then Return SetError($SANDI_UIA_ERROR_COM, $iHr, 0)

        For $iIndex = 0 To $iLength - 1
            Local $pElement = 0
            $iHr = $oChildren.GetElement($iIndex, $pElement)
            If $iHr <> 0 Or Not $pElement Then ContinueLoop
            Local $oElement = ObjCreateInterface($pElement, $__SANDI_IID_ELEMENT, $__SANDI_TAG_ELEMENT)
            If Not IsObj($oElement) Then ContinueLoop

            Local $vElementPid = 0
            Local $vElementType = 0
            If Not __SandiUIA_Property($oElement, $__SANDI_UIA_PROCESS_ID, $vElementPid) Or _
                    Not __SandiUIA_Property($oElement, $__SANDI_UIA_CONTROL_TYPE, $vElementType) Then ContinueLoop
            If $vElementPid <> $iPid Then ContinueLoop
            Local $sElementPath = String($iIndex)
            If $sParentPath <> "" Then $sElementPath = $sParentPath & "/" & $sElementPath
            If $iCandidateCount < $__SANDI_UIA_MAX_CANDIDATES Then
                $aCandidates[$iCandidateCount] = __SandiUIA_ElementText($oElement)
                $iCandidateCount += 1
            EndIf

            If __SandiUIA_Matches($oElement, $sAutomationId, $iControlType, $sName, $sClassName, $sPath, $sElementPath) Then
                $iMatchCount += 1
                If $iMatchCount = 1 Then $oMatch = $oElement
                If $iMatchCount > 1 Then
                    ConsoleWriteError("SandiUIA: ambiguous selector " & _
                            __SandiUIA_SelectorText($sAutomationId, $iControlType, $sName) & _
                            "; candidates=" & __SandiUIA_ElementText($oMatch) & " | " & _
                            __SandiUIA_ElementText($oElement) & @CRLF)
                    Return SetError($SANDI_UIA_ERROR_AMBIGUOUS, $iMatchCount, 0)
                EndIf
            EndIf

            If ($vElementType <> $SANDI_UIA_DOCUMENT Or $sPath <> "") And _
                    __SandiUIA_PathCanContain($sPath, $sElementPath) Then
                If $iTail < $__SANDI_UIA_MAX_NODES Then
                    $aQueue[$iTail] = $oElement
                    $aDepth[$iTail] = $iDepth + 1
                    $aPaths[$iTail] = $sElementPath
                    $iTail += 1
                Else
                    $bTruncated = True
                EndIf
            EndIf
        Next
    WEnd

    If $bTruncated Then
        ConsoleWriteError("SandiUIA: bounded search limit reached for " & _
                __SandiUIA_SelectorText($sAutomationId, $iControlType, $sName) & @CRLF)
        Return SetError($SANDI_UIA_ERROR_LIMIT, $iTail, 0)
    EndIf
    If $iMatchCount = 1 Then Return $oMatch

    ConsoleWriteError("SandiUIA: no element matched " & _
            __SandiUIA_SelectorText($sAutomationId, $iControlType, $sName) & _
            "; candidates=" & __SandiUIA_StringCandidates($aCandidates, $iCandidateCount) & @CRLF)
    Return SetError($SANDI_UIA_ERROR_NOT_FOUND, 0, 0)
EndFunc

Func SandiUIA_Describe($hWnd, $iPid, $sAutomationId, $iControlType, $sName = "", $sClassName = "", $sPath = "")
    Local $oElement = SandiUIA_Find($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $sClassName, $sPath)
    Local $iError = @error
    Local $iExtended = @extended
    If $iError Then Return SetError($iError, $iExtended, "")
    Return __SandiUIA_ElementText($oElement)
EndFunc

Func SandiUIA_Invoke($hWnd, $iPid, $sAutomationId, $iControlType, $sName = "", $sClassName = "", $sPath = "")
    Local $bResult = __SandiUIA_Mutate($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $__SANDI_UIA_INVOKE_PATTERN, $sClassName, $sPath)
    Local $iError = @error
    Local $iExtended = @extended
    Return SetError($iError, $iExtended, $bResult)
EndFunc

Func SandiUIA_Toggle($hWnd, $iPid, $sAutomationId, $iControlType, $sName = "", $sClassName = "", $sPath = "")
    Local $bResult = __SandiUIA_Mutate($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $__SANDI_UIA_TOGGLE_PATTERN, $sClassName, $sPath)
    Local $iError = @error
    Local $iExtended = @extended
    Return SetError($iError, $iExtended, $bResult)
EndFunc

Func SandiUIA_Select($hWnd, $iPid, $sAutomationId, $iControlType, $sName = "", $sClassName = "", $sPath = "")
    Local $bResult = __SandiUIA_Mutate($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $__SANDI_UIA_SELECTION_ITEM_PATTERN, $sClassName, $sPath)
    Local $iError = @error
    Local $iExtended = @extended
    Return SetError($iError, $iExtended, $bResult)
EndFunc

Func SandiUIA_GetValue($hWnd, $iPid, $sAutomationId, $iControlType, $sName = "", $sClassName = "", $sPath = "")
    Local $oElement = SandiUIA_Find($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $sClassName, $sPath)
    Local $iError = @error
    Local $iExtended = @extended
    If $iError Then Return SetError($iError, $iExtended, "")
    Local $oPattern = __SandiUIA_Pattern($oElement, $__SANDI_UIA_VALUE_PATTERN)
    $iError = @error
    $iExtended = @extended
    If $iError Then Return SetError($iError, $iExtended, "")
    Local $sValue = ""
    Local $iHr = $oPattern.CurrentValue($sValue)
    If $iHr <> 0 Then Return SetError($SANDI_UIA_ERROR_COM, $iHr, "")
    Return $sValue
EndFunc

Func SandiUIA_SetValue($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $sValue, $sClassName = "", $sPath = "")
    Local $oElement = SandiUIA_Find($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $sClassName, $sPath)
    Local $iError = @error
    Local $iExtended = @extended
    If $iError Then Return SetError($iError, $iExtended, False)
    Local $oPattern = __SandiUIA_Pattern($oElement, $__SANDI_UIA_VALUE_PATTERN)
    $iError = @error
    $iExtended = @extended
    If $iError Then Return SetError($iError, $iExtended, False)
    Local $bReadOnly = 1
    Local $iHr = $oPattern.CurrentIsReadOnly($bReadOnly)
    If $iHr <> 0 Or $bReadOnly Then Return SetError($SANDI_UIA_ERROR_PATTERN, $iHr, False)
    $iHr = $oPattern.SetValue($sValue)
    If $iHr <> 0 Then Return SetError($SANDI_UIA_ERROR_COM, $iHr, False)
    Return True
EndFunc

; Global fallback helpers own BlockInput so validation and cleanup cannot drift apart.
Func SandiInput_TypeText($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $sText)
    If StringInStr($sText, @CR) Or StringInStr($sText, @LF) Then _
            Return SetError($SANDI_INPUT_ERROR_ARGUMENT, 0, False)
    Local $bStarted = __SandiInput_Begin($hWnd, $iPid, $sAutomationId, $iControlType, $sName, True)
    Local $iStartError = @error
    Local $iStartExtended = @extended
    If Not $bStarted Then Return SetError($iStartError, $iStartExtended, False)
    Local $iOffset = 1
    Local $iLength = StringLen($sText)
    While $iOffset <= $iLength
        If Not __SandiInput_Valid($hWnd, $iPid, $sAutomationId, $iControlType, $sName, True) Then
            __SandiInput_Release()
            Return SetError($SANDI_INPUT_ERROR_TARGET, $iOffset, False)
        EndIf
        Local $iChunkLength = $__SANDI_INPUT_TEXT_CHUNK
        If $iOffset + $iChunkLength - 1 > $iLength Then $iChunkLength = $iLength - $iOffset + 1
        Send(StringMid($sText, $iOffset, $iChunkLength), $SEND_RAW)
        $iOffset += $iChunkLength
        Sleep(10)
    WEnd
    __SandiInput_Release()
    Return True
EndFunc

Func SandiInput_PressKey($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $sKey)
    Switch $sKey
        Case "{ENTER}", "{TAB}", "{ESC}", "{SPACE}", "{UP}", "{DOWN}", "{LEFT}", "{RIGHT}", "{HOME}", "{END}", "{PGUP}", "{PGDN}", "{BACKSPACE}", "{DELETE}"
        Case Else
            Return SetError($SANDI_INPUT_ERROR_ARGUMENT, 0, False)
    EndSwitch
    Local $bStarted = __SandiInput_Begin($hWnd, $iPid, $sAutomationId, $iControlType, $sName, True)
    Local $iStartError = @error
    Local $iStartExtended = @extended
    If Not $bStarted Then Return SetError($iStartError, $iStartExtended, False)
    If Not __SandiInput_Valid($hWnd, $iPid, $sAutomationId, $iControlType, $sName, True) Then
        __SandiInput_Release()
        Return SetError($SANDI_INPUT_ERROR_TARGET, 0, False)
    EndIf
    Send($sKey)
    __SandiInput_Release()
    Return True
EndFunc

Func SandiInput_Click($hWnd, $iPid, $iX, $iY, $sButton = "left", $iClicks = 1)
    If $iClicks < 1 Or $iClicks > 3 Or Not __SandiInput_ButtonValid($sButton) Or _
            Not __SandiInput_PointInWindow($hWnd, $iX, $iY) Then _
            Return SetError($SANDI_INPUT_ERROR_ARGUMENT, 0, False)
    Local $bStarted = __SandiInput_Begin($hWnd, $iPid, "", 0, "", False)
    Local $iStartError = @error
    Local $iStartExtended = @extended
    If Not $bStarted Then Return SetError($iStartError, $iStartExtended, False)
    For $iClick = 1 To $iClicks
        If Not __SandiInput_Valid($hWnd, $iPid, "", 0, "", False) Then
            __SandiInput_Release()
            Return SetError($SANDI_INPUT_ERROR_TARGET, $iClick, False)
        EndIf
        MouseClick($sButton, $iX, $iY, 1, 0)
    Next
    __SandiInput_Release()
    Return True
EndFunc

Func SandiInput_Drag($hWnd, $iPid, $iStartX, $iStartY, $iEndX, $iEndY, $sButton = "left")
    If Not __SandiInput_ButtonValid($sButton) Or _
            Not __SandiInput_PointInWindow($hWnd, $iStartX, $iStartY) Or _
            Not __SandiInput_PointInWindow($hWnd, $iEndX, $iEndY) Then _
            Return SetError($SANDI_INPUT_ERROR_ARGUMENT, 0, False)
    Local $bStarted = __SandiInput_Begin($hWnd, $iPid, "", 0, "", False)
    Local $iStartError = @error
    Local $iStartExtended = @extended
    If Not $bStarted Then Return SetError($iStartError, $iStartExtended, False)
    If Not __SandiInput_Valid($hWnd, $iPid, "", 0, "", False) Then
        __SandiInput_Release()
        Return SetError($SANDI_INPUT_ERROR_TARGET, 0, False)
    EndIf
    MouseMove($iStartX, $iStartY, 0)
    If Not __SandiInput_Valid($hWnd, $iPid, "", 0, "", False) Then
        __SandiInput_Release()
        Return SetError($SANDI_INPUT_ERROR_TARGET, 0, False)
    EndIf
    MouseDown($sButton)
    $__g_SandiInputMouseButton = $sButton
    Local $iDistance = Abs($iEndX - $iStartX)
    If Abs($iEndY - $iStartY) > $iDistance Then $iDistance = Abs($iEndY - $iStartY)
    Local $iSteps = Ceiling($iDistance / $__SANDI_INPUT_MOVE_PIXELS)
    If $iSteps < 1 Then $iSteps = 1
    For $iStep = 1 To $iSteps
        If Not __SandiInput_Valid($hWnd, $iPid, "", 0, "", False) Then
            __SandiInput_Release()
            Return SetError($SANDI_INPUT_ERROR_TARGET, $iStep, False)
        EndIf
        Local $iX = Round($iStartX + (($iEndX - $iStartX) * $iStep / $iSteps))
        Local $iY = Round($iStartY + (($iEndY - $iStartY) * $iStep / $iSteps))
        MouseMove($iX, $iY, 0)
        Sleep(10)
    Next
    __SandiInput_Release()
    Return True
EndFunc

Func SandiInput_Wheel($hWnd, $iPid, $sDirection, $iSteps)
    If ($sDirection <> "up" And $sDirection <> "down") Or $iSteps < 1 Or $iSteps > 20 Then _
            Return SetError($SANDI_INPUT_ERROR_ARGUMENT, 0, False)
    Local $bStarted = __SandiInput_Begin($hWnd, $iPid, "", 0, "", False)
    Local $iStartError = @error
    Local $iStartExtended = @extended
    If Not $bStarted Then Return SetError($iStartError, $iStartExtended, False)
    For $iStep = 1 To $iSteps
        If Not __SandiInput_Valid($hWnd, $iPid, "", 0, "", False) Then
            __SandiInput_Release()
            Return SetError($SANDI_INPUT_ERROR_TARGET, $iStep, False)
        EndIf
        MouseWheel($sDirection, 1)
        Sleep(10)
    Next
    __SandiInput_Release()
    Return True
EndFunc

Func __SandiUIA_Mutate($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $iPatternId, _
        $sClassName = "", $sPath = "")
    Local $oElement = SandiUIA_Find($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $sClassName, $sPath)
    Local $iError = @error
    Local $iExtended = @extended
    If $iError Then Return SetError($iError, $iExtended, False)
    Local $oPattern = __SandiUIA_Pattern($oElement, $iPatternId)
    $iError = @error
    $iExtended = @extended
    If $iError Then Return SetError($iError, $iExtended, False)
    Local $iHr = -1
    Switch $iPatternId
        Case $__SANDI_UIA_INVOKE_PATTERN
            $iHr = $oPattern.Invoke()
        Case $__SANDI_UIA_TOGGLE_PATTERN
            $iHr = $oPattern.Toggle()
        Case $__SANDI_UIA_SELECTION_ITEM_PATTERN
            $iHr = $oPattern.Select()
    EndSwitch
    If $iHr <> 0 Then Return SetError($SANDI_UIA_ERROR_COM, $iHr, False)
    Return True
EndFunc

Func __SandiUIA_Pattern($oElement, $iPatternId)
    Local $pPattern = 0
    Local $iHr = $oElement.GetCurrentPattern($iPatternId, $pPattern)
    If $iHr <> 0 Or Not $pPattern Then Return SetError($SANDI_UIA_ERROR_PATTERN, $iHr, 0)
    Local $oPattern = 0
    Switch $iPatternId
        Case $__SANDI_UIA_INVOKE_PATTERN
            $oPattern = ObjCreateInterface($pPattern, $__SANDI_IID_INVOKE, $__SANDI_TAG_INVOKE)
        Case $__SANDI_UIA_VALUE_PATTERN
            $oPattern = ObjCreateInterface($pPattern, $__SANDI_IID_VALUE, $__SANDI_TAG_VALUE)
        Case $__SANDI_UIA_SELECTION_ITEM_PATTERN
            $oPattern = ObjCreateInterface($pPattern, $__SANDI_IID_SELECTION_ITEM, $__SANDI_TAG_SELECTION_ITEM)
        Case $__SANDI_UIA_TOGGLE_PATTERN
            $oPattern = ObjCreateInterface($pPattern, $__SANDI_IID_TOGGLE, $__SANDI_TAG_TOGGLE)
        Case Else
            Return SetError($SANDI_UIA_ERROR_PATTERN, $iPatternId, 0)
    EndSwitch
    If Not IsObj($oPattern) Then Return SetError($SANDI_UIA_ERROR_PATTERN, $iPatternId, 0)
    Return $oPattern
EndFunc

Func __SandiUIA_EnsureTrueCondition()
    If $__g_SandiUIATrueCondition Then Return True
    If Not IsObj($__g_SandiUIA) Then Return SetError($SANDI_UIA_ERROR_CLIENT, 0, False)
    Local $iHr = $__g_SandiUIA.CreateTrueCondition($__g_SandiUIATrueCondition)
    If $iHr <> 0 Or Not $__g_SandiUIATrueCondition Then Return SetError($SANDI_UIA_ERROR_COM, $iHr, False)
    Return True
EndFunc

Func __SandiUIA_Matches($oElement, $sAutomationId, $iControlType, $sName, _
        $sClassName = "", $sPath = "", $sElementPath = "")
    Local $vValue = 0
    If Not __SandiUIA_Property($oElement, $__SANDI_UIA_CONTROL_TYPE, $vValue) Or $vValue <> $iControlType Then Return False
    If $sAutomationId <> "" Then
        If Not __SandiUIA_Property($oElement, $__SANDI_UIA_AUTOMATION_ID, $vValue) Or $vValue <> $sAutomationId Then Return False
    EndIf
    If $sName <> "" Then
        If Not __SandiUIA_Property($oElement, $__SANDI_UIA_NAME, $vValue) Or $vValue <> $sName Then Return False
    EndIf
    If $sClassName <> "" Then
        If Not __SandiUIA_Property($oElement, $__SANDI_UIA_CLASS_NAME, $vValue) Or $vValue <> $sClassName Then Return False
    EndIf
    If $sPath <> "" And $sPath <> $sElementPath Then Return False
    Return True
EndFunc

Func __SandiUIA_FilterMatches($oElement, $sAutomationId, $iControlType, $sName, $sClassName)
    Local $vValue = 0
    If $iControlType > 0 Then
        If Not __SandiUIA_Property($oElement, $__SANDI_UIA_CONTROL_TYPE, $vValue) Or $vValue <> $iControlType Then Return False
    EndIf
    If $sAutomationId <> "" Then
        If Not __SandiUIA_Property($oElement, $__SANDI_UIA_AUTOMATION_ID, $vValue) Or $vValue <> $sAutomationId Then Return False
    EndIf
    If $sName <> "" Then
        If Not __SandiUIA_Property($oElement, $__SANDI_UIA_NAME, $vValue) Or $vValue <> $sName Then Return False
    EndIf
    If $sClassName <> "" Then
        If Not __SandiUIA_Property($oElement, $__SANDI_UIA_CLASS_NAME, $vValue) Or $vValue <> $sClassName Then Return False
    EndIf
    Return True
EndFunc

Func __SandiUIA_PathCanContain($sTargetPath, $sElementPath)
    If $sTargetPath = "" Then Return True
    Return StringLeft($sTargetPath, StringLen($sElementPath) + 1) = $sElementPath & "/"
EndFunc

Func __SandiUIA_Property($oElement, $iPropertyId, ByRef $vValue)
    Local $iHr = $oElement.GetCurrentPropertyValue($iPropertyId, $vValue)
    If $iHr <> 0 Then Return SetError($SANDI_UIA_ERROR_COM, $iHr, False)
    Return True
EndFunc

Func __SandiUIA_ElementText($oElement)
    If Not IsObj($oElement) Then Return "<unavailable>"
    Local $vAutomationId = ""
    Local $vControlType = 0
    Local $vName = ""
    Local $vClassName = ""
    Local $vPid = 0
    Local $vHWnd = 0
    If Not __SandiUIA_Property($oElement, $__SANDI_UIA_AUTOMATION_ID, $vAutomationId) Or _
            Not __SandiUIA_Property($oElement, $__SANDI_UIA_CONTROL_TYPE, $vControlType) Or _
            Not __SandiUIA_Property($oElement, $__SANDI_UIA_NAME, $vName) Or _
            Not __SandiUIA_Property($oElement, $__SANDI_UIA_CLASS_NAME, $vClassName) Or _
            Not __SandiUIA_Property($oElement, $__SANDI_UIA_PROCESS_ID, $vPid) Or _
            Not __SandiUIA_Property($oElement, $__SANDI_UIA_NATIVE_WINDOW_HANDLE, $vHWnd) Then Return "<property unavailable>"
    Return "{automationId=""" & __SandiUIA_Clean($vAutomationId) & _
            """, controlType=" & $vControlType & _
            ", name=""" & __SandiUIA_Clean($vName) & _
            """, class=""" & __SandiUIA_Clean($vClassName) & _
            """, pid=" & $vPid & ", hwnd=" & $vHWnd & "}"
EndFunc

Func __SandiUIA_ElementJson($oElement, $sPath)
    Local $vAutomationId = ""
    Local $vControlType = 0
    Local $vName = ""
    Local $vClassName = ""
    Local $vHWnd = 0
    If Not __SandiUIA_Property($oElement, $__SANDI_UIA_AUTOMATION_ID, $vAutomationId) Or _
            Not __SandiUIA_Property($oElement, $__SANDI_UIA_CONTROL_TYPE, $vControlType) Or _
            Not __SandiUIA_Property($oElement, $__SANDI_UIA_NAME, $vName) Or _
            Not __SandiUIA_Property($oElement, $__SANDI_UIA_CLASS_NAME, $vClassName) Or _
            Not __SandiUIA_Property($oElement, $__SANDI_UIA_NATIVE_WINDOW_HANDLE, $vHWnd) Then _
            Return SetError($SANDI_UIA_ERROR_COM, @extended, "")
    Local $sPatterns = ""
    Local $sActions = ""
    __SandiUIA_Capabilities($oElement, $sPatterns, $sActions)
    Return "{" & _
            '"identity":{"automationId":' & __SandiUIA_JsonString($vAutomationId) & _
            ',"controlType":' & $vControlType & ',"name":' & __SandiUIA_JsonString($vName) & _
            ',"className":' & __SandiUIA_JsonString($vClassName) & _
            ',"path":' & __SandiUIA_JsonString($sPath) & "}," & _
            '"automationId":' & __SandiUIA_JsonString($vAutomationId) & _
            ',"controlType":' & $vControlType & _
            ',"controlTypeName":' & __SandiUIA_JsonString(__SandiUIA_ControlTypeName($vControlType)) & _
            ',"name":' & __SandiUIA_JsonString($vName) & _
            ',"className":' & __SandiUIA_JsonString($vClassName) & _
            ',"nativeHwnd":' & Number($vHWnd) & _
            ',"patterns":' & $sPatterns & ',"actions":' & $sActions & "}"
EndFunc

Func __SandiUIA_Capabilities($oElement, ByRef $sPatterns, ByRef $sActions)
    $sPatterns = "["
    $sActions = '["Describe"'
    Local $bHasPattern = False
    Local $bCanInsert = False
    Local $oPattern = __SandiUIA_Pattern($oElement, $__SANDI_UIA_INVOKE_PATTERN)
    If Not @error And IsObj($oPattern) Then
        __SandiUIA_JsonAppend($sPatterns, "Invoke", $bHasPattern)
        $sActions &= ',"Invoke"'
    EndIf
    $oPattern = __SandiUIA_Pattern($oElement, $__SANDI_UIA_VALUE_PATTERN)
    If Not @error And IsObj($oPattern) Then
        __SandiUIA_JsonAppend($sPatterns, "Value", $bHasPattern)
        $sActions &= ',"GetValue"'
        Local $bReadOnly = 1
        If $oPattern.CurrentIsReadOnly($bReadOnly) = 0 And Not $bReadOnly Then
            $sActions &= ',"SetValue"'
            $bCanInsert = True
        EndIf
    EndIf
    $oPattern = __SandiUIA_Pattern($oElement, $__SANDI_UIA_SELECTION_ITEM_PATTERN)
    If Not @error And IsObj($oPattern) Then
        __SandiUIA_JsonAppend($sPatterns, "SelectionItem", $bHasPattern)
        $sActions &= ',"Select"'
    EndIf
    $oPattern = __SandiUIA_Pattern($oElement, $__SANDI_UIA_TOGGLE_PATTERN)
    If Not @error And IsObj($oPattern) Then
        __SandiUIA_JsonAppend($sPatterns, "Toggle", $bHasPattern)
        $sActions &= ',"Toggle"'
    EndIf
    Local $pTextPattern = 0
    Local $iTextHr = $oElement.GetCurrentPattern($__SANDI_EDITOR_TEXT_PATTERN, $pTextPattern)
    If $iTextHr = 0 And $pTextPattern Then
        __SandiEditor_ReleaseCom($pTextPattern)
        __SandiUIA_JsonAppend($sPatterns, "Text", $bHasPattern)
        Local $vTextControlType = 0
        If __SandiUIA_Property($oElement, $__SANDI_UIA_CONTROL_TYPE, $vTextControlType) And _
                ($vTextControlType = $SANDI_UIA_EDIT Or $vTextControlType = $SANDI_UIA_DOCUMENT Or _
                $vTextControlType = $SANDI_UIA_CUSTOM) Then $bCanInsert = True
    EndIf
    If $bCanInsert Then $sActions &= ',"InsertText"'
    $sPatterns &= "]"
    $sActions &= "]"
EndFunc

Func __SandiUIA_JsonAppend(ByRef $sJson, $sValue, ByRef $bHasValue)
    If $bHasValue Then $sJson &= ","
    $sJson &= __SandiUIA_JsonString($sValue)
    $bHasValue = True
EndFunc

Func __SandiUIA_ControlTypeName($iControlType)
    Switch $iControlType
        Case 50000
            Return "Button"
        Case 50001
            Return "Calendar"
        Case 50002
            Return "CheckBox"
        Case 50003
            Return "ComboBox"
        Case 50004
            Return "Edit"
        Case 50005
            Return "Hyperlink"
        Case 50006
            Return "Image"
        Case 50007
            Return "ListItem"
        Case 50008
            Return "List"
        Case 50009
            Return "Menu"
        Case 50010
            Return "MenuBar"
        Case 50011
            Return "MenuItem"
        Case 50012
            Return "ProgressBar"
        Case 50013
            Return "RadioButton"
        Case 50014
            Return "ScrollBar"
        Case 50015
            Return "Slider"
        Case 50016
            Return "Spinner"
        Case 50017
            Return "StatusBar"
        Case 50018
            Return "Tab"
        Case 50019
            Return "TabItem"
        Case 50020
            Return "Text"
        Case 50021
            Return "ToolBar"
        Case 50022
            Return "ToolTip"
        Case 50023
            Return "Tree"
        Case 50024
            Return "TreeItem"
        Case 50025
            Return "Custom"
        Case 50026
            Return "Group"
        Case 50027
            Return "Thumb"
        Case 50028
            Return "DataGrid"
        Case 50029
            Return "DataItem"
        Case 50030
            Return "Document"
        Case 50031
            Return "SplitButton"
        Case 50032
            Return "Window"
        Case 50033
            Return "Pane"
        Case 50034
            Return "Header"
        Case 50035
            Return "HeaderItem"
        Case 50036
            Return "Table"
        Case 50037
            Return "TitleBar"
        Case 50038
            Return "Separator"
        Case 50039
            Return "SemanticZoom"
        Case 50040
            Return "AppBar"
    EndSwitch
    Return "Unknown"
EndFunc

Func __SandiUIA_JsonBoolean($bValue)
    If $bValue Then Return "true"
    Return "false"
EndFunc

Func __SandiUIA_JsonString($vValue)
    Local $sValue = String($vValue)
    Local $sJson = '"'
    For $iIndex = 1 To StringLen($sValue)
        Local $sCharacter = StringMid($sValue, $iIndex, 1)
        Local $iCode = AscW($sCharacter)
        Switch $iCode
            Case 8
                $sJson &= "\b"
            Case 9
                $sJson &= "\t"
            Case 10
                $sJson &= "\n"
            Case 12
                $sJson &= "\f"
            Case 13
                $sJson &= "\r"
            Case 34
                $sJson &= '\"'
            Case 92
                $sJson &= "\\"
            Case 0 To 31
                $sJson &= "\u" & Hex($iCode, 4)
            Case Else
                $sJson &= $sCharacter
        EndSwitch
    Next
    Return $sJson & '"'
EndFunc

Func __SandiUIA_SelectorText($sAutomationId, $iControlType, $sName)
    Return "automationId=""" & __SandiUIA_Clean($sAutomationId) & _
            """, controlType=" & $iControlType & ", name=""" & __SandiUIA_Clean($sName) & """"
EndFunc

Func __SandiUIA_StringCandidates(ByRef $aCandidates, $iCount)
    If $iCount = 0 Then Return "<none>"
    Local $sText = ""
    For $iIndex = 0 To $iCount - 1
        If $iIndex > 0 Then $sText &= " | "
        $sText &= $aCandidates[$iIndex]
    Next
    Return $sText
EndFunc

Func __SandiUIA_Clean($vValue)
    Local $sValue = String($vValue)
    $sValue = StringReplace($sValue, @CR, " ")
    $sValue = StringReplace($sValue, @LF, " ")
    Return StringReplace($sValue, '"', "'")
EndFunc

Func __SandiUIA_FocusedMatches($hWnd, $iPid, $sAutomationId, $iControlType, $sName, _
        $sClassName = "", $sPath = "")
    Local $oExpected = SandiUIA_Find($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $sClassName, $sPath)
    If @error Then Return False
    Local $pFocused = 0
    Local $iHr = $__g_SandiUIA.GetFocusedElement($pFocused)
    If $iHr <> 0 Or Not $pFocused Then Return False
    Local $oFocused = ObjCreateInterface($pFocused, $__SANDI_IID_ELEMENT, $__SANDI_TAG_ELEMENT)
    If Not IsObj($oFocused) Then Return False
    Local $vHasFocus = 0
    If Not __SandiUIA_Property($oFocused, $__SANDI_UIA_HAS_KEYBOARD_FOCUS, $vHasFocus) Or Not $vHasFocus Then Return False
    Local $pExpectedRuntimeId = 0
    $iHr = $oExpected.GetRuntimeId($pExpectedRuntimeId)
    If $iHr <> 0 Or Not $pExpectedRuntimeId Then Return False
    Local $pFocusedRuntimeId = 0
    $iHr = $oFocused.GetRuntimeId($pFocusedRuntimeId)
    If $iHr <> 0 Or Not $pFocusedRuntimeId Then
        __SandiUIA_DestroySafeArray($pExpectedRuntimeId)
        Return False
    EndIf
    Local $bSame = 0
    $iHr = $__g_SandiUIA.CompareRuntimeIds($pExpectedRuntimeId, $pFocusedRuntimeId, $bSame)
    __SandiUIA_DestroySafeArray($pExpectedRuntimeId)
    __SandiUIA_DestroySafeArray($pFocusedRuntimeId)
    If $iHr <> 0 Or Not $bSame Then ConsoleWriteError("SandiUIA: focused target mismatch; expected=" & _
            __SandiUIA_ElementText($oExpected) & "; focused=" & __SandiUIA_ElementText($oFocused) & _
            "; hresult=" & $iHr & @CRLF)
    Return $iHr = 0 And $bSame
EndFunc

Func __SandiUIA_DestroySafeArray($pSafeArray)
    If $pSafeArray Then DllCall("oleaut32.dll", "long", "SafeArrayDestroy", "ptr", $pSafeArray)
EndFunc

Func __SandiInput_Begin($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $bRequireFocus, _
        $sClassName = "", $sPath = "")
    If $__g_SandiInputBlocked Then Return SetError($SANDI_INPUT_ERROR_BUSY, 0, False)
    If Not BlockInput($BI_DISABLE) Then Return SetError($SANDI_INPUT_ERROR_BLOCK, 0, False)
    $__g_SandiInputBlocked = True
    If Not __SandiInput_Valid($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $bRequireFocus, $sClassName, $sPath) Then
        __SandiInput_Release()
        Return SetError($SANDI_INPUT_ERROR_TARGET, 0, False)
    EndIf
    Return True
EndFunc

Func __SandiInput_Valid($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $bRequireFocus, _
        $sClassName = "", $sPath = "")
    $hWnd = HWnd($hWnd)
    If $hWnd = 0 Or Not WinExists($hWnd) Or WinGetProcess($hWnd) <> $iPid Then Return False
    If WinGetHandle("[ACTIVE]") <> $hWnd Then Return False
    If Not $bRequireFocus Then Return True
    Return __SandiUIA_FocusedMatches($hWnd, $iPid, $sAutomationId, $iControlType, $sName, $sClassName, $sPath)
EndFunc

Func __SandiInput_PointInWindow($hWnd, $iX, $iY)
    Local $aPosition = WinGetPos(HWnd($hWnd))
    If @error Then Return False
    Return $iX >= $aPosition[0] And $iY >= $aPosition[1] And _
            $iX < $aPosition[0] + $aPosition[2] And $iY < $aPosition[1] + $aPosition[3]
EndFunc

Func __SandiInput_ButtonValid($sButton)
    Return $sButton = "left" Or $sButton = "right" Or $sButton = "middle"
EndFunc

Func __SandiInput_Release()
    Local $bClipboardRestored = __SandiEditor_RestoreClipboard()
    Local $iClipboardError = @error
    __SandiInput_ReleaseModifiers()
    If $__g_SandiInputMouseButton <> "" Then MouseUp($__g_SandiInputMouseButton)
    $__g_SandiInputMouseButton = ""
    If $__g_SandiInputBlocked Then BlockInput($BI_ENABLE)
    $__g_SandiInputBlocked = False
    Return SetError($iClipboardError, 0, $bClipboardRestored)
EndFunc

Func __SandiInput_ReleaseModifiers()
    Local $aVirtualKeys[5] = [0x10, 0x11, 0x12, 0x5B, 0x5C]
    For $iIndex = 0 To UBound($aVirtualKeys) - 1
        DllCall("user32.dll", "none", "keybd_event", "byte", $aVirtualKeys[$iIndex], "byte", 0, "dword", 2, "ulong_ptr", 0)
    Next
EndFunc

#include "SandiEditor.au3"
#include "SandiVisual.au3"
