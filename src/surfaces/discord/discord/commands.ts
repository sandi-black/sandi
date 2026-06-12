import { SlashCommandBuilder } from "discord.js";

export function serializedCommands(): unknown[] {
  return [
    new SlashCommandBuilder()
      .setName("sandi")
      .setDescription("Sandi household bot commands")
      .addSubcommand((command) =>
        command.setName("help").setDescription("Show Sandi command help"),
      )
      .addSubcommand((command) =>
        command
          .setName("stop")
          .setDescription("Ask the current Sandi turn to stop"),
      )
      .addSubcommand((command) =>
        command
          .setName("thread")
          .setDescription("Branch this channel into a Sandi-managed thread")
          .addStringOption((option) =>
            option
              .setName("message")
              .setDescription("Message for the new thread")
              .setRequired(true)
              .setMaxLength(1800),
          )
          .addStringOption((option) =>
            option
              .setName("name")
              .setDescription("Optional thread name")
              .setMaxLength(100),
          ),
      )
      .addSubcommand((command) =>
        command
          .setName("todo")
          .setDescription("Create and pin an interactive todo list here"),
      )
      .addSubcommand((command) =>
        command.setName("status").setDescription("Show Sandi runtime status"),
      )
      .addSubcommandGroup((group) =>
        group
          .setName("events")
          .setDescription("Inspect Sandi scheduled events")
          .addSubcommand((command) =>
            command
              .setName("list")
              .setDescription("List scheduled events for this conversation")
              .addStringOption((option) =>
                option
                  .setName("scope")
                  .setDescription("Which events to list")
                  .addChoices(
                    { name: "Current conversation", value: "current" },
                    { name: "All events", value: "all" },
                  ),
              ),
          ),
      )
      .addSubcommandGroup((group) =>
        group
          .setName("reminders")
          .setDescription("Inspect interactive human reminders")
          .addSubcommand((command) =>
            command
              .setName("list")
              .setDescription("List reminders for this conversation")
              .addStringOption((option) =>
                option
                  .setName("scope")
                  .setDescription("Which reminders to list")
                  .addChoices(
                    { name: "Current conversation", value: "current" },
                    { name: "All reminders", value: "all" },
                  ),
              ),
          ),
      )
      .toJSON(),
  ];
}
