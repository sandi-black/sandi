import type { Logger } from "../logging";
import type { BrowserUseService } from "./service";

export type BrowserUseReaper = {
  stop(): void;
  sweep(): Promise<void>;
};

export function startBrowserUseReaper(input: {
  service: BrowserUseService;
  logger: Logger;
}): BrowserUseReaper {
  let stopped = false;
  let sweeping: Promise<void> | undefined;

  const sweep = async (): Promise<void> => {
    if (stopped || sweeping) return await (sweeping ?? Promise.resolve());
    const run = sweepExpired(input.service, input.logger).finally(() => {
      sweeping = undefined;
    });
    sweeping = run;
    return await run;
  };

  const timer = setInterval(() => {
    void sweep();
  }, input.service.config.reaperIntervalMs);
  timer.unref();
  void sweep();

  return {
    sweep,
    stop() {
      stopped = true;
      clearInterval(timer);
      void closeAllOpen(input.service, input.logger);
    },
  };
}

async function closeAllOpen(
  service: BrowserUseService,
  logger: Logger,
): Promise<void> {
  const open = await service.store.openSessions();
  const results = await Promise.allSettled(
    open.map((session) => service.stopSession(session)),
  );
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result?.status !== "rejected") continue;
    logger.error("failed to close Browser Use session during shutdown", {
      sessionId: open[index]?.id,
      error:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
    });
  }
}

async function sweepExpired(
  service: BrowserUseService,
  logger: Logger,
): Promise<void> {
  const now = Date.now();
  const open = await service.store.openSessions();
  for (const session of open) {
    const sessionExpired = new Date(session.expiresAt).getTime() <= now;
    const handoffExpired =
      session.state === "awaiting-human" &&
      new Date(session.handoff.expiresAt).getTime() <= now;
    if (!sessionExpired && !handoffExpired) continue;
    try {
      await service.stopSession(session);
      logger.info("closed expired Browser Use session", {
        sessionId: session.id,
        conversationId: session.conversationId,
      });
    } catch (error) {
      logger.error("failed to close expired Browser Use session", {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
