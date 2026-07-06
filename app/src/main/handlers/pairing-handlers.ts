import { hostname } from "node:os";

import type { PairOutcomeSummary } from "@shared/ipc-contract";
import { IPC } from "@shared/ipc-contract";
import { ipcMain } from "electron";

import { PairCodeSchema } from "../ipc-schemas";
import {
  desktopConfigPath,
  resolveServerUrl,
  ServerUrlSchema,
  saveDesktopCredentials,
} from "@sandi-server/surfaces/api/client/credentials";
import { pairDesktop } from "@sandi-server/surfaces/api/client/pairing";

// First-run pairing from inside the chat window: redeem a one-time code from
// `/sandi auth` on Discord, store the token in the same credentials file the
// CLI uses (pairing once covers both), and restart the device link.

export function registerPairingHandlers(input: {
  onPaired(): Promise<void>;
}): void {
  ipcMain.handle(
    IPC.pairRedeem,
    async (_event, code: unknown): Promise<PairOutcomeSummary> => {
      const parsedCode = PairCodeSchema.safeParse(code);
      if (!parsedCode.success) {
        return { ok: false, error: "enter the code from /sandi auth" };
      }
      const rawUrl = resolveServerUrl(undefined, process.env["SANDI_API_URL"]);
      const parsedUrl = ServerUrlSchema.safeParse(rawUrl);
      if (!parsedUrl.success) {
        return { ok: false, error: `invalid server url: ${rawUrl}` };
      }
      const outcome = await pairDesktop({
        url: parsedUrl.data,
        code: parsedCode.data.trim(),
        label: hostname(),
      });
      if (!outcome.ok) {
        return { ok: false, error: outcome.error };
      }
      await saveDesktopCredentials(desktopConfigPath(), outcome.credentials);
      await input.onPaired();
      return {
        ok: true,
        identityId: outcome.credentials.identityId,
        deviceId: outcome.credentials.deviceId,
      };
    },
  );
}
