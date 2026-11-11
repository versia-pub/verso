import { showProcessedPictures } from "./accounts/profile.ts";
import { accountPermissions } from "./accounts/roles.ts";
import { authenticateToken } from "./auth/tokens.ts";
import { createResolver, type ResolverOptions } from "./federation/resolver.ts";
import { followDeliveries, profileDeliveries } from "./graph/federation.ts";
import { acceptWhenUnlocked, uncountFollowsOf } from "./graph/follows.ts";
import { queueMoves } from "./graph/moves.ts";
import type { AppServices } from "./http/env.ts";
import { instanceKey } from "./instances/keys.ts";
import { likeDeliveries } from "./interactions/federation.ts";
import { uncountLikesOf } from "./interactions/likes.ts";
import { reactionDeliveries } from "./interactions/reaction_federation.ts";
import { undoReactionsWithDeletedEmoji } from "./interactions/reactions.ts";
import { shareDeliveries } from "./interactions/share_federation.ts";
import { remoteKeys } from "./instances/remote_keys.ts";
import { cached } from "./kernel/cache.ts";
import { trackConversations } from "./conversations/conversations.ts";
import type { Context, Federation, Subscriber } from "./kernel/context.ts";
import { domainBlocks } from "./moderation/domain_blocks.ts";
import { blockedDomainNames } from "./moderation/domain_block_queries.ts";
import { noteDeliveries } from "./notes/federation.ts";
import { queueCards } from "./previews/cards.ts";
import { notifyOf } from "./notifications/notifications.ts";
import { voteDeliveries } from "./polls/federation.ts";
import { queuePollUpdate } from "./polls/updating.ts";
import { reportDeliveries } from "./reports/federation.ts";
import { uncountNotesOf } from "./notes/removal.ts";
import { vapidKey } from "./push/keys.ts";
import { queuePushes } from "./push/pushes.ts";
import { registry } from "./registry.ts";
import { indexAccountsOf } from "./search/accounts.ts";
import { indexStatuses } from "./search/notes.ts";
import { streamStatuses } from "./streaming/statuses.ts";

/** The services the HTTP app asks for, as Verso's modules provide them. */
export const appServices = (): AppServices => ({
    authenticate: authenticateToken,
    permissionsOf: accountPermissions,
});

/**
 * Who is notified of each event. Each runs inside the transaction that emitted it, so what it does
 * commits with the change, and each only does one of three kinds of thing, as grouped here.
 */
export const subscribers: readonly Subscriber[] = [
    // Queue jobs, for anything slow or sent elsewhere. A delivery queues one fan-out job, however
    // many followers it is for.
    // Before the profile is sent, so the followers it accepts are sent it too.
    acceptWhenUnlocked,
    queueMoves,
    profileDeliveries,
    followDeliveries,
    noteDeliveries,
    likeDeliveries,
    shareDeliveries,
    reactionDeliveries,
    voteDeliveries,
    queuePollUpdate,
    reportDeliveries,
    queueCards,
    queuePushes,
    // Write rows that must agree with the change: notifications, conversations, counts and the
    // search index. A few emit events of their own.
    showProcessedPictures,
    undoReactionsWithDeletedEmoji,
    notifyOf,
    trackConversations,
    uncountFollowsOf,
    uncountNotesOf,
    uncountLikesOf,
    indexStatuses,
    indexAccountsOf,
    // Tell other processes, once the transaction commits.
    streamStatuses,
];
/** How long the instance's keys and the blocked domains are cached before they are read again. */
const keptMs = 60_000;

/**
 * Federation as Verso's modules provide it, with `blockedDomains` as config blocks them. Create one
 * per process, so its keys are fetched once, and fetches in progress are shared.
 */
export const federation = (
    blockedDomains: readonly string[] = [],
    resolverOptions: ResolverOptions = {},
): Federation => {
    const key = cached(keptMs, instanceKey);
    const vapid = cached(keptMs, (ctx: Context) => vapidKey(ctx));
    const blocked = cached(keptMs, blockedDomainNames);

    return {
        instanceKey: key.get,
        vapidKey: vapid.get,
        remoteKeys: remoteKeys(),
        isBlocked: domainBlocks(blockedDomains, blocked.get),
        resolve: createResolver(registry, resolverOptions),
        forget: () => {
            key.clear();
            blocked.clear();
        },
    };
};
