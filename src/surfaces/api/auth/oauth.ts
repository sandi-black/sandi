import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  OAuthMetadata,
  OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/server";

import { z } from "zod/v4";
import { createLogger } from "@/lib/logging";
import {
  type AuthorizePageInput,
  sendAuthorizeError,
  sendAuthorizePage,
} from "@/surfaces/api/auth/oauth-page";
import type { PairingRedeemResult } from "@/surfaces/api/auth/pairing";
import { readFormBody, readJsonBody } from "@/surfaces/api/http/read-json-body";
import { sendJson } from "@/surfaces/api/http/respond";

const log = createLogger("api-oauth");

const AUTHORIZE_PATH = "/oauth/authorize";
const TOKEN_PATH = "/oauth/token";
const REGISTER_PATH = "/oauth/register";
// An agent redeems its authorization code as soon as the browser reaches its
// callback, so the code only has to outlive that redirect.
const AUTHORIZATION_CODE_TTL_MS = 60_000;
const BODY_MAX_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 15_000;
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const NO_STORE = { "cache-control": "no-store" };
// The authorization parameters the pairing form carries back on submit.
const AUTHORIZATION_FIELDS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "resource",
] as const;

const ClientSchema = z.object({
  redirect_uris: z
    .array(
      z.string().refine(isAllowedRedirectUri, {
        message: "must use https, or http on a loopback address",
      }),
    )
    .min(1),
  client_name: z.string().min(1).optional(),
});

type RegisteredClient = z.infer<typeof ClientSchema>;

type AuthorizationRequest = {
  client: RegisteredClient;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | undefined;
  fields: Map<string, string>;
};

type Grant = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  token: string;
  expiresAtMs: number;
};

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void> | void;

export type OAuthRoutesInput = {
  // The origin clients reach Sandi at: the OAuth issuer and the MCP resource's
  // base.
  publicUrl: string;
  mcpPath: string;
  allowPairingAttempt: (request: IncomingMessage) => boolean;
  redeemPairing: (body: {
    code: string;
    label: string;
  }) => Promise<PairingRedeemResult>;
};

// An OAuth 2.1 authorization server whose login is a Discord pairing code, so
// an MCP client such as Codex or ChatGPT enrolls the way the desktop app does.
// The client registers, opens the authorize page, and the member pastes a
// `/sandi auth` code there. Redeeming the code mints an ordinary per-device API
// token, which the client receives as its access token through the
// authorization code flow with PKCE.
export class OAuthRoutes {
  // The WWW-Authenticate value for a 401 from the MCP endpoint, which points a
  // client at the protected resource metadata (RFC 9728).
  readonly challenge: string;
  readonly #issuer: string;
  readonly #resource: string;
  readonly #allowPairingAttempt: OAuthRoutesInput["allowPairingAttempt"];
  readonly #redeemPairing: OAuthRoutesInput["redeemPairing"];
  // Codes live only in memory. A restart between the redirect and the token
  // request fails that one sign-in, and the member signs in again.
  readonly #grants = new Map<string, Grant>();
  readonly #routes: Map<string, Partial<Record<string, Handler>>>;

  constructor(input: OAuthRoutesInput) {
    this.#issuer = input.publicUrl;
    this.#resource = `${input.publicUrl}${input.mcpPath}`;
    this.#allowPairingAttempt = input.allowPairingAttempt;
    this.#redeemPairing = input.redeemPairing;
    const resourceMetadataPath = `/.well-known/oauth-protected-resource${input.mcpPath}`;
    this.challenge = `Bearer resource_metadata="${input.publicUrl}${resourceMetadataPath}"`;
    const resourceMetadata: OAuthProtectedResourceMetadata = {
      resource: this.#resource,
      authorization_servers: [this.#issuer],
      bearer_methods_supported: ["header"],
      resource_name: "Sandi",
    };
    const serverMetadata: OAuthMetadata = {
      issuer: this.#issuer,
      authorization_endpoint: `${this.#issuer}${AUTHORIZE_PATH}`,
      token_endpoint: `${this.#issuer}${TOKEN_PATH}`,
      registration_endpoint: `${this.#issuer}${REGISTER_PATH}`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    };
    this.#routes = new Map<string, Partial<Record<string, Handler>>>([
      [
        resourceMetadataPath,
        {
          GET: (_request, response) =>
            sendJson(response, 200, resourceMetadata),
        },
      ],
      [
        "/.well-known/oauth-authorization-server",
        {
          GET: (_request, response) => sendJson(response, 200, serverMetadata),
        },
      ],
      [
        REGISTER_PATH,
        { POST: (request, response) => this.#register(request, response) },
      ],
      [
        AUTHORIZE_PATH,
        {
          GET: (request, response) =>
            this.#showAuthorizePage(request, response),
          POST: (request, response) => this.#authorize(request, response),
        },
      ],
      [
        TOKEN_PATH,
        { POST: (request, response) => this.#token(request, response) },
      ],
    ]);
  }

  // Answers an OAuth path and returns true, or returns false for any other path.
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    path: string,
  ): Promise<boolean> {
    const route = this.#routes.get(path);
    if (!route) return false;
    const handler = route[method];
    if (handler) {
      await handler(request, response);
    } else {
      sendJson(response, 405, { error: "method_not_allowed" });
    }
    return true;
  }

  // Dynamic client registration (RFC 7591) that stores nothing: the client id
  // is the validated metadata, base64url-encoded, so a registration survives
  // restarts and cannot fill the disk. Anyone can mint such an id, but open
  // registration already lets anyone register any redirect URI. The safeguard is
  // the authorize page naming the host that receives the member's access.
  async #register(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(request, {
      maxBytes: BODY_MAX_BYTES,
      timeoutMs: BODY_TIMEOUT_MS,
      response,
    });
    if (!body.ok) {
      sendJson(response, body.status, { error: "invalid_client_metadata" });
      return;
    }
    const parsed = ClientSchema.safeParse(body.value);
    if (!parsed.success) {
      sendJson(response, 400, {
        error: parsed.error.issues.some(
          (issue) => issue.path[0] === "redirect_uris",
        )
          ? "invalid_redirect_uri"
          : "invalid_client_metadata",
        error_description: z.prettifyError(parsed.error),
      });
      return;
    }
    sendJson(
      response,
      201,
      {
        ...parsed.data,
        client_id: Buffer.from(JSON.stringify(parsed.data)).toString(
          "base64url",
        ),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      NO_STORE,
    );
  }

  #showAuthorizePage(request: IncomingMessage, response: ServerResponse): void {
    const params = new URL(request.url ?? "/", "http://localhost").searchParams;
    const parsed = this.#parseAuthorizationRequest(params);
    if (typeof parsed === "string") {
      sendAuthorizeError(response, 400, parsed);
      return;
    }
    sendAuthorizePage(response, 200, pageInput(parsed));
  }

  async #authorize(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readFormBody(request, {
      maxBytes: BODY_MAX_BYTES,
      timeoutMs: BODY_TIMEOUT_MS,
      response,
    });
    if (!body.ok) {
      sendAuthorizeError(
        response,
        body.status,
        "Sandi could not read the form.",
      );
      return;
    }
    const parsed = this.#parseAuthorizationRequest(body.value);
    if (typeof parsed === "string") {
      sendAuthorizeError(response, 400, parsed);
      return;
    }
    if (!this.#allowPairingAttempt(request)) {
      sendAuthorizePage(
        response,
        429,
        pageInput(
          parsed,
          "Too many attempts. Wait a few minutes, then try again.",
        ),
      );
      return;
    }
    const result = await this.#redeemPairing({
      code: body.value.get("code") ?? "",
      label: parsed.client.client_name ?? "MCP client",
    });
    if (!result.ok) {
      sendAuthorizePage(
        response,
        result.status,
        pageInput(
          parsed,
          result.error === "identity_unmapped"
            ? "Sandi has no platform account on file for you. Ask an admin to check your identity."
            : "That code did not work. Run /sandi auth for a new code, and paste it within 10 minutes.",
        ),
      );
      return;
    }

    const code = randomBytes(32).toString("base64url");
    const now = Date.now();
    for (const [key, grant] of this.#grants) {
      if (grant.expiresAtMs <= now) this.#grants.delete(key);
    }
    this.#grants.set(code, {
      clientId: parsed.clientId,
      redirectUri: parsed.redirectUri,
      codeChallenge: parsed.codeChallenge,
      token: result.token,
      expiresAtMs: now + AUTHORIZATION_CODE_TTL_MS,
    });
    log.info("authorized MCP client with a pairing code", {
      identityId: result.identityId,
      deviceId: result.deviceId,
    });
    const location = new URL(parsed.redirectUri);
    location.searchParams.set("code", code);
    if (parsed.state !== undefined) {
      location.searchParams.set("state", parsed.state);
    }
    // RFC 9207: the issuer lets the client detect a mix-up attack.
    location.searchParams.set("iss", this.#issuer);
    response.writeHead(303, { ...NO_STORE, location: location.href });
    response.end();
  }

  async #token(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readFormBody(request, {
      maxBytes: BODY_MAX_BYTES,
      timeoutMs: BODY_TIMEOUT_MS,
      response,
    });
    if (!body.ok) {
      sendJson(response, body.status, { error: "invalid_request" }, NO_STORE);
      return;
    }
    const params = body.value;
    if (params.get("grant_type") !== "authorization_code") {
      sendJson(response, 400, { error: "unsupported_grant_type" }, NO_STORE);
      return;
    }
    const code = params.get("code") ?? "";
    const grant = this.#grants.get(code);
    // The first redemption attempt spends a code, whether or not it succeeds.
    this.#grants.delete(code);
    const redirectUri = params.get("redirect_uri");
    if (
      !grant ||
      grant.expiresAtMs <= Date.now() ||
      params.get("client_id") !== grant.clientId ||
      (redirectUri !== null && redirectUri !== grant.redirectUri) ||
      s256(params.get("code_verifier") ?? "") !== grant.codeChallenge
    ) {
      sendJson(response, 400, { error: "invalid_grant" }, NO_STORE);
      return;
    }
    const resource = params.get("resource");
    if (resource !== null && resource !== this.#resource) {
      sendJson(response, 400, { error: "invalid_target" }, NO_STORE);
      return;
    }
    sendJson(
      response,
      200,
      { access_token: grant.token, token_type: "Bearer" },
      NO_STORE,
    );
  }

  // Validates an authorization request from the page URL or the submitted form.
  // Returns a message for the member when the request is unusable. The page
  // never redirects a bad request, so an unregistered redirect URI cannot turn
  // Sandi into an open redirector.
  #parseAuthorizationRequest(
    params: URLSearchParams,
  ): AuthorizationRequest | string {
    const clientId = params.get("client_id") ?? "";
    const client = decodeClientId(clientId);
    if (!client) return "The agent did not register with Sandi correctly.";
    const redirectUri = params.get("redirect_uri") ?? "";
    if (
      !client.redirect_uris.some((registered) =>
        redirectUriMatches(registered, redirectUri),
      )
    ) {
      return "The agent asked to receive your access at an address it did not register.";
    }
    const codeChallenge = params.get("code_challenge") ?? "";
    if (
      params.get("response_type") !== "code" ||
      params.get("code_challenge_method") !== "S256" ||
      !S256_CHALLENGE.test(codeChallenge)
    ) {
      return "The agent sent a request Sandi does not support. Sandi requires the authorization code flow with PKCE S256.";
    }
    const resource = params.get("resource");
    if (resource !== null && resource !== this.#resource) {
      return "The agent asked for access to a different server.";
    }
    const fields = new Map<string, string>();
    for (const field of AUTHORIZATION_FIELDS) {
      const value = params.get(field);
      if (value !== null) fields.set(field, value);
    }
    return {
      client,
      clientId,
      redirectUri,
      codeChallenge,
      state: params.get("state") ?? undefined,
      fields,
    };
  }
}

function pageInput(
  request: AuthorizationRequest,
  error?: string,
): AuthorizePageInput {
  const destination = new URL(request.redirectUri);
  return {
    clientName: request.client.client_name,
    destinationHost: destination.host,
    local: isLoopback(destination),
    fields: request.fields,
    ...(error !== undefined ? { error } : {}),
  };
}

function decodeClientId(clientId: string): RegisteredClient | undefined {
  try {
    const parsed = ClientSchema.safeParse(
      JSON.parse(Buffer.from(clientId, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// A native agent listens on whichever loopback port is free, so a loopback
// redirect matches on any port (RFC 8252, section 7.3). Every other redirect
// must match exactly.
function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  const expected = parseUrl(registered);
  const actual = parseUrl(requested);
  if (!expected || !actual) return false;
  if (expected.protocol !== "http:" || !isLoopback(expected)) return false;
  expected.port = "";
  actual.port = "";
  return expected.href === actual.href;
}

function isAllowedRedirectUri(value: string): boolean {
  const url = parseUrl(value);
  if (!url || url.hash) return false;
  return (
    url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url))
  );
}

function isLoopback(url: URL): boolean {
  return (
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "localhost"
  );
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}
