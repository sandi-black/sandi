import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";

import type { ContextCompiler } from "@/lib/context/context-compiler";
import { buildMemoryContext } from "@/lib/context/memory";
import type { ConversationStore } from "@/lib/conversations/store";
import {
  normalizeGeneratedTitle,
  TITLE_TURN_THINKING,
  TITLE_TURN_TIMEOUT_MS,
} from "@/lib/conversations/title";
import type {
  ConversationManifest,
  ConversationParticipant,
} from "@/lib/conversations/types";
import { HumanIdentityStore } from "@/lib/identity/resolver";
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
import {
  DESKTOP_TITLE_INSTRUCTIONS,
  DESKTOP_TITLE_MAX_LENGTH,
  DESKTOP_TITLE_PLACEHOLDER,
  desktopTitleRequestInput,
} from "@/surfaces/api/api/title";
import { handleAttachmentDownload } from "@/surfaces/api/attachments/download-route";
import { AttachmentStore } from "@/surfaces/api/attachments/store";
import {
  type AttachmentRef,
  AttachmentRefsSchema,
  cleanupMaterializedAttachments,
  InvalidAttachmentRefError,
  materializeAttachmentRefs,
} from "@/surfaces/api/attachments/turn-materialize";
import { handleAttachmentUpload } from "@/surfaces/api/attachments/upload-route";
import { redeemPairing } from "@/surfaces/api/auth/pairing";
import { apiParticipantFromHuman } from "@/surfaces/api/auth/participant";
import { FixedWindowLimiter } from "@/surfaces/api/auth/rate-limiter";
import { type ApiTokenEntry, ApiTokenStore } from "@/surfaces/api/auth/tokens";
import type { ApiAppConfig } from "@/surfaces/api/config";
import type { DeviceRegistry } from "@/surfaces/api/devices/device-registry";
import { DeviceRoutes } from "@/surfaces/api/devices/device-routes";
import type { ToolBroker } from "@/surfaces/api/devices/tool-broker";
import { readJsonBody } from "@/surfaces/api/http/read-json-body";
import { bearerToken, sendJson } from "@/surfaces/api/http/respond";
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
const TITLE_PATH = /^\/v1\/conversations\/([^/]+)\/title$/;
const AUTH_PAIR_PATH = "/v1/auth/pair";
// A desktop holds the link open (SSE) to receive tool calls and POSTs each
// result back as it finishes.
const DEVICE_LINK_PATH = "/v1/devices/link";
const DEVICE_RESULT_PATH = "/v1/devices/result";
const ATTACHMENTS_PATH = "/v1/attachments";
const ATTACHMENT_PATH = /^\/v1\/attachments\/([^/]+)$/;
// An attachment upload streams straight to disk rather than buffering a JSON
// body, so its cap is far larger than MAX_REQUEST_BODY_BYTES; the store itself
// enforces the real per-blob cap while streaming and aborts over it.
const ATTACHMENT_UPLOAD_TIMEOUT_MS = 5 * 60_000;

// Rate limits for the unauthenticated pairing endpoint. A code is a 50-bit
// single-use secret with a short TTL, so brute force is already infeasible;
// these windows cap how fast any one client, or the server as a whole, will
// consider a redemption, so a flood cannot grind the disk or chase codes. The
// limits leave plenty of room for a human mistyping a code a few times.
const PAIR_RATE_WINDOW_MS = 10 * 60_000;
const PAIR_RATE_MAX_PER_CLIENT = 10;
const PAIR_RATE_MAX_GLOBAL = 100;

export type ApiBotInput = {
  config: ApiAppConfig;
  conversations: ConversationStore;
  contextCompiler: ContextCompiler;
  provider: ModelProviderClient;
  // The device registry and tool broker are owned by the composition root and
  // shared across every surface, so a turn from any surface can reach the same
  // desktop links. The host starts and stops them; the api bot only registers
  // device links and leases per-turn tickets against them.
  devices: DeviceRegistry;
  broker: ToolBroker;
};

export class ApiBot {
  readonly #config: ApiAppConfig;
  readonly #conversations: ConversationStore;
  readonly #contextCompiler: ContextCompiler;
  readonly #provider: ModelProviderClient;
  readonly #queue = new ThreadQueue();
  readonly #tokens: ApiTokenStore;
  readonly #identities: HumanIdentityStore;
  readonly #pairLimiter = new FixedWindowLimiter(
    PAIR_RATE_WINDOW_MS,
    PAIR_RATE_MAX_PER_CLIENT,
    PAIR_RATE_MAX_GLOBAL,
  );
  readonly #devices: DeviceRegistry;
  readonly #broker: ToolBroker;
  readonly #deviceRoutes: DeviceRoutes;
  readonly #attachments: AttachmentStore;
  #server: Server | undefined;

  constructor(input: ApiBotInput) {
    this.#config = input.config;
    this.#conversations = input.conversations;
    this.#contextCompiler = input.contextCompiler;
    this.#provider = input.provider;
    this.#devices = input.devices;
    this.#broker = input.broker;
    this.#deviceRoutes = new DeviceRoutes(input.devices);
    // Content-addressed, alongside conversations under the same server data
    // dir, following the same per-surface data-dir resolution ConversationStore
    // uses (no separate config knob; attachments are server state, not
    // something an operator points elsewhere today).
    this.#attachments = new AttachmentStore(
      join(input.config.paths.dataDir, "attachments"),
    );
    // ttlMs 0 on both auth stores: re-stat on every check so a token minted by
    // the pairing endpoint authenticates immediately (no cache-window 401), a
    // revoked token stops working at once, and a removed or unmapped identity
    // stops authenticating with no restart. Both files are tiny and only re-read
    // when they actually change.
    this.#tokens = new ApiTokenStore(input.config.api.tokensPath, 0);
    this.#identities = new HumanIdentityStore(input.config.paths.configDirs, 0);
  }

  async start(): Promise<void> {
    if (this.#server) return;
    // The loopback tool broker must be reachable before any turn leases a ticket
    // for it. The composition root owns the broker's lifecycle (it is shared
    // across surfaces) and starts it before any bot, so we only assert it here
    // rather than starting it ourselves.
    if (!this.#broker.url()) {
      throw new Error("tool broker must be started before the API bot");
    }
    const server = createServer((request, response) => {
      void this.#handleRequest(request, response);
    });
    // Fail closed against slow-header / slow-request attacks at the socket
    // level, independent of the per-handler body deadline. These bound how long
    // a client may take to send a request, not how long a response may stay open,
    // so a held device-link stream is unaffected.
    server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
    server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
    this.#server = server;
    await new Promise<void>((resolveStart, rejectStart) => {
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
    // The shared device registry and tool broker are owned by the composition
    // root, which closes them once for the whole process. Closing them here
    // would tear down links and the broker out from under any other surface.
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

      if (path === AUTH_PAIR_PATH) {
        if (method !== "POST") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        await this.#handlePairRequest(request, response);
        return;
      }

      if (path === DEVICE_LINK_PATH) {
        if (method !== "GET") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const entry = await this.#authenticate(request);
        if (!entry) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        this.#deviceRoutes.handleLink(response, entry);
        return;
      }

      if (path === DEVICE_RESULT_PATH) {
        if (method !== "POST") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const entry = await this.#authenticate(request);
        if (!entry) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        await this.#deviceRoutes.handleResult(request, response, entry);
        return;
      }

      if (path === ATTACHMENTS_PATH) {
        if (method !== "POST") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const entry = await this.#authenticate(request);
        if (!entry) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        request.setTimeout(ATTACHMENT_UPLOAD_TIMEOUT_MS);
        await handleAttachmentUpload(request, response, {
          store: this.#attachments,
          identityId: entry.identityId,
        });
        return;
      }

      const attachmentMatch = ATTACHMENT_PATH.exec(path);
      if (attachmentMatch) {
        if (method !== "GET") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const entry = await this.#authenticate(request);
        if (!entry) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        let hash: string;
        try {
          hash = decodeURIComponent(attachmentMatch[1] ?? "");
        } catch (error) {
          if (error instanceof URIError) {
            sendJson(response, 404, { error: "unknown_attachment" });
            return;
          }
          throw error;
        }
        await handleAttachmentDownload(response, {
          store: this.#attachments,
          hash,
          identityId: entry.identityId,
        });
        return;
      }

      const titleMatch = TITLE_PATH.exec(path);
      if (titleMatch) {
        if (method !== "POST") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        let conversationId: string;
        try {
          conversationId = decodeURIComponent(titleMatch[1] ?? "");
        } catch (error) {
          if (error instanceof URIError) {
            sendJson(response, 400, { error: "invalid_conversation_id" });
            return;
          }
          throw error;
        }
        await this.#handleTitleRequest(request, response, conversationId);
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
    const participant = await this.#participantForIdentityId(entry.identityId);
    if (!participant) {
      // Fail closed: the token authenticated, but no such human identity is
      // configured, so we never run an unmapped turn against the provider.
      sendJson(response, 403, { error: "identity_unmapped" });
      return;
    }

    const body = await readJsonBody(request, {
      maxBytes: MAX_REQUEST_BODY_BYTES,
      timeoutMs: BODY_READ_TIMEOUT_MS,
    });
    if (!body.ok) {
      sendJson(response, body.status, { error: body.error });
      return;
    }
    const parsed = parseTurnBody(body.value);
    if (!parsed.ok) {
      sendJson(response, 400, { error: parsed.error });
      return;
    }

    // Resolve every attachment ref up front (before the turn is queued), so a
    // bad ref answers 400 without ever leasing a queue slot or spawning a
    // provider turn. Materializing copies each blob into a temp dir scoped to
    // this one turn; it is removed below regardless of how the turn ends.
    let materialized: { dir: string | undefined; paths: string[] };
    try {
      materialized = await materializeAttachmentRefs({
        store: this.#attachments,
        identityId: entry.identityId,
        refs: parsed.attachments ?? [],
      });
    } catch (error) {
      if (error instanceof InvalidAttachmentRefError) {
        sendJson(response, 400, {
          error: "invalid_attachment",
          hash: error.hash,
        });
        return;
      }
      throw error;
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
        deviceKey: entry.tokenSha256,
        input: parsed.input,
        ...(parsed.turnId !== undefined ? { turnId: parsed.turnId } : {}),
        ...(materialized.paths.length > 0
          ? { attachmentPaths: materialized.paths }
          : {}),
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
      await cleanupMaterializedAttachments(materialized.dir);
    }
  }

  // Names a conversation from a single message with a one-off, stateless model
  // turn: the desktop app posts its opening message here and renames its local
  // session from the reply, mirroring how the Discord surface names a freshly
  // created thread. The turn runs with sessionMode "none" against a synthetic
  // conversation id so it never touches the real conversation's session or
  // history, and without a tool broker so titling is a pure text call.
  async #handleTitleRequest(
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

    const participant = await this.#participantForIdentityId(entry.identityId);
    if (!participant) {
      sendJson(response, 403, { error: "identity_unmapped" });
      return;
    }

    const body = await readJsonBody(request, {
      maxBytes: MAX_REQUEST_BODY_BYTES,
      timeoutMs: BODY_READ_TIMEOUT_MS,
    });
    if (!body.ok) {
      sendJson(response, body.status, { error: body.error });
      return;
    }
    const parsed = parseTitleBody(body.value);
    if (!parsed.ok) {
      sendJson(response, 400, { error: parsed.error });
      return;
    }

    const canonicalId = canonicalApiConversationId(ref);

    // Tie the title turn to the client connection, so a desktop that closed the
    // request (it moved on, or a later message already renamed the session)
    // aborts the model rather than burning a Pi session on a title nobody wants.
    const abort = new AbortController();
    const onClose = (): void => {
      if (!response.writableFinished) abort.abort();
    };
    response.on("close", onClose);

    try {
      if (abort.signal.aborted) return;
      const title = await this.#generateTitle({
        canonicalId,
        participant,
        message: parsed.message,
        signal: abort.signal,
      });
      if (response.destroyed) return;
      sendJson(response, 200, { title });
    } catch (error) {
      if (abort.signal.aborted || response.destroyed) return;
      if (error instanceof ProviderTurnError) {
        const status = providerErrorStatus(error);
        log.warn("API title turn failed", {
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

  async #generateTitle(input: {
    canonicalId: string;
    participant: ConversationParticipant;
    message: string;
    signal: AbortSignal;
  }): Promise<string> {
    log.info("starting API title turn", { conversationId: input.canonicalId });
    const response = await this.#provider.generateTurn({
      // Synthetic id: a title turn is stateless and must not resume or write the
      // real conversation's persistent session.
      conversationId: `title:${input.canonicalId}`,
      instructions: DESKTOP_TITLE_INSTRUCTIONS,
      input: desktopTitleRequestInput({
        authorUsername: input.participant.username,
        authorDisplayName: input.participant.displayName,
        message: input.message,
      }),
      sessionMode: "none",
      accountRouting: input.participant.identityId
        ? { identityId: input.participant.identityId }
        : {},
      surfaceContext: API_SURFACE_CONTEXT,
      memoryContext: buildMemoryContext({
        dataDir: this.#config.paths.dataDir,
        participants: [input.participant],
      }),
      thinking: TITLE_TURN_THINKING,
      timeoutMs: TITLE_TURN_TIMEOUT_MS,
      signal: input.signal,
    });
    // Fall back to the placeholder the desktop already shows, which it treats as
    // "still untitled" and leaves in place rather than overwriting with junk.
    return (
      normalizeGeneratedTitle(response.text, DESKTOP_TITLE_MAX_LENGTH) ??
      DESKTOP_TITLE_PLACEHOLDER
    );
  }

  // Redeems a pairing code for a per-device bearer token. The endpoint is
  // unauthenticated because the code itself is the proof: it was issued to a
  // known human identity by an identity-bearing surface and is single-use with a
  // short TTL. This method is the HTTP shell (rate limit, read body, map the
  // result to a status); redeemPairing holds the enrollment logic. The raw token
  // is logged nowhere, only the identity and device it was minted for.
  async #handlePairRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.#pairLimiter.tryConsume(remoteKey(request))) {
      sendJson(response, 429, { error: "rate_limited" });
      return;
    }

    const body = await readJsonBody(request, {
      maxBytes: MAX_REQUEST_BODY_BYTES,
      timeoutMs: BODY_READ_TIMEOUT_MS,
    });
    if (!body.ok) {
      sendJson(response, body.status, { error: body.error });
      return;
    }

    const result = await redeemPairing({
      body: body.value,
      pairingsPath: this.#config.api.pairingsPath,
      tokensPath: this.#config.api.tokensPath,
      identities: this.#identities,
    });
    if (!result.ok) {
      sendJson(response, result.status, { error: result.error });
      return;
    }

    log.info("issued API device token via pairing", {
      identityId: result.identityId,
      deviceId: result.deviceId,
    });
    sendJson(response, 200, {
      surface: "api",
      identityId: result.identityId,
      deviceId: result.deviceId,
      label: result.label,
      token: result.token,
    });
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
    deviceKey: string;
    input: string;
    turnId?: string;
    attachmentPaths?: string[];
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
              deviceKey: input.deviceKey,
              input: input.input,
              ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
              ...(input.attachmentPaths
                ? { attachmentPaths: input.attachmentPaths }
                : {}),
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
    deviceKey: string;
    input: string;
    turnId?: string;
    attachmentPaths?: string[];
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

    // Hand the turn a tool broker only when the caller's own desktop is holding
    // a link. With no link, the proxy extension registers no tools and the turn
    // runs without file or shell access rather than touching the server.
    const lease = this.#devices.isConnected(input.deviceKey)
      ? this.#broker.lease({
          key: input.deviceKey,
          signal: input.signal,
          // The turn originated on this desktop, so a tool with no selector runs
          // here unconditionally rather than asking the model to pick.
          originDevice: true,
          ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
        })
      : undefined;
    try {
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
        ...(lease ? { localToolBroker: lease.ticket } : {}),
        ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
        ...(input.attachmentPaths
          ? { attachmentPaths: input.attachmentPaths }
          : {}),
        signal: input.signal,
      };
      const response = await this.#provider.generateTurn(request);
      log.info("API provider turn finished", {
        conversationId: input.canonicalId,
        responseLength: response.text.length,
        handsLocal: lease !== undefined,
      });
      return response.text;
    } finally {
      lease?.revoke();
    }
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
  // resolves to undefined so the turn never runs unmapped.
  async #participantForIdentityId(
    identityId: string,
  ): Promise<ConversationParticipant | undefined> {
    const identities = await this.#identities.load();
    const human = identities.humans.find((item) => item.id === identityId);
    if (!human) return undefined;
    return apiParticipantFromHuman(human);
  }
}

class RequestAbortedError extends Error {
  constructor() {
    super("request aborted before turn completed");
    this.name = "RequestAbortedError";
  }
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

type ParsedTurnBody =
  | {
      ok: true;
      input: string;
      title?: string;
      turnId?: string;
      attachments?: AttachmentRef[];
    }
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
  // An optional client-supplied id correlating this turn's streamed response.
  // The desktop generates it so it can bind its live preview to the right turn;
  // a caller that does not stream omits it and the server uses an internal id.
  const turnId = record["turnId"];
  if (
    turnId !== undefined &&
    (typeof turnId !== "string" || turnId.trim().length === 0)
  ) {
    return { ok: false, error: "invalid_turn_id" };
  }
  const rawAttachments = record["attachments"];
  let attachments: AttachmentRef[] | undefined;
  if (rawAttachments !== undefined) {
    const parsedAttachments = AttachmentRefsSchema.safeParse(rawAttachments);
    if (!parsedAttachments.success) {
      return { ok: false, error: "invalid_attachments" };
    }
    if (parsedAttachments.data.length > 0) attachments = parsedAttachments.data;
  }
  const base: {
    ok: true;
    input: string;
    title?: string;
    turnId?: string;
    attachments?: AttachmentRef[];
  } = {
    ok: true,
    input,
    ...(typeof title === "string" && title.trim().length > 0 ? { title } : {}),
    ...(typeof turnId === "string" ? { turnId } : {}),
    ...(attachments ? { attachments } : {}),
  };
  return base;
}

type ParsedTitleBody =
  | { ok: true; message: string }
  | { ok: false; error: string };

function parseTitleBody(value: unknown): ParsedTitleBody {
  if (!isRecord(value)) {
    return { ok: false, error: "invalid_body" };
  }
  const message = value["message"];
  if (typeof message !== "string" || message.trim().length === 0) {
    return { ok: false, error: "invalid_message" };
  }
  return { ok: true, message };
}

// Best-effort client key for rate limiting. The API surface is bound to a
// trusted interface, so the socket address is sufficient to throttle a single
// misbehaving client without any proxy-header trust.
function remoteKey(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
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
