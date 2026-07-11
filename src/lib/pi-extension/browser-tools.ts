import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadBrowserUseConfig } from "../browser-use/config";
import {
  type BrowserHandoffContext,
  type BrowserTurnContext,
  BrowserUseService,
} from "../browser-use/service";
import { textResult } from "./tool-results";
import { z } from "zod/v4";

const BrowserTurnSchema = z.object({
  surfaceTargetId: z.string().min(1).optional(),
  author: z.object({
    platformUserId: z.string().min(1),
    identityId: z.string().min(1),
  }),
});

let cachedService: BrowserUseService | undefined;

export default function browserToolsExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "browser_session_start",
      label: "Start authenticated browser",
      description:
        "Start a managed Browser Use session with a named persistent profile and run its first task. Use this only for authenticated or interactive browser work; use native web search for public research.",
      parameters: Type.Object({
        profileAlias: Type.String({
          description:
            "A stable human-readable profile name, such as personal-github.",
          minLength: 1,
          maxLength: 100,
        }),
        task: Type.String({
          description:
            "The bounded browser task. Stop before passwords, 2FA, passkeys, payments, or approvals that require the human.",
          minLength: 1,
          maxLength: 10_000,
        }),
      }),
      async execute(_toolCallId, params) {
        const context = readTurnContext();
        const result = await service().startSession({
          context,
          profileAlias: params.profileAlias,
          task: params.task,
        });
        return jsonResult(result);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "browser_session_handoff",
      label: "Request private browser handoff",
      description:
        "Pause an idle authenticated browser session for its requesting human. The active surface delivers a private handoff after the turn; the live URL is never returned to the model or posted publicly.",
      parameters: Type.Object({
        sessionId: Type.String({
          description: "Sandi's browser session id.",
          minLength: 1,
        }),
        reason: Type.String({
          description:
            "A short explanation of what the human must complete before choosing Continue.",
          minLength: 1,
          maxLength: 1_000,
        }),
      }),
      async execute(_toolCallId, params) {
        const handoff = await service().requestHandoff({
          context: readHandoffContext(),
          sessionId: params.sessionId,
          reason: params.reason,
        });
        return jsonResult({
          sessionId: handoff.id,
          state: handoff.state,
          handoffExpiresAt: handoff.handoff.expiresAt,
          message: "Private browser handoff queued.",
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "browser_session_continue",
      label: "Continue authenticated browser",
      description:
        "Continue an idle Browser Use session after the private handoff has been confirmed.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
        task: Type.String({ minLength: 1, maxLength: 10_000 }),
      }),
      async execute(_toolCallId, params) {
        const result = await service().continueSession({
          context: readTurnContext(),
          sessionId: params.sessionId,
          task: params.task,
        });
        return jsonResult(result);
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "browser_session_status",
      label: "Read browser status",
      description:
        "Read the caller-owned Browser Use session lifecycle and cost without exposing provider capability URLs.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
      }),
      async execute(_toolCallId, params) {
        const session = await service().sessionStatus(
          readTurnContext(),
          params.sessionId,
        );
        return jsonResult({
          sessionId: session.id,
          profileAlias: session.profileAlias,
          state: session.state,
          expiresAt: session.expiresAt,
          totalCostUsd: session.totalCostUsd,
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "browser_session_stop",
      label: "Stop authenticated browser",
      description:
        "Explicitly close a caller-owned Browser Use session so profile state is saved and billing stops.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
      }),
      async execute(_toolCallId, params) {
        const session = await service().stopOwnedSession({
          context: readTurnContext(),
          sessionId: params.sessionId,
        });
        return jsonResult({
          sessionId: session.id,
          state: session.state,
          totalCostUsd: session.totalCostUsd,
        });
      },
    }),
  );
}

function service(): BrowserUseService {
  if (cachedService) return cachedService;
  const dataDir = process.env["SANDI_DATA_DIR"]?.trim() || "data";
  const config = loadBrowserUseConfig(dataDir);
  if (!config) {
    throw new Error(
      "Authenticated browser sessions are disabled; configure SANDI_BROWSER_USE_API_KEY",
    );
  }
  cachedService = new BrowserUseService(config);
  return cachedService;
}

function readTurnContext(): BrowserTurnContext {
  const turn = readBrowserTurn();
  const conversationId = process.env["SANDI_CONVERSATION_ID"]?.trim();
  if (!conversationId) throw new Error("Browser tools require a conversation");
  return {
    identityId: turn.author.identityId,
    conversationId,
  };
}

function readHandoffContext(): BrowserHandoffContext {
  const turn = readBrowserTurn();
  if (!turn.surfaceTargetId) {
    throw new Error(
      "The active surface does not support private browser handoff",
    );
  }
  return {
    ...readTurnContext(),
    requesterPlatformUserId: turn.author.platformUserId,
    surfaceTargetId: turn.surfaceTargetId,
  };
}

function readBrowserTurn(): z.infer<typeof BrowserTurnSchema> {
  const raw = process.env["SANDI_PLATFORM_CONTEXT"]?.trim();
  if (!raw) {
    throw new Error(
      "Authenticated browser sessions require a mapped human turn",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Browser turn context is invalid JSON");
  }
  return BrowserTurnSchema.parse(parsed);
}

function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2), {});
}
