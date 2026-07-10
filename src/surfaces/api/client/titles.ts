import { z } from "zod/v4";
import { errorMessage } from "@/lib/errors";
import { type JsonResponse, postJson } from "@/surfaces/api/client/http";

// The api surface names a conversation from a single message and answers with
// the title. The desktop posts its opening message here and renames its local
// session from the reply, the same way the Discord surface names a new thread.
const TitleResponseSchema = z.object({ title: z.string() });

// A title turn is a low-effort one-off, but it is still a model call: give it
// more than the default 30s control-call budget without matching the full
// multi-minute turn budget, since a title that took this long is not worth
// waiting on.
const TITLE_TIMEOUT_MS = 90_000;

export type TitleOutcome =
  | { ok: true; title: string }
  | { ok: false; error: string };

// Asks the server to turn `message` into a short conversation title. Never
// throws: a transport error, timeout, non-2xx status, or unexpected body all
// resolve to `{ ok: false }` so the caller can simply leave the conversation
// untitled.
export async function generateTitle(input: {
  url: string;
  token: string;
  conversationId: string;
  message: string;
  signal?: AbortSignal;
}): Promise<TitleOutcome> {
  let response: JsonResponse;
  try {
    response = await postJson({
      url: input.url,
      path: `/v1/conversations/${encodeURIComponent(input.conversationId)}/title`,
      token: input.token,
      body: { message: input.message },
      timeoutMs: TITLE_TIMEOUT_MS,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      error: `could not reach ${input.url}: ${errorMessage(error)}`,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      error: `title request failed (status ${response.status})`,
    };
  }
  const parsed = TitleResponseSchema.safeParse(response.body);
  if (!parsed.success) {
    return { ok: false, error: "server returned an unexpected title response" };
  }
  return { ok: true, title: parsed.data.title };
}
