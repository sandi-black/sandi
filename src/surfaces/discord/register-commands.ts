import { REST, Routes } from "discord.js";

import { loadDiscordConfig } from "@/surfaces/discord/config";
import { serializedCommands } from "@/surfaces/discord/discord/commands";

const config = loadDiscordConfig();
const rest = new REST({ version: "10" }).setToken(config.token);

await rest.put(
  Routes.applicationGuildCommands(config.clientId, config.guildId),
  { body: serializedCommands() },
);

console.log(
  `Synchronized ${serializedCommands().length} Sandi application commands.`,
);
