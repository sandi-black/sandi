import { z } from "zod/v4";
import type { DurableOutbox } from "@/lib/delivery/outbox";
import { SandiEventSchema } from "@/surfaces/discord/events/schemas";
import type { EventTrigger } from "@/surfaces/discord/events/watcher";

export const DISCORD_EVENT_DELIVERY = "discord-event-turn-v1";

const EventTriggerSchema = z.object({
  id: z.string().min(1),
  event: SandiEventSchema,
  label: z.string().min(1),
  occurrence: z.string().min(1),
});

export function registerDiscordEventDelivery(
  outbox: DurableOutbox,
  execute: (trigger: EventTrigger, signal: AbortSignal) => Promise<void>,
): void {
  outbox.register(DISCORD_EVENT_DELIVERY, async (record, signal) => {
    await execute(EventTriggerSchema.parse(record.payload), signal);
    return { status: "complete" };
  });
}

export async function enqueueDiscordEvent(
  outbox: DurableOutbox,
  trigger: EventTrigger,
): Promise<void> {
  await outbox.enqueue({
    idempotencyKey: `discord:event:${trigger.id}:${trigger.occurrence}`,
    kind: DISCORD_EVENT_DELIVERY,
    payload: EventTriggerSchema.parse(trigger),
  });
}
