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
import { BrokerCallSchema } from "@/surfaces/api/devices/protocol";
import { readJsonBody } from "@/surfaces/api/http/read-json-body";
import { bearerToken, sendJson } from "@/surfaces/api/http/respond";

const log = createLogger("api-tool-broker");

// Bound to loopback so the internal tool-call route is never reachable off-box,
// independent of whatever host the public API listener binds. The pi child Sandi
// spawns is the only client, and it reaches the broker over 127.0.0.1.
const LOOPBACK_HOST = "127.0.0.1";
const CALL_PATH = "/call";

// File writes carry their content in the call body, so the cap is generous;
// reads and shell output are capped on the desktop before they return.
const BROKER_MAX_BODY_BYTES = 8 * 1024 * 1024;
const BROKER_BODY_TIMEOUT_MS = 30_000;
const BROKER_HEADERS_TIMEOUT_MS = 10_000;

// 256-bit single-turn token. Combined with the loopback bind, guessing one is
// not a path an off-box attacker has; the token also scopes a call to exactly
// one device and one turn's abort signal.
const TOKEN_BYTES = 32;

type TurnBinding = {
  deviceId: string;
  signal: AbortSignal;
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
  // routes /call to one device under one abort signal.
  lease(input: { deviceId: string; signal: AbortSignal }): TurnBrokerLease {
    const url = this.#url;
    if (!url) throw new Error("tool broker is not started");
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    this.#turns.set(token, { deviceId: input.deviceId, signal: input.signal });
    return {
      ticket: { url, token },
      revoke: () => {
        this.#turns.delete(token);
      },
    };
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const method = request.method ?? "GET";
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      if (method !== "POST" || path !== CALL_PATH) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      const binding = this.#authorize(request);
      if (!binding) {
        sendJson(response, 401, { error: "unauthorized" });
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

      try {
        const outcome = await this.#registry.dispatch({
          deviceId: binding.deviceId,
          tool: parsed.data.tool,
          params: parsed.data.params,
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

  #authorize(request: IncomingMessage): TurnBinding | undefined {
    const token = bearerToken(request.headers.authorization);
    if (!token) return undefined;
    return this.#turns.get(token);
  }
}
