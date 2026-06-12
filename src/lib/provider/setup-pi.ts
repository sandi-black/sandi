import { loadCoreConfig } from "@/lib/config/env";
import { ensurePiRuntimeSetup } from "@/lib/provider/pi-runtime-setup";

const result = await ensurePiRuntimeSetup(loadCoreConfig().pi);

console.log(
  JSON.stringify(
    {
      installed: result.installed,
      alreadyInstalled: result.alreadyInstalled,
      removed: result.removed,
      codexConversionConfigs: result.codexConversionConfigs,
    },
    null,
    2,
  ),
);
