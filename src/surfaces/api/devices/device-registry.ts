import { randomUUID } from "node:crypto";

import { createLogger } from "@/lib/logging";
import {
  type BrokerCall,
  type DeviceResult,
  RESPONSE_ATTACHMENT_EVENT,
  RESPONSE_CHUNK_EVENT,
  type ResponseAttachment,
  type ResponseChunk,
  TOOL_CALL_EVENT,
  TOOL_CANCEL_EVENT,
  type ToolCallOutcome,
  type ToolCancel,
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
  constructor() {
    super("no connected desktop for this turn");
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
  key: string;
  deviceId: string;
  identityId: string;
  // Returns Node's write backpressure signal: false when the socket buffer is
  // full. Tool calls and cancels ignore it (they are infrequent and must not be
  // dropped); the response stream uses it to shed load.
  write: (chunk: string) => boolean;
  end: () => void;
  pending: Map<string, PendingCall>;
  heartbeat: ReturnType<typeof setInterval>;
  closed: boolean;
};

// Tracks the desktops currently holding an SSE link and routes tool calls to
// them. Links are keyed by an opaque routing key, not the client-chosen
// deviceId: the api bot uses the authenticating token's hash, which is unique
// per token and identical for a device's link and its turns, so a turn always
// reaches the same token's desktop and a deviceId reused across tokens cannot
// cross identities. deviceId and identityId are carried only for logging.
export class DeviceRegistry {
  readonly #connections = new Map<string, ConnectionState>();

  // Registers a desktop's SSE link. `write` emits a raw SSE chunk and `end`
  // closes the underlying response; both are supplied by the HTTP layer so this
  // registry stays transport-agnostic and unit-testable. A second link for the
  // same key supersedes the first.
  connect(input: {
    key: string;
    deviceId: string;
    identityId: string;
    write: (chunk: string) => boolean;
    end: () => void;
  }): DeviceConnectionHandle {
    const existing = this.#connections.get(input.key);
    if (existing) {
      this.#teardown(existing, "superseded by a new device link");
    }

    const state: ConnectionState = {
      key: input.key,
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
    this.#connections.set(input.key, state);
    log.info("device link connected", {
      deviceId: input.deviceId,
      identityId: input.identityId,
    });
    return {
      close: () => this.#teardown(state, "device link closed"),
    };
  }

  isConnected(key: string): boolean {
    const state = this.#connections.get(key);
    return state !== undefined && !state.closed;
  }

  // Finds a live device link belonging to a human identity, returning its
  // routing key. The api surface keys a turn by the caller's own token hash, but
  // a turn that originates on another surface (a Discord message, a GitHub
  // mention) has no device token: it reaches the human's desktop by identity
  // instead. When a human has more than one desktop linked, the most recently
  // connected one wins (connections preserve insertion order, so the last match
  // is newest). Returns undefined when that human has no desktop holding a link,
  // so the turn runs with server hands only rather than reaching a stranger's
  // machine.
  keyForIdentity(identityId: string): string | undefined {
    let key: string | undefined;
    for (const state of this.#connections.values()) {
      if (!state.closed && state.identityId === identityId) {
        key = state.key;
      }
    }
    return key;
  }

  // The identity that owns a live link, or undefined when the key is unknown or
  // its link has closed. The broker resolves this once at lease time so a turn
  // can later enumerate and target that identity's other desktops without
  // reaching across to a stranger's machine.
  identityForKey(key: string): string | undefined {
    const state = this.#connections.get(key);
    if (!state || state.closed) return undefined;
    return state.identityId;
  }

  // Every desktop an identity currently has linked, as routing key plus the
  // client-chosen name (for display and selection). Backs the local_list_desktops
  // tool and the `desktop` selector: a turn may target any of its own identity's
  // connected desktops, and only those.
  desktopsForIdentity(
    identityId: string,
  ): Array<{ key: string; deviceId: string }> {
    const desktops: Array<{ key: string; deviceId: string }> = [];
    for (const state of this.#connections.values()) {
      if (!state.closed && state.identityId === identityId) {
        desktops.push({ key: state.key, deviceId: state.deviceId });
      }
    }
    return desktops;
  }

  // Pushes a tool call to the keyed device's stream and resolves with the
  // outcome the device POSTs back. Rejects with DeviceUnavailableError if no link
  // is present or the stream is dead, and rejects if the turn aborts or the
  // backstop fires.
  dispatch(input: {
    key: string;
    call: BrokerCall;
    signal?: AbortSignal;
  }): Promise<ToolCallOutcome> {
    const state = this.#connections.get(input.key);
    if (!state || state.closed) {
      return Promise.reject(new DeviceUnavailableError());
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
        this.#cancel(state, id);
        reject(new Error("turn aborted before the desktop returned a result"));
      };
      const timer = setTimeout(() => {
        const call = state.pending.get(id);
        if (!call) return;
        state.pending.delete(id);
        input.signal?.removeEventListener("abort", onAbort);
        this.#cancel(state, id);
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

      const dispatch: ToolDispatch = { id, ...input.call };
      try {
        state.write(
          `event: ${TOOL_CALL_EVENT}\ndata: ${JSON.stringify(dispatch)}\n\n`,
        );
      } catch {
        state.pending.delete(id);
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        this.#teardown(state, "device link write failed");
        reject(new DeviceUnavailableError());
      }
    });
  }

  // Pushes one streamed response delta to the keyed device's stream. Returns
  // false when no link is present, the stream is dead, or the socket is
  // backpressured, so the broker answers the child with a 503 and it stops
  // pushing. Unlike dispatch there is no pending call and no reply: a response
  // delta is fire-and-forget, and a dropped delta only costs the live preview,
  // not the turn (the turn POST still returns the authoritative final text). A
  // failed write tears the link down; a full socket buffer just sheds the stream
  // so a slow desktop cannot make the server buffer deltas without bound.
  streamResponseChunk(key: string, chunk: ResponseChunk): boolean {
    return this.#emit(key, RESPONSE_CHUNK_EVENT, chunk);
  }

  // Pushes one outbound attachment notice to the keyed device's stream. Same
  // fire-and-forget contract as streamResponseChunk: no pending call, no reply,
  // and a false return just tells the caller to stop (here, the caller is the
  // attach_to_reply tool reporting failure to the model, not a lost turn).
  streamResponseAttachment(
    key: string,
    attachment: ResponseAttachment,
  ): boolean {
    return this.#emit(key, RESPONSE_ATTACHMENT_EVENT, attachment);
  }

  // Writes one SSE event to a keyed device's stream, tearing the link down on a
  // failed write. Shared by every fire-and-forget push (a response delta, an
  // outbound attachment notice): the two differ only in event name and payload,
  // both already-validated wire objects that serialize as-is.
  #emit(
    key: string,
    event: string,
    payload: ResponseChunk | ResponseAttachment,
  ): boolean {
    const state = this.#connections.get(key);
    if (!state || state.closed) return false;
    try {
      return state.write(
        `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
      );
    } catch {
      this.#teardown(state, "device link write failed");
      return false;
    }
  }

  // Resolves the pending call named by the result. Returns false when the key or
  // the call id is unknown (a stale or duplicate result), so the caller can
  // answer the device with a 404 rather than silently dropping it.
  settleResult(key: string, result: DeviceResult): boolean {
    const state = this.#connections.get(key);
    if (!state) return false;
    const call = state.pending.get(result.id);
    if (!call) return false;
    state.pending.delete(result.id);
    clearTimeout(call.timer);
    call.resolve({
      ok: result.ok,
      output: result.output,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.image !== undefined ? { image: result.image } : {}),
    });
    return true;
  }

  // Closes every link. Used on server shutdown so no stream is left dangling.
  closeAll(): void {
    for (const state of [...this.#connections.values()]) {
      this.#teardown(state, "server shutting down");
    }
  }

  // Best-effort: tell the desktop to abandon a call we have stopped waiting for.
  // The desktop may still finish and POST a result, which settleResult drops as
  // unknown; this only saves it the wasted work. A failed write means the link
  // is already gone, so tear it down.
  #cancel(state: ConnectionState, id: string): void {
    if (state.closed) return;
    const cancel: ToolCancel = { id };
    try {
      state.write(
        `event: ${TOOL_CANCEL_EVENT}\ndata: ${JSON.stringify(cancel)}\n\n`,
      );
    } catch {
      this.#teardown(state, "device link write failed");
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
    if (this.#connections.get(state.key) === state) {
      this.#connections.delete(state.key);
    }
    for (const call of state.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new DeviceUnavailableError());
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
