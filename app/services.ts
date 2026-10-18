import { accountPermissions } from "./accounts/roles.ts";
import { authenticateToken } from "./auth/tokens.ts";
import type { AppServices } from "./http/env.ts";
import { instanceKey } from "./instances/keys.ts";
import { remoteKeys } from "./instances/remote_keys.ts";
import type { Federation } from "./kernel/context.ts";
import { domainBlocks } from "./moderation/domain_blocks.ts";

/** The services the HTTP app asks for, as Verso's modules provide them. */
export const appServices = (): AppServices => ({
    authenticate: authenticateToken,
    permissionsOf: accountPermissions,
});

/**
 * Federation as Verso's modules provide it, with `blockedDomains` as config blocks them. Make one
 * for each process, so its keys are fetched once.
 */
export const federation = (blockedDomains: readonly string[] = []): Federation => ({
    signingKey: async (ctx) => (await instanceKey(ctx)).privateKey,
    remoteKeys: remoteKeys(),
    isBlocked: domainBlocks(blockedDomains),
});
