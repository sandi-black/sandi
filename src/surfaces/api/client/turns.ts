import { z } from "zod/v4";
import { type JsonResponse, postJson } from "@/surfaces/api/client/http";

// The api surface answers a completed turn with the conversation id and the
// assistant's full response text. The desktop streams the response live over its
// device link while the turn runs; this final body is the authoritative record
// it reconciles against once the turn settles.
const TurnResponseSchema = z.object({
  conversationId: z.string().min(1),
  text: z.string(),
});

// A turn runs the model to completion server-side, which can take minutes. The
// default postJson timeout (30s) is for short control calls; a turn needs far
// longer before the silence means a dead connection rather than a thinking
// model.
const TURN_TIMEOUT_MS = 15 * 60_000;

export type TurnOutcome =
  | { ok: true; conversationId: string; text: string }
  | { ok: false; error: string };

// Posts one turn to a conversation and returns the final response. The live
// token-by-token stream arrives separately over the device link; this is the
// blocking call that resolves when the turn is complete.
export async function sendTurn(input: {
  url: string;
  token: string;
  conversationId: string;
  input: string;
  // A client-generated id correlating this turn's streamed deltas. Sent so the
  // server tags the stream with it and the REPL can bind its live preview to the
  // right turn, ignoring a straggler from a prior one.
  turnId?: string;
  signal?: AbortSignal;
}): Promise<TurnOutcome> {
  let response: JsonResponse;
  try {
    response = await postJson({
      url: input.url,
      path: `/v1/conversations/${encodeURIComponent(input.conversationId)}/turns`,
      token: input.token,
      body: {
        input: input.input,
        ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      },
      timeoutMs: TURN_TIMEOUT_MS,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      error: `could not reach ${input.url}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, error: describeTurnError(response) };
  }
  const parsed = TurnResponseSchema.safeParse(response.body);
  if (!parsed.success) {
    return { ok: false, error: "server returned an unexpected turn response" };
  }
  return {
    ok: true,
    conversationId: parsed.data.conversationId,
    text: parsed.data.text,
  };
}

const TurnErrorSchema = z.object({ error: z.string() });

function describeTurnError(response: JsonResponse): string {
  const parsed = TurnErrorSchema.safeParse(response.body);
  const code = parsed.success ? parsed.data.error : undefined;
  if (response.status === 401) {
    return "the device token was rejected; re-pair with a fresh /sandi auth code";
  }
  if (response.status === 403) {
    return "your identity is no longer mapped to a Discord or GitHub account";
  }
  if (response.status === 429) {
    return "too many turns in flight; wait a moment and try again";
  }
  return `turn failed (status ${response.status}${code ? `: ${code}` : ""})`;
}

// Decides what still needs printing once a turn settles, given the text already
// streamed live. The normal case streams the whole answer, so nothing is left;
// but the child can exit before its last deltas flush, so the final body fills
// in any missing tail. Pure and exported for tests.
//
// - Nothing streamed: print the whole final text.
// - Final extends what streamed: print only the missing suffix.
// - Streamed already covers the final (it ran ahead, or only trailing
//   whitespace differs): print nothing.
// - The two diverge: fall back to the authoritative final on a fresh line, so
//   the complete response is always shown even if the live preview was wrong.
export function reconcileSuffix(streamed: string, final: string): string {
  if (streamed.length === 0) return final;
  if (final.startsWith(streamed)) return final.slice(streamed.length);
  if (streamed.startsWith(final)) return "";
  if (streamed.trim() === final.trim()) return "";
  return `\n${final}`;
}
