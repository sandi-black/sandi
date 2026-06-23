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
          .setName("ignore")
          .setDescription(
            "Stop the current turn and ignore this channel/thread unless @-mentioned",
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
