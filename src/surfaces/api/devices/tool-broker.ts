import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type { z } from "zod/v4";
import { errorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import type { DesktopFileDelivery } from "@/lib/provider/desktop-hands";
import { DiscordDesktopFileRequestSchema } from "@/surfaces/api/devices/desktop-file-transfer";
import {
  type DeviceRegistry,
  DeviceUnavailableError,
} from "@/surfaces/api/devices/device-registry";
import {
  type BrokerCall,
  BrokerCallSchema,
  ResponseAttachmentSchema,
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
const ATTACHMENT_PATH = "/attachment";
const DISCORD_FILE_PATH = "/discord-file";

// File writes carry their content in the call body, so the cap is generous;
// reads and shell output are capped on the desktop before they return.
const BROKER_MAX_BODY_BYTES = 8 * 1024 * 1024;
// A streamed response delta is one slice of generated text, far smaller than a
// file write, so its body is capped tighter.
const STREAM_MAX_BODY_BYTES = 1 * 1024 * 1024;
const DISCORD_FILE_REQUEST_MAX_BODY_BYTES = 16 * 1024;
const BROKER_BODY_TIMEOUT_MS = 30_000;
const BROKER_HEADERS_TIMEOUT_MS = 10_000;

// 256-bit single-turn token. Combined with the loopback bind, guessing one is
// not a path an off-box attacker has; the token also scopes a call to exactly
// one device and one turn's abort signal.
const TOKEN_BYTES = 32;

type TurnBinding = {
  key: string;
  signal: AbortSignal;
  controller: AbortController;
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
  // Present only for a Discord-originated turn. The broker invokes this after
  // the bound desktop returns a validated file payload; other surfaces cannot
  // turn a broker token into a Discord upload.
  deliverFile?: (delivery: DesktopFileDelivery) => Promise<void>;
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
  #startPromise: Promise<void> | undefined;
  #rejectStart: ((error: Error) => void) | undefined;

  constructor(registry: DeviceRegistry) {
    this.#registry = registry;
  }

  start(): Promise<void> {
    if (this.#url) return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    server.headersTimeout = BROKER_HEADERS_TIMEOUT_MS;
    server.requestTimeout = BROKER_BODY_TIMEOUT_MS + 5_000;
    this.#server = server;
    const startPromise = new Promise<void>((resolveStart, rejectStart) => {
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        server.removeListener("error", onError);
        if (this.#server === server) {
          this.#server = undefined;
          this.#url = undefined;
        }
        this.#startPromise = undefined;
        this.#rejectStart = undefined;
        rejectStart(error);
      };
      const onError = (error: Error): void => fail(error);
      this.#rejectStart = fail;
      server.once("error", onError);
      server.listen(0, LOOPBACK_HOST, () => {
        if (this.#server !== server) {
          fail(new Error("tool broker stopped while starting"));
          return;
        }
        server.removeListener("error", onError);
        const address = server.address();
        if (!address || typeof address !== "object") {
          fail(new Error("tool broker did not expose a listening address"));
          return;
        }
        settled = true;
        this.#url = `http://${LOOPBACK_HOST}:${address.port}`;
        this.#startPromise = undefined;
        this.#rejectStart = undefined;
        log.info("tool broker listening", { url: this.#url });
        resolveStart();
      });
    });
    this.#startPromise = startPromise;
    return startPromise;
  }

  stop(): void {
    const server = this.#server;
    this.#server = undefined;
    this.#url = undefined;
    this.#rejectStart?.(new Error("tool broker stopped while starting"));
    this.#rejectStart = undefined;
    this.#startPromise = undefined;
    for (const binding of this.#turns.values()) {
      binding.controller.abort(new Error("tool broker stopped"));
    }
    this.#turns.clear();
    if (!server) return;
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
    deliverFile?: (delivery: DesktopFileDelivery) => Promise<void>;
  }): TurnBrokerLease {
    const url = this.#url;
    if (!url) throw new Error("tool broker is not started");
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    const controller = new AbortController();
    // Resolve the owning identity now, while the leased link is live: a turn's
    // own desktop is connected at lease time, so this fixes the set of desktops
    // a later call may target even if the original link drops mid-turn.
    const identityId = this.#registry.identityForKey(input.key);
    this.#turns.set(token, {
      key: input.key,
      signal: AbortSignal.any([input.signal, controller.signal]),
      controller,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(identityId !== undefined ? { identityId } : {}),
      ...(input.originDevice === true ? { originDevice: true } : {}),
      ...(input.deliverFile !== undefined
        ? { deliverFile: input.deliverFile }
        : {}),
    });
    return {
      ticket: { url, token },
      revoke: () => {
        const binding = this.#turns.get(token);
        if (!binding) return;
        this.#turns.delete(token);
        binding.controller.abort(new Error("tool broker lease revoked"));
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

  #targetDesktop(
    binding: TurnBinding,
    selector: string | undefined,
  ): { ok: true; key: string } | { ok: false; error: string } {
    if (selector === undefined) return this.#defaultDesktop(binding);
    const key = this.#resolveDesktop(binding, selector);
    return key
      ? { ok: true, key }
      : {
          ok: false,
          error: unknownDesktopMessage(this.#registry, binding, selector),
        };
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const method = request.method ?? "GET";
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      const knownPath =
        path === CALL_PATH ||
        path === STREAM_PATH ||
        path === ATTACHMENT_PATH ||
        path === DISCORD_FILE_PATH;
      if (method !== "POST" || !knownPath) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      const binding = this.#authorize(request);
      if (!binding) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (binding.signal.aborted) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      const requestController = new AbortController();
      const abortRequest = (): void => {
        requestController.abort(new Error("tool broker request disconnected"));
      };
      request.once("aborted", abortRequest);
      response.once("close", () => {
        if (!response.writableFinished) abortRequest();
      });
      const scopedBinding: TurnBinding = {
        ...binding,
        signal: AbortSignal.any([binding.signal, requestController.signal]),
      };

      if (path === STREAM_PATH) {
        await this.#handleStream(request, response, scopedBinding);
        return;
      }

      if (path === ATTACHMENT_PATH) {
        await this.#handleAttachment(request, response, scopedBinding);
        return;
      }

      if (path === DISCORD_FILE_PATH) {
        await this.#handleDiscordFile(request, response, scopedBinding);
        return;
      }

      const body = await readJsonBody(request, {
        maxBytes: BROKER_MAX_BODY_BYTES,
        timeoutMs: BROKER_BODY_TIMEOUT_MS,
        response,
        signal: scopedBinding.signal,
      });
      if (!body.ok) {
        sendJson(response, body.status, { error: body.error });
        return;
      }
      if (scopedBinding.signal.aborted) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      const parsed = BrokerCallSchema.safeParse(body.value);
      if (!parsed.success) {
        sendJson(response, 400, { error: "invalid_call" });
        return;
      }
      const call = parsed.data;

      if (call.tool === "local_transfer_file") {
        sendJson(response, 400, { error: "private_call" });
        return;
      }

      // The discovery call never reaches a desktop: the broker answers it from
      // the registry, naming the desktops this identity has connected so Sandi
      // can pick one to target.
      if (call.tool === "local_list_desktops") {
        sendJson(response, 200, this.#listDesktops(scopedBinding));
        return;
      }

      // A call may name a desktop other than the leased one. With a selector,
      // resolve it to a connected desktop of the same identity; an unmatched
      // selector is a refused outcome (with a helpful message) rather than a
      // transport error, so the model sees a tool error it can act on. Without a
      // selector, pick the default: the originating desktop, or, for a turn that
      // did not originate on a desktop, the sole connected one, refusing when the
      // human has several so the model names one rather than the broker guessing.
      const target = this.#targetDesktop(scopedBinding, desktopSelector(call));
      if (!target.ok) {
        sendJson(response, 200, {
          ok: false,
          output: "",
          error: target.error,
        });
        return;
      }

      try {
        const outcome = await this.#registry.dispatch({
          key: target.key,
          call,
          signal: scopedBinding.signal,
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
        error: errorMessage(error),
      });
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal_error" });
      }
    }
  }

  /**
   * Transfers one bounded file from the leased identity's desktop directly to
   * the Discord callback that created this broker lease. The pi child supplies
   * only metadata; validated bytes arrive from the authenticated device result
   * and never become model-visible tool output.
   */
  async #handleDiscordFile(
    request: IncomingMessage,
    response: ServerResponse,
    binding: TurnBinding,
  ): Promise<void> {
    if (!binding.deliverFile) {
      sendJson(response, 409, { error: "discord_delivery_unavailable" });
      return;
    }
    const body = await readJsonBody(request, {
      maxBytes: DISCORD_FILE_REQUEST_MAX_BODY_BYTES,
      timeoutMs: BROKER_BODY_TIMEOUT_MS,
      response,
      signal: binding.signal,
    });
    if (!body.ok) {
      sendJson(response, body.status, { error: body.error });
      return;
    }
    if (binding.signal.aborted) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    const parsed = DiscordDesktopFileRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      sendJson(response, 400, { error: "invalid_discord_file" });
      return;
    }
    const target = this.#targetDesktop(binding, parsed.data.desktop);
    if (!target.ok) {
      sendJson(response, 422, { error: target.error });
      return;
    }
    let outcome: ToolCallOutcome;
    try {
      outcome = await this.#registry.dispatch({
        key: target.key,
        call: {
          tool: "local_transfer_file",
          params: {
            path: parsed.data.path,
            ...(parsed.data.name !== undefined
              ? { name: parsed.data.name }
              : {}),
            ...(parsed.data.mimeType !== undefined
              ? { mimeType: parsed.data.mimeType }
              : {}),
          },
        },
        signal: binding.signal,
      });
    } catch (error) {
      if (error instanceof DeviceUnavailableError) {
        sendJson(response, 503, { error: "device_unavailable" });
        return;
      }
      sendJson(response, binding.signal.aborted ? 499 : 504, {
        error: binding.signal.aborted ? "cancelled" : "desktop_transfer_failed",
      });
      return;
    }
    if (!outcome.ok || !outcome.attachment) {
      sendJson(response, 422, {
        error: outcome.error ?? "desktop did not return a file",
      });
      return;
    }
    try {
      await binding.deliverFile({
        attachment: outcome.attachment,
        ...(parsed.data.content !== undefined
          ? { content: parsed.data.content }
          : {}),
      });
      sendJson(response, 200, {
        ok: true,
        name: outcome.attachment.name,
        mimeType: outcome.attachment.mimeType,
        size: outcome.attachment.size,
      });
    } catch (error) {
      log.warn("desktop file delivery to Discord failed", {
        error: errorMessage(error),
      });
      sendJson(response, 502, { error: "discord_upload_failed" });
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
    await this.#relay(request, response, binding, {
      maxBytes: STREAM_MAX_BODY_BYTES,
      schema: ResponseChunkSchema,
      invalidError: "invalid_chunk",
      stream: (key, data) => this.#registry.streamResponseChunk(key, data),
    });
  }

  // Relays one outbound attachment notice from the pi child (the
  // attach_to_reply extension tool) to the bound device's SSE link. Mirrors
  // #handleStream: a turn-id mismatch is a 409 (the lease is bound to a turn but
  // the tool reported one that does not match, meaning a stale or misrouted
  // call), and a vanished device is a 503 so the tool result the model sees can
  // say plainly that the desktop link dropped.
  async #handleAttachment(
    request: IncomingMessage,
    response: ServerResponse,
    binding: TurnBinding,
  ): Promise<void> {
    await this.#relay(request, response, binding, {
      maxBytes: BROKER_MAX_BODY_BYTES,
      schema: ResponseAttachmentSchema,
      invalidError: "invalid_attachment",
      stream: (key, data) => this.#registry.streamResponseAttachment(key, data),
    });
  }

  // Shared body of #handleStream and #handleAttachment: both relay a
  // turn-scoped wire message from the pi child to the bound device's SSE link
  // with the same parse/mismatch/dispatch pipeline, differing only in schema,
  // invalid-body error code, and which registry method carries the payload on.
  async #relay<T extends { turnId: string }>(
    request: IncomingMessage,
    response: ServerResponse,
    binding: TurnBinding,
    options: {
      maxBytes: number;
      schema: z.ZodType<T>;
      invalidError: string;
      stream: (key: string, data: T) => boolean;
    },
  ): Promise<void> {
    const body = await readJsonBody(request, {
      maxBytes: options.maxBytes,
      timeoutMs: BROKER_BODY_TIMEOUT_MS,
      response,
      signal: binding.signal,
    });
    if (!body.ok) {
      sendJson(response, body.status, { error: body.error });
      return;
    }
    if (binding.signal.aborted) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    const parsed = options.schema.safeParse(body.value);
    if (!parsed.success) {
      sendJson(response, 400, { error: options.invalidError });
      return;
    }
    // A relayed message must name the turn this lease was issued for. The api
    // surface sets that turn id on the child, so a mismatch means a misrouted or
    // stale stream; reject it rather than relay a message the desktop would
    // attribute to the wrong turn.
    if (binding.turnId !== undefined && parsed.data.turnId !== binding.turnId) {
      sendJson(response, 409, { error: "turn_mismatch" });
      return;
    }
    const relayed = options.stream(binding.key, parsed.data);
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
