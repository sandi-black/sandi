import { randomUUID } from "node:crypto";

import { createLogger } from "@/lib/logging";
import {
  type DeviceResult,
  type LocalToolName,
  TOOL_CALL_EVENT,
  type ToolCallOutcome,
  type ToolDispatch,
} from "@/surfaces/api/devices/protocol";

const log = createLogger("api-devices");

// A pending call lives only as long as its turn: the turn's abort signal rejects
// it, and a disconnecting desktop rejects it. This backstop frees a call whose
// desktop went silent without ever closing the stream (a hard crash, a dropped
// network) so a wedged device cannot pin server memory indefinitely.
const DISPATCH_BACKSTOP_MS = 10 * 60_000;

// Periodic SSE comment line. It keeps intermediaries from idling the stream shut
// and surfaces a half-open socket: once the peer is gone the write throws and the
// connection is torn down.
const HEARTBEAT_MS = 30_000;

export class DeviceUnavailableError extends Error {
  constructor(deviceId: string) {
    super(`no connected desktop for device ${deviceId}`);
    this.name = "DeviceUnavailableError";
  }
}

export type DeviceConnectionHandle = {
  // Closes this link and rejects its in-flight calls. Idempotent: safe to call
  // from the HTTP "close" handler and from a supersede at once.
  close(): void;
};

type PendingCall = {
  resolve: (outcome: ToolCallOutcome) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ConnectionState = {
  deviceId: string;
  identityId: string;
  write: (chunk: string) => void;
  end: () => void;
  pending: Map<string, PendingCall>;
  heartbeat: ReturnType<typeof setInterval>;
  closed: boolean;
};

// Tracks the desktops currently holding an SSE link and routes tool calls to
// them. Keyed by deviceId: a turn authenticates with a token bound to one
// device, and that device's link carries the turn's file and shell work, so a
// turn always reaches the same machine that asked for it.
export class DeviceRegistry {
  readonly #connections = new Map<string, ConnectionState>();

  // Registers a desktop's SSE link. `write` emits a raw SSE chunk and `end`
  // closes the underlying response; both are supplied by the HTTP layer so this
  // registry stays transport-agnostic and unit-testable. A second link for the
  // same device supersedes the first.
  connect(input: {
    deviceId: string;
    identityId: string;
    write: (chunk: string) => void;
    end: () => void;
  }): DeviceConnectionHandle {
    const existing = this.#connections.get(input.deviceId);
    if (existing) {
      this.#teardown(existing, "superseded by a new device link");
    }

    const state: ConnectionState = {
      deviceId: input.deviceId,
      identityId: input.identityId,
      write: input.write,
      end: input.end,
      pending: new Map(),
      heartbeat: setInterval(() => {
        this.#heartbeat(state);
      }, HEARTBEAT_MS),
      closed: false,
    };
    this.#connections.set(input.deviceId, state);
    log.info("device link connected", {
      deviceId: input.deviceId,
      identityId: input.identityId,
    });
    return {
      close: () => this.#teardown(state, "device link closed"),
    };
  }

  isConnected(deviceId: string): boolean {
    const state = this.#connections.get(deviceId);
    return state !== undefined && !state.closed;
  }

  // Pushes a tool call to the device's stream and resolves with the outcome the
  // device POSTs back. Rejects with DeviceUnavailableError if no link is present
  // or the stream is dead, and rejects if the turn aborts or the backstop fires.
  dispatch(input: {
    deviceId: string;
    tool: LocalToolName;
    params: unknown;
    signal?: AbortSignal;
  }): Promise<ToolCallOutcome> {
    const state = this.#connections.get(input.deviceId);
    if (!state || state.closed) {
      return Promise.reject(new DeviceUnavailableError(input.deviceId));
    }

    return new Promise<ToolCallOutcome>((resolve, reject) => {
      if (input.signal?.aborted) {
        reject(new Error("turn aborted before the desktop returned a result"));
        return;
      }

      const id = randomUUID();
      const onAbort = (): void => {
        const call = state.pending.get(id);
        if (!call) return;
        state.pending.delete(id);
        clearTimeout(call.timer);
        reject(new Error("turn aborted before the desktop returned a result"));
      };
      const timer = setTimeout(() => {
        const call = state.pending.get(id);
        if (!call) return;
        state.pending.delete(id);
        input.signal?.removeEventListener("abort", onAbort);
        reject(new Error("desktop did not return a tool result in time"));
      }, DISPATCH_BACKSTOP_MS);

      state.pending.set(id, {
        resolve: (outcome) => {
          input.signal?.removeEventListener("abort", onAbort);
          resolve(outcome);
        },
        reject: (error) => {
          input.signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
        timer,
      });
      input.signal?.addEventListener("abort", onAbort, { once: true });

      const dispatch: ToolDispatch = {
        id,
        tool: input.tool,
        params: input.params,
      };
      try {
        state.write(
          `event: ${TOOL_CALL_EVENT}\ndata: ${JSON.stringify(dispatch)}\n\n`,
        );
      } catch {
        state.pending.delete(id);
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        this.#teardown(state, "device link write failed");
        reject(new DeviceUnavailableError(input.deviceId));
      }
    });
  }

  // Resolves the pending call named by the result. Returns false when the device
  // or the call id is unknown (a stale or duplicate result), so the caller can
  // answer the device with a 404 rather than silently dropping it.
  settleResult(deviceId: string, result: DeviceResult): boolean {
    const state = this.#connections.get(deviceId);
    if (!state) return false;
    const call = state.pending.get(result.id);
    if (!call) return false;
    state.pending.delete(result.id);
    clearTimeout(call.timer);
    call.resolve({
      ok: result.ok,
      output: result.output,
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
    return true;
  }

  // Closes every link. Used on server shutdown so no stream is left dangling.
  closeAll(): void {
    for (const state of [...this.#connections.values()]) {
      this.#teardown(state, "server shutting down");
    }
  }

  #heartbeat(state: ConnectionState): void {
    if (state.closed) return;
    try {
      state.write(": ping\n\n");
    } catch {
      this.#teardown(state, "heartbeat write failed");
    }
  }

  #teardown(state: ConnectionState, reason: string): void {
    if (state.closed) return;
    state.closed = true;
    clearInterval(state.heartbeat);
    if (this.#connections.get(state.deviceId) === state) {
      this.#connections.delete(state.deviceId);
    }
    for (const call of state.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new DeviceUnavailableError(state.deviceId));
    }
    state.pending.clear();
    try {
      state.end();
    } catch {
      // The response may already be closed by the peer; ending again is a no-op.
    }
    log.info("device link disconnected", { deviceId: state.deviceId, reason });
  }
}
