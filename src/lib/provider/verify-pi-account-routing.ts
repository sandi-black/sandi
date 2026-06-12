import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PiAccountRouter,
  type PiAccountRoutingConfig,
} from "@/lib/provider/pi-account-routing";

const tempRoot = await mkdtemp(join(tmpdir(), "sandi-pi-routing-"));
const primaryAgentDir = join(tempRoot, "primary-agent");
const secondaryAgentDir = join(tempRoot, "secondary-agent");

try {
  await mkdir(primaryAgentDir, { recursive: true });
  await writeFile(join(primaryAgentDir, "auth.json"), "{}\n", "utf8");

  const config: PiAccountRoutingConfig = {
    accounts: [
      {
        id: "primary",
        agentDir: primaryAgentDir,
      },
      {
        id: "secondary",
        agentDir: secondaryAgentDir,
      },
    ],
    routes: [
      {
        identityId: "primary-human",
        accountId: "primary",
      },
      {
        identityId: "secondary-human",
        accountId: "secondary",
      },
    ],
  };
  const router = new PiAccountRouter(config);

  const secondaryBeforeLogin = await router.candidates({
    identityId: "secondary-human",
  });
  assert(
    secondaryBeforeLogin.length === 0,
    "Secondary turns must not fall back to primary when secondary auth.json is absent",
  );

  const primaryWhileSecondaryMissing = await router.candidates({
    identityId: "primary-human",
  });
  assertRoute(
    primaryWhileSecondaryMissing,
    "primary",
    "Primary human should use only the primary account",
  );

  await mkdir(secondaryAgentDir, { recursive: true });
  await writeFile(join(secondaryAgentDir, "auth.json"), "{}\n", "utf8");

  const secondaryAfterLogin = await router.candidates({
    identityId: "secondary-human",
  });
  assertRoute(
    secondaryAfterLogin,
    "secondary",
    "Secondary human should use only the secondary account",
  );

  const primaryAfterSecondaryLogin = await router.candidates({
    identityId: "primary-human",
  });
  assertRoute(
    primaryAfterSecondaryLogin,
    "primary",
    "Primary human should continue to use only the primary account after secondary login",
  );

  const unmappedHuman = await router.candidates({});
  assert(
    unmappedHuman.length === 0,
    "Unmapped human turns must fail closed with no account route",
  );

  const noRoutingRequest = await router.candidates(undefined);
  assert(
    noRoutingRequest.length === 0,
    "Turns without account-routing metadata must fail closed with no account route",
  );

  assertThrows(
    () =>
      new PiAccountRouter({
        ...config,
        routes: [
          {
            identityId: "secondary-human",
            accountId: "missing",
          },
        ],
      }),
    "Unknown account ids should fail during router construction",
  );

  console.log("Pi account routing verification passed");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertRoute(
  candidates: Awaited<ReturnType<PiAccountRouter["candidates"]>>,
  accountId: string,
  message: string,
): void {
  assert(
    candidates.map((candidate) => candidate.account.id).join(",") === accountId,
    message,
  );
}

function assertThrows(operation: () => unknown, message: string): void {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(message);
}
