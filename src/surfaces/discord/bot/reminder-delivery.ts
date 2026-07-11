import { z } from "zod/v4";
import type { DeliveryRecord, DurableOutbox } from "@/lib/delivery/outbox";

export const DISCORD_REMINDER_DELIVERY = "discord-reminder-v1";

const ReminderDeliveryPayloadSchema = z.object({
  id: z.string().min(1),
  scheduledFireAt: z.string().min(1),
});

export type ReminderDeliveryPayload = z.infer<
  typeof ReminderDeliveryPayloadSchema
>;

export function registerDiscordReminderDelivery(
  outbox: DurableOutbox,
  execute: (
    payload: ReminderDeliveryPayload,
    record: DeliveryRecord,
    signal: AbortSignal,
  ) => Promise<void>,
): void {
  outbox.register(DISCORD_REMINDER_DELIVERY, async (record, signal) => {
    await execute(
      ReminderDeliveryPayloadSchema.parse(record.payload),
      record,
      signal,
    );
    return { status: "complete" };
  });
}

export async function enqueueDiscordReminder(
  outbox: DurableOutbox,
  payload: ReminderDeliveryPayload,
): Promise<void> {
  await outbox.enqueue({
    idempotencyKey: `discord:reminder:${payload.id}:${payload.scheduledFireAt}`,
    kind: DISCORD_REMINDER_DELIVERY,
    payload: ReminderDeliveryPayloadSchema.parse(payload),
  });
}
