import { accountPermissions } from "./accounts/roles.ts";
import { authenticateToken } from "./auth/tokens.ts";
import { createResolver } from "./federation/resolver.ts";
import { followDeliveries, profileDeliveries } from "./graph/federation.ts";
import { acceptWhenUnlocked, uncountFollowsOf } from "./graph/follows.ts";
import type { AppServices } from "./http/env.ts";
import { instanceKey } from "./instances/keys.ts";
import { likeDeliveries } from "./interactions/federation.ts";
import { uncountLikesOf } from "./interactions/likes.ts";
import { reactionDeliveries } from "./interactions/reaction_federation.ts";
import { shareDeliveries } from "./interactions/share_federation.ts";
import { remoteKeys } from "./instances/remote_keys.ts";
import { cached } from "./kernel/cache.ts";
import type { Federation, Subscriber } from "./kernel/context.ts";
import { blockedDomainNames, domainBlocks } from "./moderation/domain_blocks.ts";
import { noteDeliveries } from "./notes/federation.ts";
import { uncountNotesOf } from "./notes/notes.ts";
import { registry } from "./registry.ts";

/** The services the HTTP app asks for, as Verso's modules provide them. */
export const appServices = (): AppServices => ({
    authenticate: authenticateToken,
    permissionsOf: accountPermissions,
});

/** Who is told of each event. */
export const subscribers: readonly Subscriber[] = [
    // Before the profile is sent, so the followers it accepts are sent it too.
    acceptWhenUnlocked,
    profileDeliveries,
    followDeliveries,
    noteDeliveries,
    likeDeliveries,
    shareDeliveries,
    reactionDeliveries,
    uncountFollowsOf,
    uncountNotesOf,
    uncountLikesOf,
];

/** How long the instance's key and the blocked domains are kept before they are read again. */
const keptMs = 60_000;

/**
 * Federation as Verso's modules provide it, with `blockedDomains` as config blocks them. Make one
 * for each process, so its keys are fetched once, and fetches under way are shared.
 */
export const federation = (blockedDomains: readonly string[] = []): Federation => {
    const key = cached(keptMs, instanceKey);
    const blocked = cached(keptMs, blockedDomainNames);

    return {
        instanceKey: key.get,
        remoteKeys: remoteKeys(),
        isBlocked: domainBlocks(blockedDomains, blocked.get),
        resolve: createResolver(registry),
        forget: () => {
            key.clear();
            blocked.clear();
        },
    };
};
