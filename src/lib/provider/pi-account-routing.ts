import { access } from "node:fs/promises";
import { join } from "node:path";

export type PiAccountConfig = {
  id: string;
  displayName?: string;
  agentDir?: string;
  provider?: string;
  model?: string;
  thinking?: string;
};

export type PiIdentityAccountRoute = {
  identityId: string;
  accountId: string;
};

export type PiAccountRoutingConfig = {
  accounts: PiAccountConfig[];
  routes: PiIdentityAccountRoute[];
};

export type PiAccountRoutingRequest = {
  identityId?: string;
};

export type PiAccountCandidate = {
  account: PiAccountConfig;
};

export class PiAccountRouter {
  readonly #config: PiAccountRoutingConfig;

  constructor(config: PiAccountRoutingConfig) {
    validateAccountRoutingConfig(config);
    this.#config = config;
  }

  async candidates(
    request: PiAccountRoutingRequest | undefined,
  ): Promise<PiAccountCandidate[]> {
    const accountId = this.#routeAccountId(request);
    if (!accountId) return [];

    const account = this.#account(accountId);
    if (!account) return [];
    if (!(await isAccountAvailable(account))) return [];
    return [{ account }];
  }

  #routeAccountId(
    request: PiAccountRoutingRequest | undefined,
  ): string | undefined {
    if (!request?.identityId) return undefined;
    const route = this.#config.routes.find(
      (item) => item.identityId === request.identityId,
    );
    return route?.accountId;
  }

  #account(accountId: string): PiAccountConfig | undefined {
    return this.#config.accounts.find((account) => account.id === accountId);
  }
}

export async function isAccountAvailable(
  account: PiAccountConfig,
): Promise<boolean> {
  if (!account.agentDir) return true;
  try {
    await access(join(account.agentDir, "auth.json"));
    return true;
  } catch {
    return false;
  }
}

function validateAccountRoutingConfig(config: PiAccountRoutingConfig): void {
  const accountIds = new Set<string>();
  for (const account of config.accounts) {
    if (accountIds.has(account.id)) {
      throw new Error(`Duplicate Pi account id: ${account.id}`);
    }
    accountIds.add(account.id);
  }
  for (const route of config.routes) {
    assertKnownAccount(
      accountIds,
      route.accountId,
      `route for identity ${route.identityId}`,
    );
  }
}

function assertKnownAccount(
  accountIds: Set<string>,
  accountId: string,
  location: string,
): void {
  if (accountIds.has(accountId)) return;
  throw new Error(`Unknown Pi account id ${accountId} in ${location}`);
}
