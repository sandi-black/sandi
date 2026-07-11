import { z } from "zod/v4";

const BrowserProfileSchema = z.object({
  alias: z.string().min(1).max(100),
  providerProfileId: z.string().uuid(),
  identityId: z.string().min(1),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime(),
});

const BrowserSessionBaseSchema = z.object({
  id: z.string().uuid(),
  providerSessionId: z.string().uuid(),
  identityId: z.string().min(1),
  conversationId: z.string().min(1),
  profileAlias: z.string().min(1).max(100),
  providerProfileId: z.string().uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  totalCostUsd: z.number().nonnegative(),
});

const ActiveSessionSchema = BrowserSessionBaseSchema.extend({
  state: z.enum(["running", "idle"]),
});

const AwaitingHumanSessionSchema = BrowserSessionBaseSchema.extend({
  state: z.literal("awaiting-human"),
  handoff: z.object({
    reason: z.string().min(1).max(1_000),
    requesterPlatformUserId: z.string().min(1),
    surfaceTargetId: z.string().min(1),
    expiresAt: z.iso.datetime(),
    promptMessageId: z.string().min(1).optional(),
  }),
});

const TerminalSessionSchema = BrowserSessionBaseSchema.extend({
  state: z.enum(["closed", "failed"]),
  closedAt: z.iso.datetime(),
  failure: z.string().max(2_000).optional(),
});

export const BrowserSessionSchema = z.discriminatedUnion("state", [
  ActiveSessionSchema,
  AwaitingHumanSessionSchema,
  TerminalSessionSchema,
]);

export type BrowserSession = z.infer<typeof BrowserSessionSchema>;
export type AwaitingHumanSession = z.infer<typeof AwaitingHumanSessionSchema>;
export type BrowserProfile = z.infer<typeof BrowserProfileSchema>;

export const BrowserUseStateSchema = z.object({
  version: z.literal(1),
  profiles: z.array(BrowserProfileSchema),
  sessions: z.array(BrowserSessionSchema),
});

export type BrowserUseState = z.infer<typeof BrowserUseStateSchema>;

export const EMPTY_BROWSER_USE_STATE: BrowserUseState = {
  version: 1,
  profiles: [],
  sessions: [],
};

export function isOpenBrowserSession(session: BrowserSession): boolean {
  return session.state !== "closed" && session.state !== "failed";
}
