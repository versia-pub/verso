import { followedSubquery, sharingSubquery } from "../graph/follows.ts";
import { hiddenFrom } from "../graph/hidden.ts";
import type { Context } from "../kernel/context.ts";
import { exclusiveMembersSubquery, listMembersSubquery } from "../lists/list_queries.ts";
import type { ListRow } from "../lists/list_queries.ts";
import { followedTagsSubquery } from "../tags/tag_follow_queries.ts";
import type { HomeSources, ListSources } from "./timeline_queries.ts";

/** Whose statuses are on `viewerId`'s home timeline. */
export const homeSourcesOf = (ctx: Context, viewerId: string): HomeSources => ({
    followed: followedSubquery(ctx, viewerId),
    sharing: sharingSubquery(ctx, viewerId),
    followedTags: followedTagsSubquery(ctx, viewerId),
    exclusive: exclusiveMembersSubquery(ctx, viewerId),
    hidden: hiddenFrom(ctx, viewerId),
});

/** Whose statuses are on the list `list`. */
export const listSourcesOf = (ctx: Context, list: ListRow): ListSources => ({
    members: listMembersSubquery(ctx, list.account_id, list.id),
    followed: followedSubquery(ctx, list.account_id),
    sharing: sharingSubquery(ctx, list.account_id),
    repliesPolicy: list.replies_policy,
    hidden: hiddenFrom(ctx, list.account_id),
});
