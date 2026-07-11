import { loadCoreConfig } from "@/lib/config/env";
import { preflightPiExtensions } from "@/lib/provider/pi-runtime-setup";

await preflightPiExtensions(loadCoreConfig().pi);

console.log("Pi extension load verification passed");
