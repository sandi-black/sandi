import { hostname } from "node:os";

import { z } from "zod/v4";
import type { DesktopCredentials } from "@/surfaces/api/client/credentials";
import { type JsonResponse, postJson } from "@/surfaces/api/client/http";

// The minted token is the api surface's hex secret (32 bytes -> 64 hex chars).
// Pin the shape so a malformed redemption response is rejected here rather than
// stored and failing later as a 401 on the first turn.
const PairResponseSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/, "must be a 64-character hex token"),
  deviceId: z.string().min(1),
  identityId: z.string().min(1),
  label: z.string().optional(),
});

// The api surface answers a failed request with `{ "error": "<code>" }`. Parse
// that shape rather than reaching into the body, so the error branch reads a
// validated code, not an ad hoc property probe.
const ApiErrorResponseSchema = z.object({ error: z.string() });

export type PairOutcome =
  | { ok: true; credentials: DesktopCredentials; label: string }
  | { ok: false; error: string };

// Redeems a pairing code from `/sandi auth` for a per-device token by calling
// the api surface's pairing endpoint, then returns the credentials to store.
export async function pairDesktop(input: {
  url: string;
  code: string;
  label?: string;
}): Promise<PairOutcome> {
  const label = input.label ?? hostname();
  let response: JsonResponse;
  try {
    response = await postJson({
      url: input.url,
      path: "/v1/auth/pair",
      body: { code: input.code, label },
    });
  } catch (error) {
    return {
      ok: false,
      error: `could not reach ${input.url}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.status !== 200) {
    return { ok: false, error: describePairError(response) };
  }
  const parsed = PairResponseSchema.safeParse(response.body);
  if (!parsed.success) {
    return {
      ok: false,
      error: "server returned an unexpected pairing response",
    };
  }
  return {
    ok: true,
    label: parsed.data.label ?? label,
    credentials: {
      url: input.url,
      token: parsed.data.token,
      deviceId: parsed.data.deviceId,
      identityId: parsed.data.identityId,
    },
  };
}

function describePairError(response: JsonResponse): string {
  const parsed = ApiErrorResponseSchema.safeParse(response.body);
  const code = parsed.success ? parsed.data.error : undefined;
  if (response.status === 401 || code === "invalid_code") {
    return "the code is invalid or expired; run /sandi auth again for a fresh code";
  }
  if (response.status === 403) {
    return "your identity is no longer mapped to a Discord or GitHub account";
  }
  if (response.status === 429) {
    return "too many attempts; wait a moment and try again";
  }
  return `pairing failed (status ${response.status}${code ? `: ${code}` : ""})`;
}
