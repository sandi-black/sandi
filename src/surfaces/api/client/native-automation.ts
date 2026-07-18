import { z } from "zod/v4";
import type { LocalScriptRuntimeContext } from "@/surfaces/api/client/local-script-runtimes";
import { runGeneratedAutoIt } from "@/surfaces/api/client/local-script-runtimes";
import {
  isFreshVisualObservation,
  MAX_VISUAL_OBSERVATION_AGE_MS,
} from "@/surfaces/api/client/visual-observation";
import type {
  LocalNativeParams,
  ToolCallOutcome,
} from "@/surfaces/api/devices/protocol";

const RESULT_PREFIX = "SANDI_NATIVE_RESULT:";
const PAYLOAD_FILE = "payload.txt";

const NativeErrorCodeSchema = z.enum([
  "no_match",
  "ambiguity",
  "stale_target",
  "unsupported_pattern",
  "cancelled",
  "timeout",
  "verification_failure",
  "execution_failure",
]);

const NativeScriptResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    action: z.string(),
    data: z.unknown(),
  }),
  z.object({
    status: z.literal("error"),
    action: z.string(),
    error: z.object({
      code: NativeErrorCodeSchema,
      facadeCode: z.number().int(),
      extended: z.number().int(),
    }),
  }),
]);

const RawInspectionSchema = z
  .object({
    root: z.object({ pid: z.number().int().positive(), hwnd: z.number() }),
    elements: z.array(
      z
        .object({
          identity: z.object({
            automationId: z.string(),
            controlType: z.number().int().positive(),
            name: z.string(),
            className: z.string(),
            path: z.string(),
          }),
        })
        .loose(),
    ),
  })
  .loose();

const NativeDataSchemas = {
  describe: z.object({ summary: z.string() }),
  get_value: z.object({ value: z.string() }),
  set_value: z.object({
    mutated: z.literal(true),
    verification: z.literal("verified"),
  }),
  insert_text: z.object({
    mutated: z.literal(true),
    preActionTarget: z.literal("revalidated"),
    verification: z.literal("observe_next"),
    submitted: z.literal(false),
  }),
  invoke: observeNextMutationSchema(),
  toggle: observeNextMutationSchema(),
  select: observeNextMutationSchema(),
  visual_click: observeNextMutationSchema(),
  wait_value: z.object({ verified: z.literal(true) }),
  wait_window: z.object({
    verified: z.literal(true),
    state: z.enum(["exists", "closed"]),
  }),
};

const ERROR_MESSAGES: Readonly<
  Record<z.infer<typeof NativeErrorCodeSchema>, string>
> = {
  no_match: "no control matched the retained identity",
  ambiguity: "the retained control identity matched more than one control",
  stale_target: "the retained window or control identity is stale",
  unsupported_pattern: "the retained control does not support this action",
  cancelled: "native automation was cancelled",
  timeout: "native automation timed out",
  verification_failure: "the requested native state was not verified",
  execution_failure: "the generated native automation artifact failed",
};

export async function runLocalNative(
  params: LocalNativeParams,
  rootDir: string,
  runtimes: LocalScriptRuntimeContext,
  signal?: AbortSignal,
): Promise<ToolCallOutcome> {
  if (
    params.action === "visual_click" &&
    !isFreshVisualObservation(params.visualObservation)
  ) {
    return nativeErrorOutcome(params.action, "stale_target", {
      ok: true,
      content: [],
    });
  }
  const generated = generateNativeAutoIt(params);
  const raw = await runGeneratedAutoIt(
    {
      code: generated.code,
      ...(generated.payload !== undefined
        ? { files: { [PAYLOAD_FILE]: generated.payload } }
        : {}),
      ...(generated.processTimeoutMs !== undefined
        ? { timeoutMs: generated.processTimeoutMs }
        : {}),
    },
    rootDir,
    runtimes,
    signal,
  );
  return nativeResultOutcome(params, raw);
}

export function generateNativeAutoIt(params: LocalNativeParams): {
  code: string;
  payload?: string;
  processTimeoutMs?: number;
} {
  const lines = [
    "#include <SandiAutoIt.au3>",
    "#include <FileConstants.au3>",
    ...(params.action === "visual_click" ? ["#include <Date.au3>"] : []),
    "",
    nativeResultHelpers(params.action === "visual_click"),
    "",
  ];
  let payload: string | undefined;
  let processTimeoutMs: number | undefined;

  switch (params.action) {
    case "inspect": {
      const filters = params.filters ?? {};
      lines.push(
        `Local $sResult = SandiUIA_Inspect(${windowArgs(params.window)}, ${autoItString(filters.automationId ?? "")}, ${filters.controlType ?? 0}, ${autoItString(filters.name ?? "")}, ${autoItString(filters.className ?? "")}, ${params.includeDocumentChildren === true ? "True" : "False"}, ${params.maxNodes ?? 64}, ${params.maxResults ?? 32})`,
        'If @error Then _SandiNativeFail("inspect", @error, @extended)',
        '_SandiNativeOk("inspect", $sResult)',
      );
      break;
    }
    case "describe":
    case "get_value":
    case "invoke":
    case "toggle":
    case "select": {
      const facade = {
        describe: "SandiUIA_Describe",
        get_value: "SandiUIA_GetValue",
        invoke: "SandiUIA_Invoke",
        toggle: "SandiUIA_Toggle",
        select: "SandiUIA_Select",
      }[params.action];
      lines.push(`Local $vResult = ${facade}(${targetArgs(params.target)})`);
      lines.push(
        `If @error Then _SandiNativeFail(${autoItString(params.action)}, @error, @extended)`,
      );
      if (params.action === "describe" || params.action === "get_value") {
        const key = params.action === "describe" ? "summary" : "value";
        lines.push(
          `_SandiNativeOk(${autoItString(params.action)}, '{"${key}":' & _SandiNativeJsonString(String($vResult)) & '}')`,
        );
      } else {
        lines.push(
          `_SandiNativeOk(${autoItString(params.action)}, '{"mutated":true,"verification":"observe_next"}')`,
        );
      }
      break;
    }
    case "set_value": {
      payload = params.value;
      lines.push(
        "Local $sPayload = _SandiNativeReadPayload()",
        'If @error Then _SandiNativeFail("set_value", 0, @extended, "execution_failure")',
        `Local $bChanged = SandiUIA_SetValue(${targetValueArgs(params.target, "$sPayload")})`,
        'If @error Then _SandiNativeFail("set_value", @error, @extended)',
        `Local $sActual = SandiUIA_GetValue(${targetArgs(params.target)})`,
        'If @error Then _SandiNativeFail("set_value", @error, @extended)',
        'If $sActual <> $sPayload Then _SandiNativeFail("set_value", 0, 0, "verification_failure")',
        '_SandiNativeOk("set_value", \'{"mutated":true,"verification":"verified"}\')',
      );
      break;
    }
    case "insert_text": {
      payload = params.text;
      lines.push(
        "Local $sPayload = _SandiNativeReadPayload()",
        'If @error Then _SandiNativeFail("insert_text", 0, @extended, "execution_failure")',
        `Local $bInserted = SandiEditor_InsertText(${targetValueArgs(params.target, "$sPayload")})`,
        'If @error Then _SandiNativeFail("insert_text", @error, @extended)',
        '_SandiNativeOk("insert_text", \'{"mutated":true,"preActionTarget":"revalidated","verification":"observe_next","submitted":false}\')',
      );
      break;
    }
    case "wait_value": {
      payload = params.value;
      processTimeoutMs = params.timeoutMs + 5_000;
      lines.push(
        "Local $sExpected = _SandiNativeReadPayload()",
        'If @error Then _SandiNativeFail("wait_value", 0, @extended, "execution_failure")',
        "Local $hTimer = TimerInit()",
        "While True",
        `    Local $sActual = SandiUIA_GetValue(${targetArgs(params.target)})`,
        '    If @error Then _SandiNativeFail("wait_value", @error, @extended)',
        '    If $sActual = $sExpected Then _SandiNativeOk("wait_value", \'{"verified":true}\')',
        `    If TimerDiff($hTimer) >= ${params.timeoutMs} Then _SandiNativeFail("wait_value", 0, 0, "verification_failure")`,
        "    Sleep(100)",
        "WEnd",
      );
      break;
    }
    case "wait_window": {
      processTimeoutMs = params.timeoutMs + 5_000;
      const valid = `WinExists(HWnd(${autoItString(params.window.hwnd)})) And WinGetProcess(HWnd(${autoItString(params.window.hwnd)})) = ${params.window.pid}`;
      const condition = params.state === "exists" ? valid : `Not (${valid})`;
      lines.push(
        "Local $hTimer = TimerInit()",
        "While True",
        `    If ${condition} Then _SandiNativeOk("wait_window", '{"verified":true,"state":${autoItString(params.state)}}')`,
        `    If TimerDiff($hTimer) >= ${params.timeoutMs} Then _SandiNativeFail("wait_window", 0, 0, "verification_failure")`,
        "    Sleep(100)",
        "WEnd",
      );
      break;
    }
    case "visual_click": {
      const observation = params.visualObservation;
      lines.push(
        "Local $iNowMs = _SandiNativeUnixTimeMs()",
        `If @error Or $iNowMs < ${observation.capturedAtMs} Or $iNowMs - ${observation.capturedAtMs} > ${MAX_VISUAL_OBSERVATION_AGE_MS} Then _SandiNativeFail("visual_click", 0, 0, "stale_target")`,
        `Local $bClicked = SandiVisual_Click(${windowArgs(observation.target)}, ${params.x}, ${params.y}, ${observation.active ? "True" : "False"}, ${observation.clientRect.x}, ${observation.clientRect.y}, ${observation.clientRect.width}, ${observation.clientRect.height}, ${observation.clientOriginScreen.x}, ${observation.clientOriginScreen.y}, ${observation.dpi}, ${observation.screenshot.width}, ${observation.screenshot.height})`,
        'If @error Then _SandiNativeFail("visual_click", @error, @extended)',
        '_SandiNativeOk("visual_click", \'{"mutated":true,"verification":"observe_next"}\')',
      );
      break;
    }
  }

  return {
    code: lines.join("\n"),
    ...(payload !== undefined ? { payload } : {}),
    ...(processTimeoutMs !== undefined ? { processTimeoutMs } : {}),
  };
}

function nativeResultOutcome(
  params: LocalNativeParams,
  raw: ToolCallOutcome,
): ToolCallOutcome {
  if (!raw.ok && raw.error === "cancelled") {
    return nativeErrorOutcome(params.action, "cancelled", raw);
  }
  if (raw.structuredContent?.["timedOut"] === true) {
    return nativeErrorOutcome(params.action, "timeout", raw);
  }
  const marker = textContent(raw)
    .split(/\r?\n/)
    .find((line) => line.startsWith(RESULT_PREFIX));
  if (marker === undefined) {
    return nativeErrorOutcome(params.action, "execution_failure", raw);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(marker.slice(RESULT_PREFIX.length));
  } catch {
    return nativeErrorOutcome(params.action, "execution_failure", raw);
  }
  const parsed = NativeScriptResultSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.action !== params.action) {
    return nativeErrorOutcome(params.action, "execution_failure", raw);
  }
  if (parsed.data.status === "error") {
    return nativeErrorOutcome(
      params.action,
      parsed.data.error.code,
      raw,
      parsed.data.error.facadeCode,
      parsed.data.error.extended,
    );
  }
  const normalized = normalizeNativeData(params, parsed.data.data);
  if (!normalized.success) {
    return nativeErrorOutcome(params.action, "execution_failure", raw);
  }
  const data = normalized.data;
  return {
    ok: true,
    content: [
      {
        type: "text",
        text: `${params.action} completed\n${JSON.stringify(data)}`,
      },
    ],
    structuredContent: {
      nativeAutomation: {
        version: 1,
        action: params.action,
        status: "ok",
        data,
      },
    },
  };
}

function normalizeNativeData(
  params: LocalNativeParams,
  data: unknown,
): { success: true; data: unknown } | { success: false } {
  if (params.action === "inspect") {
    const parsed = RawInspectionSchema.safeParse(data);
    if (!parsed.success) return { success: false };
    return {
      success: true,
      data: {
        ...parsed.data,
        root: { hwnd: params.window.hwnd, pid: params.window.pid },
        elements: parsed.data.elements.map((element) => ({
          ...element,
          identity: {
            hwnd: params.window.hwnd,
            pid: params.window.pid,
            ...element.identity,
          },
        })),
      },
    };
  }
  const schema = NativeDataSchemas[params.action];
  const parsed = schema.safeParse(data);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false };
}

function nativeErrorOutcome(
  action: LocalNativeParams["action"],
  code: z.infer<typeof NativeErrorCodeSchema>,
  raw: ToolCallOutcome,
  facadeCode = 0,
  extended = 0,
): ToolCallOutcome {
  return {
    ok: true,
    isError: true,
    content: [{ type: "text", text: `${code}: ${ERROR_MESSAGES[code]}` }],
    structuredContent: {
      nativeAutomation: {
        version: 1,
        action,
        status: "error",
        error: {
          code,
          message: ERROR_MESSAGES[code],
          facadeCode,
          extended,
        },
      },
      runtime: raw.structuredContent ?? {},
    },
  };
}

function targetArgs(target: {
  hwnd: string;
  pid: number;
  automationId: string;
  controlType: number;
  name: string;
  className: string;
  path: string;
}): string {
  return [
    `HWnd(${autoItString(target.hwnd)})`,
    String(target.pid),
    autoItString(target.automationId),
    String(target.controlType),
    autoItString(target.name),
    autoItString(target.className),
    autoItString(target.path),
  ].join(", ");
}

function targetValueArgs(
  target: {
    hwnd: string;
    pid: number;
    automationId: string;
    controlType: number;
    name: string;
    className: string;
    path: string;
  },
  valueExpression: string,
): string {
  return [
    `HWnd(${autoItString(target.hwnd)})`,
    String(target.pid),
    autoItString(target.automationId),
    String(target.controlType),
    autoItString(target.name),
    valueExpression,
    autoItString(target.className),
    autoItString(target.path),
  ].join(", ");
}

function windowArgs(window: { hwnd: string; pid: number }): string {
  return `HWnd(${autoItString(window.hwnd)}), ${window.pid}`;
}

function autoItString(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function textContent(outcome: ToolCallOutcome): string {
  return outcome.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function nativeResultHelpers(includeClock: boolean): string {
  const helpers = String.raw`Func _SandiNativeReadPayload()
    Local $hPayload = FileOpen(@ScriptDir & "\payload.txt", $FO_READ + $FO_UTF8_NOBOM)
    If $hPayload = -1 Then Return SetError(1, 0, "")
    Local $sPayload = FileRead($hPayload)
    Local $iError = @error
    FileClose($hPayload)
    If $iError Then Return SetError(1, $iError, "")
    Return $sPayload
EndFunc

Func _SandiNativeOk($sAction, $sDataJson)
    ConsoleWrite("SANDI_NATIVE_RESULT:" & '{"status":"ok","action":' & _SandiNativeJsonString($sAction) & ',"data":' & $sDataJson & '}' & @CRLF)
    Exit 0
EndFunc

Func _SandiNativeFail($sAction, $iFacadeCode, $iExtended, $sForcedCode = "")
    Local $sCode = $sForcedCode
    If $sCode = "" Then
        Switch $iFacadeCode
            Case $SANDI_UIA_ERROR_NOT_FOUND
                $sCode = "no_match"
            Case $SANDI_UIA_ERROR_AMBIGUOUS
                $sCode = "ambiguity"
            Case $SANDI_UIA_ERROR_ROOT, $SANDI_EDITOR_ERROR_TARGET, $SANDI_INPUT_ERROR_TARGET, $SANDI_VISUAL_ERROR_TARGET, $SANDI_VISUAL_ERROR_GEOMETRY
                $sCode = "stale_target"
            Case $SANDI_UIA_ERROR_PATTERN, $SANDI_EDITOR_ERROR_UNSUPPORTED
                $sCode = "unsupported_pattern"
            Case $SANDI_EDITOR_ERROR_TIMEOUT
                $sCode = "timeout"
            Case Else
                $sCode = "execution_failure"
        EndSwitch
    EndIf
    ConsoleWrite("SANDI_NATIVE_RESULT:" & '{"status":"error","action":' & _SandiNativeJsonString($sAction) & ',"error":{"code":' & _SandiNativeJsonString($sCode) & ',"facadeCode":' & $iFacadeCode & ',"extended":' & $iExtended & '}}' & @CRLF)
    Exit 10
EndFunc

Func _SandiNativeJsonString($sValue)
    Local $sJson = '"'
    For $iIndex = 1 To StringLen($sValue)
        Local $sChar = StringMid($sValue, $iIndex, 1)
        Local $iCode = AscW($sChar)
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
                $sJson &= $sChar
        EndSwitch
    Next
    Return $sJson & '"'
EndFunc`;
  if (!includeClock) return helpers;
  return `${helpers}

Func _SandiNativeUnixTimeMs()
    Local $tFileTime = _Date_Time_GetSystemTimeAsFileTime()
    If @error Then Return SetError(1, @extended, 0)
    Local $nTicks = (DllStructGetData($tFileTime, "Hi") * 4294967296) + DllStructGetData($tFileTime, "Lo")
    Return Int(($nTicks / 10000) - 11644473600000)
EndFunc`;
}

function observeNextMutationSchema() {
  return z.object({
    mutated: z.literal(true),
    verification: z.literal("observe_next"),
  });
}
