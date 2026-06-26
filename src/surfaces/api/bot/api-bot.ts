import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type { ContextCompiler } from "@/lib/context/context-compiler";
import { buildMemoryContext } from "@/lib/context/memory";
import type { ConversationStore } from "@/lib/conversations/store";
import type {
  ConversationManifest,
  ConversationParticipant,
} from "@/lib/conversations/types";
import { loadHumanIdentities } from "@/lib/identity/resolver";
import type {
  HumanIdentityConfig,
  HumanIdentityRecord,
} from "@/lib/identity/types";
import { createLogger } from "@/lib/logging";
import {
  type ModelProviderClient,
  ProviderTurnError,
  type ProviderTurnRequest,
} from "@/lib/provider/pi-cli-client";
import { ThreadQueue } from "@/lib/turns/turn-queue";
import {
  apiConversationStorageId,
  buildApiConversationManifest,
  canonicalApiConversationId,
  InvalidApiSegmentError,
  validateApiConversationRef,
} from "@/surfaces/api/api/conversations";
import { API_DELIVERY_INSTRUCTIONS } from "@/surfaces/api/api/delivery-instructions";
import { type ApiTokenEntry, ApiTokenStore } from "@/surfaces/api/auth/tokens";
import type { ApiAppConfig } from "@/surfaces/api/config";
import { API_SURFACE_CONTEXT } from "@/surfaces/api/runtime/context";

const log = createLogger("api-bot");

const MAX_REQUEST_BODY_BYTES = 256 * 1024;
// The whole request body is capped at 256 KiB, so a generous-but-bounded read
// deadline is enough to defeat a slow-body (Slowloris-style) client without
// cutting off legitimate large-but-slow uploads. This is independent of the
// provider turn timeout, which can run much longer.
const BODY_READ_TIMEOUT_MS = 15_000;
// Node's own header/request guards back-stop the body deadline at the socket
// level so a client cannot stall before the body handler is attached.
const SERVER_HEADERS_TIMEOUT_MS = 10_000;
const SERVER_REQUEST_TIMEOUT_MS = 30_000;
const TURNS_PATH = /^\/v1\/conversations\/([^/]+)\/turns$/;

export type ApiBotInput = {
  config: ApiAppConfig;
  conversations: ConversationStore;
  contextCompiler: ContextCompiler;
  provider: ModelProviderClient;
};

export class ApiBot {
  readonly #config: ApiAppConfig;
  readonly #conversations: ConversationStore;
  readonly #contextCompiler: ContextCompiler;
  readonly #provider: ModelProviderClient;
  readonly #queue = new ThreadQueue();
  readonly #tokens: ApiTokenStore;
  #identities: Promise<HumanIdentityConfig> | undefined;
  #server: Server | undefined;

  constructor(input: ApiBotInput) {
    this.#config = input.config;
    this.#conversations = input.conversations;
    this.#contextCompiler = input.contextCompiler;
    this.#provider = input.provider;
    this.#tokens = new ApiTokenStore(input.config.api.tokensPath);
  }

  start(): Promise<void> {
    if (this.#server) return Promise.resolve();
    const server = createServer((request, response) => {
      void this.#handleRequest(request, response);
    });
    // Fail closed against slow-header / slow-request attacks at the socket
    // level, independent of the per-handler body deadline.
    server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
    server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
    this.#server = server;
    return new Promise((resolveStart, rejectStart) => {
      const onError = (error: Error): void => {
        rejectStart(error);
      };
      server.once("error", onError);
      server.listen(this.#config.api.port, this.#config.api.host, () => {
        server.removeListener("error", onError);
        log.info("API surface listening", {
          host: this.#config.api.host,
          port: this.address()?.port ?? this.#config.api.port,
        });
        resolveStart();
      });
    });
  }

  stop(): void {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    log.info("stopping API surface");
    server.close();
    server.closeAllConnections?.();
  }

  address(): { port: number } | undefined {
    const address = this.#server?.address();
    if (address && typeof address === "object") return { port: address.port };
    return undefined;
  }

  async #handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const method = request.method ?? "GET";
    const url = request.url ?? "/";
    const path = url.split("?")[0] ?? "/";

    try {
      if (method === "GET" && path === "/v1/health") {
        sendJson(response, 200, { ok: true, surface: "api" });
        return;
      }

      const turnsMatch = TURNS_PATH.exec(path);
      if (turnsMatch) {
        if (method !== "POST") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        let conversationId: string;
        try {
          conversationId = decodeURIComponent(turnsMatch[1] ?? "");
        } catch (error) {
          if (error instanceof URIError) {
            sendJson(response, 400, { error: "invalid_conversation_id" });
            return;
          }
          throw error;
        }
        await this.#handleTurnRequest(request, response, conversationId);
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      log.error("API request failed", {
        method,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal_error" });
      }
    }
  }

  async #handleTurnRequest(
    request: IncomingMessage,
    response: ServerResponse,
    conversationId: string,
  ): Promise<void> {
    const entry = await this.#authenticate(request);
    if (!entry) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    const ref = {
      identityId: entry.identityId,
      deviceId: entry.deviceId,
      conversationId,
    };
    try {
      validateApiConversationRef(ref);
    } catch (error) {
      if (error instanceof InvalidApiSegmentError) {
        sendJson(response, 400, { error: `invalid_${snakeCase(error.field)}` });
        return;
      }
      throw error;
    }

    // Resolve the caller's identity before reading the body so an unmapped
    // identity fails closed without us spending work parsing the request.
    const participant = await this.#participantForIdentity(entry);
    if (!participant) {
      // Fail closed: the token authenticated, but no such human identity is
      // configured, so we never run an unmapped turn against the provider.
      sendJson(response, 403, { error: "identity_unmapped" });
      return;
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, body.status, { error: body.error });
      return;
    }
    const parsed = parseTurnBody(body.value);
    if (!parsed.ok) {
      sendJson(response, 400, { error: parsed.error });
      return;
    }

    // Tie the turn to the client connection: if the client disconnects before
    // we finish replying, abort so we neither burn a Pi session nor write to a
    // dead response. We key off the response closing *before* it finished
    // writing, which is the true "client went away" signal. (The request stream
    // also emits "close" after a fully-read body, which is not a disconnect, so
    // we must not abort on that.)
    const abort = new AbortController();
    const onClose = (): void => {
      if (!response.writableFinished) abort.abort();
    };
    response.on("close", onClose);

    try {
      // Note: do not treat `request.destroyed` as a disconnect here. A fully
      // consumed request body destroys its readable side on "end", which is
      // normal. The real disconnect signal is the response closing unfinished,
      // captured by `abort` above.
      if (abort.signal.aborted) return;

      const canonicalId = canonicalApiConversationId(ref);
      const storageId = apiConversationStorageId(ref);
      const manifestInput = {
        ...ref,
        participant,
        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      };
      const created = await this.#conversations.getOrCreate({
        storageId,
        fallback: buildApiConversationManifest(manifestInput),
      });
      const conversation = await this.#conversations.addParticipant({
        storageId,
        manifest: created,
        participant,
      });

      const text = await this.#runQueuedTurn({
        canonicalId,
        conversation,
        participant,
        input: parsed.input,
        requestSignal: abort.signal,
      });
      if (response.destroyed) return;
      sendJson(response, 200, { conversationId, text });
    } catch (error) {
      // The client went away (socket close or an aborted turn): nothing to
      // report and nowhere to report it.
      if (
        error instanceof RequestAbortedError ||
        abort.signal.aborted ||
        response.destroyed
      ) {
        return;
      }
      if (error instanceof ProviderTurnError) {
        const canonicalId = canonicalApiConversationId(ref);
        const status = providerErrorStatus(error);
        log.warn("API provider turn failed", {
          conversationId: canonicalId,
          reason: error.reason,
        });
        sendJson(response, status, {
          error: "provider_error",
          reason: error.reason,
        });
        return;
      }
      throw error;
    } finally {
      response.removeListener("close", onClose);
    }
  }

  // ThreadQueue.enqueue is fire-and-forget returning void, so wrap it: the
  // queued job runs the turn and settles this promise, and the HTTP handler
  // awaits the promise so the response blocks until the turn finishes. The
  // request abort signal is combined with the queue's own signal, so a client
  // disconnect aborts the in-flight provider turn, and a job whose request is
  // already closed is skipped before it ever reaches the provider.
  #runQueuedTurn(input: {
    canonicalId: string;
    conversation: ConversationManifest;
    participant: ConversationParticipant;
    input: string;
    requestSignal: AbortSignal;
  }): Promise<string> {
    return new Promise((resolveTurn, rejectTurn) => {
      this.#queue.enqueue(
        input.canonicalId,
        input.canonicalId,
        async (queueSignal) => {
          if (input.requestSignal.aborted) {
            log.info("skipping API turn for closed request", {
              conversationId: input.canonicalId,
            });
            rejectTurn(new RequestAbortedError());
            return;
          }
          const signal = AbortSignal.any([queueSignal, input.requestSignal]);
          try {
            const text = await this.#runTurn({
              canonicalId: input.canonicalId,
              conversation: input.conversation,
              participant: input.participant,
              input: input.input,
              signal,
            });
            resolveTurn(text);
          } catch (error) {
            rejectTurn(error);
          }
        },
      );
    });
  }

  async #runTurn(input: {
    canonicalId: string;
    conversation: ConversationManifest;
    participant: ConversationParticipant;
    input: string;
    signal: AbortSignal;
  }): Promise<string> {
    log.info("starting API conversation turn", {
      conversationId: input.canonicalId,
    });
    const instructions = await this.#contextCompiler.compile({
      conversation: input.conversation,
      deliveryInstructions: API_DELIVERY_INSTRUCTIONS,
      skillHintQuery: input.input,
    });
    const request: ProviderTurnRequest = {
      conversationId: input.canonicalId,
      instructions,
      input: formatApiTurn(input.participant, input.input),
      sessionMode: "persistent",
      platformContext: apiPlatformContext(input),
      accountRouting: input.participant.identityId
        ? { identityId: input.participant.identityId }
        : {},
      surfaceContext: API_SURFACE_CONTEXT,
      memoryContext: buildMemoryContext({
        dataDir: this.#config.paths.dataDir,
        conversation: input.conversation,
        participants: input.conversation.participants,
      }),
      signal: input.signal,
    };
    const response = await this.#provider.generateTurn(request);
    log.info("API provider turn finished", {
      conversationId: input.canonicalId,
      responseLength: response.text.length,
    });
    return response.text;
  }

  async #authenticate(
    request: IncomingMessage,
  ): Promise<ApiTokenEntry | undefined> {
    const token = bearerToken(request.headers.authorization);
    if (!token) return undefined;
    return this.#tokens.verify(token);
  }

  // The API caller authenticates to an existing human identity and reuses that
  // human's primary platform participant (Discord first, else GitHub). An API
  // turn therefore inherits that human's profile, instructions, personal memory
  // arena, and account routing: one shared brain across surfaces. The surface is
  // "api" (recorded in surfaceContext and the manifest), which stays distinct
  // from the participant platform. A human with no Discord or GitHub mapping
  // fails closed, so we never run an unmapped turn.
  async #participantForIdentity(
    entry: ApiTokenEntry,
  ): Promise<ConversationParticipant | undefined> {
    const identities = await this.#loadIdentities();
    const human = identities.humans.find(
      (item) => item.id === entry.identityId,
    );
    if (!human) return undefined;
    return apiParticipantFromHuman(human);
  }

  #loadIdentities(): Promise<HumanIdentityConfig> {
    this.#identities ??= loadHumanIdentities(this.#config.paths.configDirs);
    return this.#identities;
  }
}

class RequestAbortedError extends Error {
  constructor() {
    super("request aborted before turn completed");
    this.name = "RequestAbortedError";
  }
}

// Resolve a human identity to the API participant, reusing the human's primary
// platform account (Discord first, else GitHub) so the API turn shares that
// human's existing memory arena and account routing. Returns undefined when the
// human has no usable platform mapping so the caller can fail closed.
function apiParticipantFromHuman(
  human: HumanIdentityRecord,
): ConversationParticipant | undefined {
  const discord = human.platforms.discord;
  if (discord) {
    const participant: ConversationParticipant = {
      platform: "discord",
      platformUserId: discord.id ?? discord.username,
      username: discord.username,
      identityId: human.id,
      joinedAt: new Date().toISOString(),
    };
    if (human.displayName) participant.displayName = human.displayName;
    return participant;
  }
  const github = human.platforms.github;
  if (github) {
    const participant: ConversationParticipant = {
      platform: "github",
      platformUserId: github.id ?? github.login,
      username: github.login,
      identityId: human.id,
      joinedAt: new Date().toISOString(),
    };
    if (human.displayName) participant.displayName = human.displayName;
    return participant;
  }
  return undefined;
}

function apiPlatformContext(input: {
  canonicalId: string;
  conversation: ConversationManifest;
  participant: ConversationParticipant;
}): Record<string, unknown> {
  const surfaceContext = input.conversation.surfaceContext;
  const author: Record<string, unknown> = {
    platformUserId: input.participant.platformUserId,
    username: input.participant.username,
  };
  if (input.participant.displayName) {
    author["displayName"] = input.participant.displayName;
  }
  if (input.participant.identityId) {
    author["identityId"] = input.participant.identityId;
  }
  const context: Record<string, unknown> = {
    platform: input.participant.platform,
    surface: "api",
    conversationId: input.canonicalId,
    author,
  };
  const deviceId = surfaceContext?.["deviceId"];
  if (typeof deviceId === "string") {
    context["deviceId"] = deviceId;
  }
  return context;
}

function formatApiTurn(
  participant: ConversationParticipant,
  input: string,
): string {
  return [
    `<api_message identity_id="${participant.identityId ?? "unmapped"}" platform="${participant.platform}" platform_user_id="${participant.platformUserId}">`,
    "<metadata>",
    "account_routing_policy: per-human ChatGPT/Codex account routing",
    "account_routing_source: api_bearer_identity",
    `account_routing_identity_id: ${participant.identityId ?? "unmapped_fail_closed"}`,
    `account_routing_username: ${participant.username}`,
    `account_routing_display_name: ${participant.displayName ?? participant.username}`,
    "</metadata>",
    "",
    input,
    "</api_message>",
  ].join("\n");
}

// RFC 7235 `Bearer <token68>`: a single token of the token68 alphabet with no
// embedded or trailing whitespace and no extra fields. `Bearer abc def` and
// `Bearer ` are both rejected.
const BEARER_HEADER = /^Bearer (?<token>[A-Za-z0-9._~+/-]+=*)$/i;

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  return BEARER_HEADER.exec(header.trim())?.groups?.["token"];
}

type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; error: string };

function readJsonBody(request: IncomingMessage): Promise<JsonBodyResult> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (result: JsonBodyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveBody(result);
    };

    const timer = setTimeout(() => {
      request.destroy();
      finish({ ok: false, status: 408, error: "request_timeout" });
    }, BODY_READ_TIMEOUT_MS);

    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        // Stop buffering and deliberately stop reading so the caller can write
        // the JSON 413 to the still-open response, instead of destroying the
        // socket out from under the error. The server `requestTimeout` bounds
        // any remaining unread body.
        request.pause();
        request.removeAllListeners("data");
        finish({ ok: false, status: 413, error: "payload_too_large" });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        finish({ ok: false, status: 400, error: "empty_body" });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(raw) });
      } catch {
        finish({ ok: false, status: 400, error: "invalid_json" });
      }
    });
    request.on("error", () => {
      finish({ ok: false, status: 400, error: "request_error" });
    });
  });
}

type ParsedTurnBody =
  | { ok: true; input: string; title?: string }
  | { ok: false; error: string };

function parseTurnBody(value: unknown): ParsedTurnBody {
  if (!isRecord(value)) {
    return { ok: false, error: "invalid_body" };
  }
  const record = value;
  const input = record["input"];
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, error: "invalid_input" };
  }
  const title = record["title"];
  if (title !== undefined && typeof title !== "string") {
    return { ok: false, error: "invalid_title" };
  }
  if (typeof title === "string" && title.trim().length > 0) {
    return { ok: true, input, title };
  }
  return { ok: true, input };
}

function providerErrorStatus(error: ProviderTurnError): number {
  if (error.reason === "rate-limit" || error.reason === "quota-limit") {
    return 503;
  }
  return 502;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
