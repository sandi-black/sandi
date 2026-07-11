import { randomUUID } from "node:crypto";

import type { BrowserUseConfig } from "./config";
import {
  type AwaitingHumanSession,
  type BrowserProfile,
  type BrowserSession,
  BrowserSessionSchema,
  isOpenBrowserSession,
} from "./state";
import { BrowserUseStore } from "./store";
import {
  BrowserUse,
  BrowserUseError,
  type SessionResult,
} from "browser-use-sdk/v3";

export type BrowserTurnContext = {
  identityId: string;
  conversationId: string;
};

export type BrowserHandoffContext = BrowserTurnContext & {
  requesterPlatformUserId: string;
  surfaceTargetId: string;
};

export type BrowserTaskResult = {
  sessionId: string;
  output: string | null;
  successful: boolean | null;
  totalCostUsd: number;
};

export class BrowserUseService {
  readonly config: BrowserUseConfig;
  readonly store: BrowserUseStore;
  readonly #client: BrowserUse;

  constructor(config: BrowserUseConfig) {
    this.config = config;
    this.store = new BrowserUseStore(config.statePath);
    this.#client = new BrowserUse({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      timeout: 30_000,
    });
  }

  async startSession(input: {
    context: BrowserTurnContext;
    profileAlias: string;
    task: string;
  }): Promise<BrowserTaskResult> {
    const open = await this.store.openSessions(input.context.identityId);
    if (open.length >= this.config.maxConcurrentSessions) {
      throw new Error(
        `This identity already has ${open.length} open browser session(s); the configured limit is ${this.config.maxConcurrentSessions}`,
      );
    }

    const profile = await this.#ensureProfile(
      input.context.identityId,
      input.profileAlias,
    );
    const provider = await this.#client.sessions.create({
      model: this.config.model,
      profileId: profile.providerProfileId,
      keepAlive: true,
      maxCostUsd: this.config.maxTaskCostUsd,
      enableScheduledTasks: false,
      enableRecording: false,
      skills: false,
      agentmail: false,
      codeMode: false,
    });
    const now = new Date();
    const session = BrowserSessionSchema.parse({
      id: randomUUID(),
      providerSessionId: provider.id,
      identityId: input.context.identityId,
      conversationId: input.context.conversationId,
      profileAlias: profile.alias,
      providerProfileId: profile.providerProfileId,
      state: "running",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.config.maxSessionMinutes * 60_000,
      ).toISOString(),
      totalCostUsd: parseCost(provider.totalCostUsd),
    });
    await this.store.saveSession(session);

    try {
      return await this.#runTask(session, input.task);
    } catch (error) {
      await this.#closeFailed(session, error);
      throw error;
    }
  }

  async continueSession(input: {
    context: BrowserTurnContext;
    sessionId: string;
    task: string;
  }): Promise<BrowserTaskResult> {
    const session = await this.store.requireOwnedSession(
      input.sessionId,
      input.context.identityId,
    );
    if (session.conversationId !== input.context.conversationId) {
      throw new Error("Browser session belongs to a different conversation");
    }
    if (session.state !== "idle") {
      throw new Error(
        `Browser session cannot continue while it is ${session.state}`,
      );
    }
    const running = BrowserSessionSchema.parse({
      ...session,
      state: "running",
      updatedAt: new Date().toISOString(),
    });
    await this.store.saveSession(running);
    try {
      return await this.#runTask(running, input.task);
    } catch (error) {
      await this.#closeFailed(running, error);
      throw error;
    }
  }

  async requestHandoff(input: {
    context: BrowserHandoffContext;
    sessionId: string;
    reason: string;
  }): Promise<AwaitingHumanSession> {
    const session = await this.store.requireOwnedSession(
      input.sessionId,
      input.context.identityId,
    );
    if (session.conversationId !== input.context.conversationId) {
      throw new Error("Browser session belongs to a different conversation");
    }
    if (session.state !== "idle") {
      throw new Error(
        `Browser handoff requires an idle session, not ${session.state}`,
      );
    }
    const now = new Date();
    const handoff = BrowserSessionSchema.parse({
      ...session,
      state: "awaiting-human",
      updatedAt: now.toISOString(),
      handoff: {
        reason: input.reason,
        requesterPlatformUserId: input.context.requesterPlatformUserId,
        surfaceTargetId: input.context.surfaceTargetId,
        expiresAt: new Date(
          Math.min(
            new Date(session.expiresAt).getTime(),
            now.getTime() + this.config.handoffTtlMs,
          ),
        ).toISOString(),
      },
    });
    await this.store.saveSession(handoff);
    if (handoff.state !== "awaiting-human") {
      throw new Error("Browser handoff transition failed");
    }
    return handoff;
  }

  async markHandoffPromptSent(
    sessionId: string,
    messageId: string,
  ): Promise<void> {
    await this.store.updateSession(sessionId, (session) => {
      if (session.state !== "awaiting-human") return session;
      return BrowserSessionSchema.parse({
        ...session,
        updatedAt: new Date().toISOString(),
        handoff: { ...session.handoff, promptMessageId: messageId },
      });
    });
  }

  async acceptHandoff(input: {
    sessionId: string;
    requesterPlatformUserId: string;
  }): Promise<BrowserSession> {
    return await this.store.updateSession(input.sessionId, (session) => {
      requireHandoffOwner(session, input.requesterPlatformUserId);
      return BrowserSessionSchema.parse({
        ...session,
        state: "idle",
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async liveUrl(input: {
    sessionId: string;
    requesterPlatformUserId: string;
  }): Promise<string> {
    const session = await this.store.requireOwnedSession(
      input.sessionId,
      await this.#identityForHandoff(input),
    );
    requireHandoffOwner(session, input.requesterPlatformUserId);
    const provider = await this.#client.sessions.get(session.providerSessionId);
    if (!provider.liveUrl) {
      throw new Error("Browser Use did not return a live browser URL");
    }
    return provider.liveUrl;
  }

  async requireHandoff(input: {
    sessionId: string;
    requesterPlatformUserId: string;
    allowExpired?: boolean;
  }): Promise<AwaitingHumanSession> {
    const state = await this.store.read();
    const session = state.sessions.find(
      (candidate) => candidate.id === input.sessionId,
    );
    if (!session) throw new Error("Browser handoff was not found");
    requireHandoffOwner(
      session,
      input.requesterPlatformUserId,
      input.allowExpired ?? false,
    );
    return session;
  }

  async stopOwnedSession(input: {
    context: BrowserTurnContext;
    sessionId: string;
  }): Promise<BrowserSession> {
    const session = await this.store.requireOwnedSession(
      input.sessionId,
      input.context.identityId,
    );
    if (session.conversationId !== input.context.conversationId) {
      throw new Error("Browser session belongs to a different conversation");
    }
    return await this.stopSession(session);
  }

  async stopSession(session: BrowserSession): Promise<BrowserSession> {
    if (!isOpenBrowserSession(session)) return session;
    let totalCostUsd = session.totalCostUsd;
    try {
      const provider = await this.#client.sessions.stop(
        session.providerSessionId,
        { strategy: "session" },
      );
      totalCostUsd = parseCost(provider.totalCostUsd);
    } catch (error) {
      if (!(error instanceof BrowserUseError && error.statusCode === 404)) {
        throw error;
      }
    }
    const closed = BrowserSessionSchema.parse({
      ...session,
      state: "closed",
      updatedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      totalCostUsd,
    });
    await this.store.saveSession(closed);
    return closed;
  }

  async cancelHandoff(input: {
    sessionId: string;
    requesterPlatformUserId: string;
  }): Promise<BrowserSession> {
    const state = await this.store.read();
    const session = state.sessions.find(
      (candidate) => candidate.id === input.sessionId,
    );
    if (!session) throw new Error("Browser handoff was not found");
    requireHandoffOwner(session, input.requesterPlatformUserId, true);
    return await this.stopSession(session);
  }

  async sessionStatus(
    context: BrowserTurnContext,
    sessionId: string,
  ): Promise<BrowserSession> {
    return await this.store.requireOwnedSession(sessionId, context.identityId);
  }

  async #ensureProfile(
    identityId: string,
    alias: string,
  ): Promise<BrowserProfile> {
    const normalizedAlias = alias.trim();
    const existing = await this.store.findProfile(identityId, normalizedAlias);
    if (existing) return existing;
    const provider = await this.#client.profiles.create({
      name: normalizedAlias,
      userId: identityId,
    });
    const now = new Date().toISOString();
    const profile: BrowserProfile = {
      alias: normalizedAlias,
      providerProfileId: provider.id,
      identityId,
      createdAt: now,
      lastUsedAt: now,
    };
    await this.store.saveProfile(profile);
    return profile;
  }

  async #runTask(
    session: BrowserSession,
    task: string,
  ): Promise<BrowserTaskResult> {
    const result = await this.#client.run(task, {
      sessionId: session.providerSessionId,
      keepAlive: true,
      maxCostUsd: this.config.maxTaskCostUsd,
      model: this.config.model,
      skills: false,
      agentmail: false,
      enableScheduledTasks: false,
    });
    const totalCostUsd = parseCost(result.totalCostUsd);
    const idle = BrowserSessionSchema.parse({
      ...session,
      state: "idle",
      updatedAt: new Date().toISOString(),
      totalCostUsd,
    });
    await this.store.saveSession(idle);
    return taskResult(idle.id, result, totalCostUsd);
  }

  async #closeFailed(session: BrowserSession, error: unknown): Promise<void> {
    try {
      await this.#client.sessions.stop(session.providerSessionId, {
        strategy: "session",
      });
    } catch (stopError) {
      if (
        !(stopError instanceof BrowserUseError && stopError.statusCode === 404)
      ) {
        throw new AggregateError(
          [error, stopError],
          "Browser task and cleanup both failed",
        );
      }
    }
    const failed = BrowserSessionSchema.parse({
      ...session,
      state: "failed",
      updatedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      failure: errorMessage(error),
    });
    await this.store.saveSession(failed);
  }

  async #identityForHandoff(input: {
    sessionId: string;
    requesterPlatformUserId: string;
  }): Promise<string> {
    const state = await this.store.read();
    const session = state.sessions.find(
      (candidate) => candidate.id === input.sessionId,
    );
    if (!session) throw new Error("Browser handoff was not found");
    requireHandoffOwner(session, input.requesterPlatformUserId);
    return session.identityId;
  }
}

function requireHandoffOwner(
  session: BrowserSession,
  requesterPlatformUserId: string,
  allowExpired = false,
): asserts session is AwaitingHumanSession {
  if (
    session.state !== "awaiting-human" ||
    session.handoff.requesterPlatformUserId !== requesterPlatformUserId
  ) {
    throw new Error("Browser handoff is not available to this user");
  }
  if (
    !allowExpired &&
    new Date(session.handoff.expiresAt).getTime() <= Date.now()
  ) {
    throw new Error("Browser handoff has expired");
  }
}

function taskResult(
  sessionId: string,
  result: SessionResult<string | null>,
  totalCostUsd: number,
): BrowserTaskResult {
  return {
    sessionId,
    output: result.output,
    successful: result.isTaskSuccessful ?? null,
    totalCostUsd,
  };
}

function parseCost(raw: string): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
