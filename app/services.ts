import { accountPermissions } from "./accounts/roles.ts";
import { authenticateToken } from "./auth/tokens.ts";
import type { AppServices } from "./http/env.ts";
import { instanceKey } from "./instances/keys.ts";
import { remoteKeys } from "./instances/remote_keys.ts";
import { domainBlocks } from "./moderation/domain_blocks.ts";

/**
 * The services the HTTP app asks for, as Verso's modules provide them. `blockedDomains` are the
 * ones config blocks.
 */
export const appServices = (blockedDomains: readonly string[] = []): AppServices => ({
    authenticate: authenticateToken,
    permissionsOf: accountPermissions,
    signingKey: async (ctx) => (await instanceKey(ctx)).privateKey,
    remoteKeys: remoteKeys(),
    isBlocked: domainBlocks(blockedDomains),
});
