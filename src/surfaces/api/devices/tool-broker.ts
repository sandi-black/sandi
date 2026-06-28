import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { createLogger } from "@/lib/logging";
import {
  type DeviceRegistry,
  DeviceUnavailableError,
} from "@/surfaces/api/devices/device-registry";
import {
  type BrokerCall,
  BrokerCallSchema,
  ResponseChunkSchema,
  type ToolCallOutcome,
} from "@/surfaces/api/devices/protocol";
import { readJsonBody } from "@/surfaces/api/http/read-json-body";
import { bearerToken, sendJson } from "@/surfaces/api/http/respond";

const log = createLogger("api-tool-broker");

// Bound to loopback so the internal tool-call route is never reachable off-box,
// independent of whatever host the public API listener binds. The pi child Sandi
// spawns is the only client, and it reaches the broker over 127.0.0.1.
const LOOPBACK_HOST = "127.0.0.1";
const CALL_PATH = "/call";
const STREAM_PATH = "/stream";

// File writes carry their content in the call body, so the cap is generous;
// reads and shell output are capped on the desktop before they return.
const BROKER_MAX_BODY_BYTES = 8 * 1024 * 1024;
// A streamed response delta is one slice of generated text, far smaller than a
// file write, so its body is capped tighter.
const STREAM_MAX_BODY_BYTES = 1 * 1024 * 1024;
const BROKER_BODY_TIMEOUT_MS = 30_000;
const BROKER_HEADERS_TIMEOUT_MS = 10_000;

// 256-bit single-turn token. Combined with the loopback bind, guessing one is
// not a path an off-box attacker has; the token also scopes a call to exactly
// one device and one turn's abort signal.
const TOKEN_BYTES = 32;

type TurnBinding = {
  key: string;
  signal: AbortSignal;
  // The turn id this lease streams under, when the caller supplied one. The
  // streaming ingress rejects a delta tagged with any other turn id so a relay
  // is always scoped to the turn that leased the token. Absent for callers that
  // do not consume the stream (no client turn id), where the env turn id is
  // generated late and there is nothing to bind against.
  turnId?: string;
  // The identity that owns the leased desktop, resolved once at lease time. A
  // tool may target any of this identity's connected desktops; the selector is
  // resolved against this identity so a turn can never reach a desktop belonging
  // to someone else. Absent when the leased key was not a live link at lease
  // time, which leaves the turn able to use only its own desktop.
  identityId?: string;
  // Whether the leased key is the desktop the turn originated on (an api-surface
  // turn the desktop itself sent). When true, a call with no selector runs on
  // that desktop unconditionally: it is the machine the human is working at.
  // When false (a turn from Discord or GitHub, which has no originating device
  // and was bound to a guessed desktop), a call with no selector runs on the one
  // connected desktop if there is only one, but refuses and asks the model to
  // pick when several are connected, rather than guessing.
  originDevice?: boolean;
};

export type TurnBrokerTicket = {
  url: string;
  token: string;
};

export type TurnBrokerLease = {
  ticket: TurnBrokerTicket;
  // Drops the token so it cannot route another call. Called in the turn's
  // finally, so a token never outlives the turn that minted it.
  revoke(): void;
};

// A loopback HTTP server the pi child POSTs tool calls to. Each turn leases a
// token bound to the caller's device and abort signal; the broker authorizes a
// /call by that token and relays it to the device's SSE link through the shared
// DeviceRegistry. The broker holds no device sockets itself: it is the bridge
// from the in-process pi child back to the registry the public surface owns.
export class ToolBroker {
  readonly #registry: DeviceRegistry;
  readonly #turns = new Map<string, TurnBinding>();
  #server: Server | undefined;
  #url: string | undefined;

  constructor(registry: DeviceRegistry) {
    this.#registry = registry;
  }

  start(): Promise<void> {
    if (this.#server) return Promise.resolve();
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    server.headersTimeout = BROKER_HEADERS_TIMEOUT_MS;
    server.requestTimeout = BROKER_BODY_TIMEOUT_MS + 5_000;
    this.#server = server;
    return new Promise((resolveStart, rejectStart) => {
      const onError = (error: Error): void => rejectStart(error);
      server.once("error", onError);
      server.listen(0, LOOPBACK_HOST, () => {
        server.removeListener("error", onError);
        const address = server.address();
        if (address && typeof address === "object") {
          this.#url = `http://${LOOPBACK_HOST}:${address.port}`;
        }
        log.info("tool broker listening", { url: this.#url });
        resolveStart();
      });
    });
  }

  stop(): void {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    this.#url = undefined;
    this.#turns.clear();
    server.close();
    server.closeAllConnections?.();
  }

  url(): string | undefined {
    return this.#url;
  }

  // Leases a per-turn ticket: the loopback URL plus a single-turn token that
  // routes /call to one device link (by its opaque routing key) under one abort
  // signal.
  lease(input: {
    key: string;
    signal: AbortSignal;
    turnId?: string;
    // True when the leased key is the desktop the turn originated on (an
    // api-surface turn). Defaults to false for turns bound to a desktop by
    // identity (Discord, GitHub), which then ask the model to pick when the
    // human has several desktops connected rather than guessing one.
    originDevice?: boolean;
  }): TurnBrokerLease {
    const url = this.#url;
    if (!url) throw new Error("tool broker is not started");
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    // Resolve the owning identity now, while the leased link is live: a turn's
    // own desktop is connected at lease time, so this fixes the set of desktops
    // a later call may target even if the original link drops mid-turn.
    const identityId = this.#registry.identityForKey(input.key);
    this.#turns.set(token, {
      key: input.key,
      signal: input.signal,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(identityId !== undefined ? { identityId } : {}),
      ...(input.originDevice === true ? { originDevice: true } : {}),
    });
    return {
      ticket: { url, token },
      revoke: () => {
        this.#turns.delete(token);
      },
    };
  }

  // Answers local_list_desktops from the registry: the desktops this turn's
  // identity has connected, with the leased one marked current. Stays inside the
  // identity, so a turn only ever learns of its own desktops.
  #listDesktops(binding: TurnBinding): ToolCallOutcome {
    if (binding.identityId === undefined) {
      return {
        ok: true,
        output:
          "No connected desktops are addressable for this turn (its desktop link is not live).",
      };
    }
    const desktops = this.#registry.desktopsForIdentity(binding.identityId);
    if (desktops.length === 0) {
      return { ok: true, output: "No connected desktops." };
    }
    const lines = desktops.map((desktop) => {
      const current = desktop.key === binding.key ? "  (current)" : "";
      return `- id=${shortId(desktop.key)}  name=${JSON.stringify(desktop.deviceId)}${current}`;
    });
    const output = [
      `Connected desktops (${desktops.length}):`,
      ...lines,
      "",
      "Pass an id or name as the `desktop` argument to local_list_monitors, local_list_windows, or local_screenshot. Omit it to use the current desktop.",
    ].join("\n");
    return { ok: true, output };
  }

  // Resolves a `desktop` selector to a connected desktop of the binding's
  // identity, or undefined when nothing matches. Matches a short id first, then
  // a unique name; an ambiguous name (two desktops sharing one) resolves to
  // nothing so the caller is told to disambiguate by id rather than reaching an
  // arbitrary one.
  #resolveDesktop(binding: TurnBinding, selector: string): string | undefined {
    if (binding.identityId === undefined) return undefined;
    const desktops = this.#registry.desktopsForIdentity(binding.identityId);
    const norm = selector.trim().toLowerCase();
    const byId = desktops.find((desktop) => shortId(desktop.key) === norm);
    if (byId) return byId.key;
    const byName = desktops.filter(
      (desktop) => desktop.deviceId.toLowerCase() === norm,
    );
    const [only] = byName;
    if (only && byName.length === 1) return only.key;
    return undefined;
  }

  // The desktop a call with no selector runs on. A turn that originated on a
  // desktop always uses that desktop (the human is working at it). A turn bound
  // by identity uses the sole connected desktop, but refuses when several are
  // connected so the model names one with the `desktop` argument instead of the
  // broker silently picking the most recently linked.
  #defaultDesktop(
    binding: TurnBinding,
  ): { ok: true; key: string } | { ok: false; error: string } {
    if (binding.originDevice === true || binding.identityId === undefined) {
      return { ok: true, key: binding.key };
    }
    const desktops = this.#registry.desktopsForIdentity(binding.identityId);
    // No desktop is registered under this identity right now (none ever linked,
    // or the only one dropped its link); the lease key is the best we have.
    if (desktops.length === 0) return { ok: true, key: binding.key };
    // Exactly one desktop: target its live key, not the lease key, so a turn
    // whose original device dropped and relinked still resolves to the current
    // connection rather than a stale one.
    const [sole] = desktops;
    if (sole && desktops.length === 1) return { ok: true, key: sole.key };
    const names = desktops
      .map((desktop) => `${shortId(desktop.key)} (${desktop.deviceId})`)
      .join(", ");
    return {
      ok: false,
      error: `you have ${desktops.length} desktops connected and this turn is not tied to one; name a desktop with the \`desktop\` argument (call local_list_desktops to see them: ${names})`,
    };
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const method = request.method ?? "GET";
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      if (method !== "POST" || (path !== CALL_PATH && path !== STREAM_PATH)) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      const binding = this.#authorize(request);
      if (!binding) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }

      if (path === STREAM_PATH) {
        await this.#handleStream(request, response, binding);
        return;
      }

      const body = await readJsonBody(request, {
        maxBytes: BROKER_MAX_BODY_BYTES,
        timeoutMs: BROKER_BODY_TIMEOUT_MS,
      });
      if (!body.ok) {
        sendJson(response, body.status, { error: body.error });
        return;
      }
      const parsed = BrokerCallSchema.safeParse(body.value);
      if (!parsed.success) {
        sendJson(response, 400, { error: "invalid_call" });
        return;
      }
      const call = parsed.data;

      // The discovery call never reaches a desktop: the broker answers it from
      // the registry, naming the desktops this identity has connected so Sandi
      // can pick one to target.
      if (call.tool === "local_list_desktops") {
        sendJson(response, 200, this.#listDesktops(binding));
        return;
      }

      // A call may name a desktop other than the leased one. With a selector,
      // resolve it to a connected desktop of the same identity; an unmatched
      // selector is a refused outcome (with a helpful message) rather than a
      // transport error, so the model sees a tool error it can act on. Without a
      // selector, pick the default: the originating desktop, or, for a turn that
      // did not originate on a desktop, the sole connected one, refusing when the
      // human has several so the model names one rather than the broker guessing.
      const selector = desktopSelector(call);
      let targetKey: string;
      if (selector !== undefined) {
        const resolved = this.#resolveDesktop(binding, selector);
        if (!resolved) {
          sendJson(response, 200, {
            ok: false,
            output: "",
            error: unknownDesktopMessage(this.#registry, binding, selector),
          });
          return;
        }
        targetKey = resolved;
      } else {
        const fallback = this.#defaultDesktop(binding);
        if (!fallback.ok) {
          sendJson(response, 200, {
            ok: false,
            output: "",
            error: fallback.error,
          });
          return;
        }
        targetKey = fallback.key;
      }

      try {
        const outcome = await this.#registry.dispatch({
          key: targetKey,
          call,
          signal: binding.signal,
        });
        sendJson(response, 200, outcome);
      } catch (error) {
        if (error instanceof DeviceUnavailableError) {
          sendJson(response, 503, { error: "device_unavailable" });
          return;
        }
        // The turn aborted or the desktop went silent past the backstop. Tell
        // the pi child the call did not complete; its proxy tool surfaces a tool
        // error to the model rather than a result.
        sendJson(response, 504, { error: "tool_call_failed" });
      }
    } catch (error) {
      log.error("tool broker request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal_error" });
      }
    }
  }

  // Relays one streamed response delta from the pi child to the bound device's
  // SSE link. One way and best-effort: there is no result to await, so a relayed
  // delta answers 202 and a vanished device answers 503 so the child's streaming
  // extension can stop pushing. A delta never aborts or fails the turn; the turn
  // POST's final body is the authoritative response if the live stream is lost.
  async #handleStream(
    request: IncomingMessage,
    response: ServerResponse,
    binding: TurnBinding,
  ): Promise<void> {
    const body = await readJsonBody(request, {
      maxBytes: STREAM_MAX_BODY_BYTES,
      timeoutMs: BROKER_BODY_TIMEOUT_MS,
    });
    if (!body.ok) {
      sendJson(response, body.status, { error: body.error });
      return;
    }
    const parsed = ResponseChunkSchema.safeParse(body.value);
    if (!parsed.success) {
      sendJson(response, 400, { error: "invalid_chunk" });
      return;
    }
    // A delta must name the turn this lease was issued for. The api surface sets
    // that turn id on the child, so a mismatch means a misrouted or stale stream;
    // reject it rather than relay a delta the desktop would attribute to the
    // wrong turn.
    if (binding.turnId !== undefined && parsed.data.turnId !== binding.turnId) {
      sendJson(response, 409, { error: "turn_mismatch" });
      return;
    }
    const relayed = this.#registry.streamResponseChunk(
      binding.key,
      parsed.data,
    );
    if (!relayed) {
      sendJson(response, 503, { error: "device_unavailable" });
      return;
    }
    sendJson(response, 202, { ok: true });
  }

  #authorize(request: IncomingMessage): TurnBinding | undefined {
    const token = bearerToken(request.headers.authorization);
    if (!token) return undefined;
    return this.#turns.get(token);
  }
}

// The desktop a call wants to run on, when it named one. Every tool but the
// discovery call carries the selector; local_list_desktops is answered from the
// registry before this is reached, so it has none.
function desktopSelector(call: BrokerCall): string | undefined {
  if (call.tool === "local_list_desktops") return undefined;
  return call.params.desktop;
}

// A short, stable handle for a desktop derived from its routing key. The key is
// opaque (a token hash in production), so the leading hex is enough to name a
// desktop in a list and match a selector without exposing the whole key.
function shortId(key: string): string {
  return key.slice(0, 8).toLowerCase();
}

function unknownDesktopMessage(
  registry: DeviceRegistry,
  binding: TurnBinding,
  selector: string,
): string {
  const desktops =
    binding.identityId !== undefined
      ? registry.desktopsForIdentity(binding.identityId)
      : [];
  if (desktops.length === 0) {
    return `no connected desktop matches "${selector}"; this turn has no addressable desktops`;
  }
  const names = desktops
    .map((desktop) => `${shortId(desktop.key)} (${desktop.deviceId})`)
    .join(", ");
  return `no connected desktop matches "${selector}"; available desktops: ${names}`;
}
