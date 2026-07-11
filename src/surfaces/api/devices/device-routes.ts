import type { IncomingMessage, ServerResponse } from "node:http";

import type { ApiTokenEntry, ApiTokenStore } from "@/surfaces/api/auth/tokens";
import type {
  DeviceConnectionHandle,
  DeviceRegistry,
} from "@/surfaces/api/devices/device-registry";
import { DeviceResultSchema } from "@/surfaces/api/devices/protocol";
import { readJsonBody } from "@/surfaces/api/http/read-json-body";
import { sendJson } from "@/surfaces/api/http/respond";

// A tool result body can carry a file's contents or a command's output, so it is
// allowed to be larger than an ordinary request; the desktop caps these before
// it sends them.
const DEVICE_RESULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEVICE_RESULT_BODY_TIMEOUT_MS = 30_000;

// The HTTP edge of the hands-local device protocol: the SSE link a desktop holds
// open to receive tool calls, and the result POST it answers each with. ApiBot
// authenticates the bearer token and routes the path here; this controller owns
// the streaming, body parsing, and registry calls, so the bot is left to compose
// the listener and its shared dependencies rather than also owning device I/O.
export class DeviceRoutes {
  readonly #registry: DeviceRegistry;
  readonly #tokens: ApiTokenStore;

  constructor(registry: DeviceRegistry, tokens: ApiTokenStore) {
    this.#registry = registry;
    this.#tokens = tokens;
    tokens.onChange((file) => {
      registry.retainAuthorizedTokens(file.tokens);
    });
  }

  // A desktop holds this SSE stream open to receive the tool calls for its turns.
  // The link is keyed by the authenticating token's hash, not the client-chosen
  // deviceId, and that key is what a turn routes its file and shell work to. The
  // stream stays open until the client goes away; each tool call arrives as a
  // `tool_call` event and each result comes back on the result route.
  handleLink(response: ServerResponse, entry: ApiTokenEntry): void {
    let handle: DeviceConnectionHandle | undefined;
    const onClose = (): void => {
      handle?.close();
    };
    response.once("close", onClose);
    if (response.destroyed || response.closed || response.writableEnded) {
      response.removeListener("close", onClose);
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Stop intermediaries from buffering the stream so events flush at once.
      "x-accel-buffering": "no",
    });
    const initiallyWritable = response.write(": linked\n\n");

    handle = this.#registry.connect({
      key: entry.tokenSha256,
      deviceId: entry.deviceId,
      identityId: entry.identityId,
      // Returns Node's write backpressure signal (false when the socket buffer
      // is full) so the registry can shed a high-rate response stream rather than
      // buffer it without bound.
      write: (chunk) => response.write(chunk),
      onDrain: (listener) => {
        response.on("drain", listener);
        return () => {
          response.removeListener("drain", listener);
        };
      },
      initialBackpressured: !initiallyWritable,
      isAuthorized: () => this.#tokens.contains(entry),
      end: () => {
        response.end();
      },
    });
    // An SSE link ends only when the client disconnects: tear it down so the
    // device frees and any in-flight calls reject.
    if (response.destroyed || response.closed || response.writableEnded) {
      handle.close();
    }
  }

  // A desktop POSTs one tool result here as each call finishes. The call is
  // routed back by the authenticating token's hash, never a field in the body,
  // so a device can only ever settle its own calls.
  async handleResult(
    request: IncomingMessage,
    response: ServerResponse,
    entry: ApiTokenEntry,
  ): Promise<void> {
    const body = await readJsonBody(request, {
      maxBytes: DEVICE_RESULT_MAX_BODY_BYTES,
      timeoutMs: DEVICE_RESULT_BODY_TIMEOUT_MS,
      response,
    });
    if (!body.ok) {
      sendJson(response, body.status, { error: body.error });
      return;
    }
    const parsed = DeviceResultSchema.safeParse(body.value);
    if (!parsed.success) {
      sendJson(response, 400, { error: "invalid_result" });
      return;
    }

    const settled = this.#registry.settleResult(entry.tokenSha256, parsed.data);
    if (!settled) {
      // The call id is unknown for this device: a stale, duplicate, or already
      // aborted call. Nothing to resolve.
      sendJson(response, 404, { error: "unknown_call" });
      return;
    }
    sendJson(response, 202, { ok: true });
  }
}
