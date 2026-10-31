/**
 * Notification policies: what a local user's policy does with a notification from another
 * account, by how they are related, as Mastodon's. A notification it drops isn't made. One it
 * filters is kept aside, and a filtered mention is kept in a request from its account.
 * @see https://docs.joinmastodon.org/methods/notifications/#get-policy
 * @see https://github.com/mastodon/mastodon/blob/main/app/services/notify_service.rb
 * @module
 */
import { findAccount } from "../accounts/account_queries.ts";
import { followsFrom } from "../graph/follow_queries.ts";
import { followersAmong } from "../graph/follows.ts";
import type { Context } from "../kernel/context.ts";
import { findNote, mentionsOf, type NoteRow } from "../notes/note_queries.ts";
import { policiesOf, type Policy } from "./policy_queries.ts";
import type { NotificationType, PolicyAction } from "./tables.ts";

/**
 * The types of notifications a policy applies to: Mastodon's, and reactions, as likes. A status or
 * an edit from an account the user asked for isn't filtered.
 */
const filterable: ReadonlySet<NotificationType> = new Set([
    "mention",
    "reblog",
    "follow",
    "follow_request",
    "favourite",
    "reaction",
]);

const dayMs = 24 * 60 * 60 * 1000;

/** How long an account is new for, as on Mastodon. */
const newAccountMs = 30 * dayMs;

/** How long a follower is new for, and doesn't count as one yet, as on Mastodon. */
const newFollowerMs = 3 * dayMs;

/** How far up a thread a user's own direct status is looked for, as on Mastodon. */
const ancestorsAtMost = 100;

/** How a recipient is related to who caused the notification, as policies ask. */
type Relation = {
    readonly notFollowing: boolean;
    readonly notFollower: boolean;
    readonly newAccount: boolean;
    readonly privateMention: boolean;
};

/**
 * Whether `policy` does `action` with a notification from an account `relation` describes, as
 * Mastodon asks: limited accounts, which Verso doesn't have, then the others in its order.
 */
const doesWith = (policy: Policy, action: PolicyAction, relation: Relation) =>
    (policy.for_not_following === action && relation.notFollowing) ||
    (policy.for_not_followers === action && relation.notFollower) ||
    (policy.for_new_accounts === action && relation.newAccount && relation.notFollowing) ||
    (policy.for_private_mentions === action && relation.privateMention && relation.notFollowing);

/**
 * Of `accountIds`, those whose own direct status mentioning `fromId` is among the 100 that `note`
 * replies to, up its thread, so that it answers them.
 */
const answeredAmong = async (
    ctx: Context,
    note: NoteRow,
    fromId: string,
    accountIds: readonly string[],
) => {
    const theirs: NoteRow[] = [];
    const seen = new Set<string>();
    let parentId = note.in_reply_to_id;
    while (parentId !== null && seen.size < ancestorsAtMost && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = await findNote(ctx, parentId);
        if (parent === undefined) break;

        if (parent.visibility === "direct" && accountIds.includes(parent.account_id)) {
            theirs.push(parent);
        }
        parentId = parent.in_reply_to_id;
    }

    const mentions = await mentionsOf(ctx, theirs.map((parent) => parent.id));
    return new Set(
        theirs.filter((parent) => mentions.get(parent.id)?.includes(fromId))
            .map((parent) => parent.account_id),
    );
};

/**
 * What the policies of `accountIds`, local users, do with a notification of `type` from `fromId`,
 * about the status `noteId` if it has one: `drop` or `filter`, for those it doesn't accept. As on
 * Mastodon, any policy that drops it wins over any that filters it.
 */
export const verdictsOf = async (
    ctx: Context,
    accountIds: readonly string[],
    type: NotificationType,
    fromId: string,
    noteId: string | undefined,
): Promise<Map<string, Exclude<PolicyAction, "accept">>> => {
    const verdicts = new Map<string, Exclude<PolicyAction, "accept">>();
    if (!filterable.has(type)) return verdicts;

    const policies = await policiesOf(ctx, accountIds);
    const strict = accountIds.filter((id) => {
        const { for_limited_accounts: _, ...applied } = policies.get(id) ?? {};
        return Object.values(applied).some((action) => action !== "accept");
    });
    const from = strict.length === 0 ? undefined : await findAccount(ctx, fromId);
    if (from === undefined) return verdicts;

    const now = ctx.clock.now().getTime();
    const following = await followersAmong(ctx, fromId, strict);
    const followedBy = new Set(
        (await followsFrom(ctx, fromId, strict))
            .filter((follow) =>
                follow.accepted && follow.created_at.getTime() <= now - newFollowerMs
            )
            .map((follow) => follow.followee_id),
    );

    const note = type === "mention" && noteId !== undefined
        ? await findNote(ctx, noteId)
        : undefined;
    const direct = note?.visibility === "direct";
    const answered = note && direct ? await answeredAmong(ctx, note, fromId, strict) : new Set();

    for (const accountId of strict) {
        const policy = policies.get(accountId);
        if (policy === undefined) continue;

        const relation = {
            notFollowing: !following.has(accountId),
            notFollower: !followedBy.has(accountId),
            newAccount: from.created_at.getTime() > now - newAccountMs,
            privateMention: direct && !answered.has(accountId),
        };
        if (doesWith(policy, "drop", relation)) verdicts.set(accountId, "drop");
        else if (doesWith(policy, "filter", relation)) verdicts.set(accountId, "filter");
    }

    return verdicts;
};
