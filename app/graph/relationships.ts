/**
 * How the viewer is connected to other accounts, as Mastodon's relationships show it.
 * @module
 */
import { existingAccountIds } from "../accounts/account_queries.ts";
import { NotFound } from "../http/errors.ts";
import type { RouteViewer } from "../http/route.ts";
import type { Context } from "../kernel/context.ts";
import { accountNotesOn } from "./account_note_queries.ts";
import { blocksBetween } from "./block_queries.ts";
import { domainBlockedAmong } from "./domain_block_queries.ts";
import { endorsedAmong } from "./endorsement_queries.ts";
import { followsFrom, followsOf } from "./follow_queries.ts";
import { mutesOf } from "./mute_queries.ts";
import { renderRelationship } from "./render.ts";
import { Relationship } from "@versia/client-api";

/**
 * How the viewer is connected to each of `ids` that is an account, in the order requested. Only a
 * viewer whose role lets them see everyone's blocks is shown who blocks them; to others, no one
 * does, so a block can't be found out.
 */
export const relationships = async (
    ctx: Context,
    viewer: UserViewer,
    ids: readonly string[],
): Promise<Relationship[]> => {
    const viewerId = viewer.accountId;
    const asked = [...new Set(ids)];
    const known = new Set(await existingAccountIds(ctx, asked));
    const outgoing = new Map(
        (await followsFrom(ctx, viewerId, asked)).map((row) => [row.followee_id, row]),
    );
    const incoming = new Map(
        (await followsOf(ctx, viewerId, asked)).map((row) => [row.follower_id, row]),
    );
    const { blocking, blockedBy } = await blocksBetween(ctx, viewerId, asked);
    const seesBlocks = (await viewer.permissions()).has("blocks");
    const domainBlocked = await domainBlockedAmong(ctx, viewerId, asked);
    const mutes = await mutesOf(ctx, viewerId, asked);
    const endorsed = await endorsedAmong(ctx, viewerId, asked);
    const notes = await accountNotesOn(ctx, viewerId, asked);

    return asked.filter((id) => known.has(id))
        .map((id) =>
            renderRelationship(
                id,
                outgoing.get(id),
                incoming.get(id),
                {
                    blocking: blocking.has(id),
                    blockedBy: seesBlocks && blockedBy.has(id),
                    domainBlocking: domainBlocked.has(id),
                },
                mutes.get(id),
                endorsed.has(id),
                notes.get(id) ?? "",
            )
        );
};

/** The viewer's relationship with one account. */
export const relationship = async (
    ctx: Context,
    viewer: UserViewer,
    id: string,
): Promise<Relationship> => {
    const [found] = await relationships(ctx, viewer, [id]);
    if (found === undefined) throw new NotFound();
    return found;
};

/** A viewer acting for a user. */
export type UserViewer = RouteViewer & { readonly accountId: string };
