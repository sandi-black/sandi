import assert from "node:assert/strict";

import { verifyDesktopFileDelivery } from "@/surfaces/discord/bot/verify-desktop-file-delivery";
import { DISCORD_DELIVERY_INSTRUCTIONS } from "@/surfaces/discord/discord/delivery-instructions";

assert.match(DISCORD_DELIVERY_INSTRUCTIONS, /# Discord Delivery/);
assert.match(DISCORD_DELIVERY_INSTRUCTIONS, /\[label\]\(url\)/);
assert.match(DISCORD_DELIVERY_INSTRUCTIONS, /not native superscript citation/);
assert.match(DISCORD_DELIVERY_INSTRUCTIONS, /Sources:/);
await verifyDesktopFileDelivery();

console.log("Discord delivery instruction verification passed");
