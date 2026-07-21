import { z } from "zod/v4";
import { discordChannelIdFromRef } from "@/surfaces/discord/discord/ids";
import {
  ReminderRecurrenceInputSchema,
  ReminderTimestampInputSchema,
  ReminderUserInputSchema,
} from "@/surfaces/discord/runtime/reminder-inputs";
import {
  DiscordChannelRefSchema,
  DiscordMessageIdSchema,
} from "@/surfaces/discord/runtime/targets";
import { cleanItemText } from "@/surfaces/discord/shared/todo-format";

const TodoChannelInputSchema = DiscordChannelRefSchema.transform(
  (value, context) => {
    try {
      return discordChannelIdFromRef(value);
    } catch {
      context.addIssue({
        code: "custom",
        message:
          "channel must be a Discord channel id, channel mention, or Discord message URL",
      });
      return z.NEVER;
    }
  },
);

const TodoTextInputSchema = z.string().transform((value, context) => {
  const text = cleanItemText(value);
  if (text) return text;
  context.addIssue({
    code: "custom",
    message: "todo text must contain at least two usable characters",
  });
  return z.NEVER;
});

const TodoItemIdInputSchema = z
  .string()
  .trim()
  .min(1, "itemId must not be empty");
const TodoMatchTextInputSchema = z
  .string()
  .trim()
  .min(1, "matchText must not be empty");
const OptionalTextInputSchema = z.string().trim().min(1).optional();
const OptionalNullableTextInputSchema = z
  .string()
  .trim()
  .min(1)
  .nullable()
  .optional();

const TodoSelectorShape = {
  itemId: TodoItemIdInputSchema.optional(),
  matchText: TodoMatchTextInputSchema.optional(),
};

function hasExactlyOneSelector(input: {
  itemId?: string | undefined;
  matchText?: string | undefined;
}): boolean {
  return Boolean(input.itemId) !== Boolean(input.matchText);
}

export const ListTodoItemsInputSchema = z.object({
  channel: TodoChannelInputSchema.optional(),
});

export const ConfigureTodoListInputSchema = z
  .object({
    channel: TodoChannelInputSchema.optional(),
    title: OptionalNullableTextInputSchema,
    instructions: OptionalNullableTextInputSchema,
    emptyText: OptionalNullableTextInputSchema,
    completionMode: z.enum(["select", "buttons"]).nullable().optional(),
    displayMode: z.enum(["default", "grouped-reminders"]).nullable().optional(),
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.instructions !== undefined ||
      input.emptyText !== undefined ||
      input.completionMode !== undefined ||
      input.displayMode !== undefined,
    "provide at least one todo list setting",
  );

export const AddTodoItemInputSchema = z
  .object({
    text: TodoTextInputSchema,
    channel: TodoChannelInputSchema.optional(),
    authorName: OptionalTextInputSchema,
    sourceUrl: OptionalTextInputSchema,
    reason: OptionalTextInputSchema,
    reminderAt: ReminderTimestampInputSchema.optional(),
    recurrence: ReminderRecurrenceInputSchema.optional(),
    recurrenceSummary: OptionalTextInputSchema,
    audienceUserIds: z.array(DiscordMessageIdSchema).optional(),
    createdBy: ReminderUserInputSchema.optional(),
  })
  .refine(
    (input) => !input.recurrenceSummary || Boolean(input.recurrence),
    "recurrenceSummary requires recurrence",
  );

export const UpdateTodoItemInputSchema = z
  .object({
    ...TodoSelectorShape,
    channel: TodoChannelInputSchema.optional(),
    text: TodoTextInputSchema.optional(),
    reason: OptionalNullableTextInputSchema,
    reminderAt: ReminderTimestampInputSchema.nullable().optional(),
    recurrence: ReminderRecurrenceInputSchema.nullable().optional(),
    recurrenceSummary: OptionalNullableTextInputSchema,
    audienceUserIds: z.array(DiscordMessageIdSchema).optional(),
    updatedBy: ReminderUserInputSchema.optional(),
  })
  .refine(hasExactlyOneSelector, "provide exactly one of itemId or matchText")
  .refine(
    (input) =>
      !(
        input.recurrence === null && typeof input.recurrenceSummary === "string"
      ),
    "recurrenceSummary cannot be set while removing recurrence",
  );

export const CompleteTodoItemInputSchema = z
  .object({
    ...TodoSelectorShape,
    channel: TodoChannelInputSchema.optional(),
    doneBy: ReminderUserInputSchema.optional(),
  })
  .refine(hasExactlyOneSelector, "provide exactly one of itemId or matchText");

export const RemoveTodoItemInputSchema = z
  .object({
    ...TodoSelectorShape,
    channel: TodoChannelInputSchema.optional(),
  })
  .refine(hasExactlyOneSelector, "provide exactly one of itemId or matchText");

export type ListTodoItemsInput = z.input<typeof ListTodoItemsInputSchema>;
export type ConfigureTodoListInput = z.input<
  typeof ConfigureTodoListInputSchema
>;
export type AddTodoItemInput = z.input<typeof AddTodoItemInputSchema>;
export type UpdateTodoItemInput = z.input<typeof UpdateTodoItemInputSchema>;
export type CompleteTodoItemInput = z.input<typeof CompleteTodoItemInputSchema>;
export type RemoveTodoItemInput = z.input<typeof RemoveTodoItemInputSchema>;
