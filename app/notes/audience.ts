/**
 * Who a local status is shown to: the remote instances it is sent to, and those that may fetch it.
 * @module
 */
import { instancesHosting } from "../accounts/account_queries.ts";
import type { Visibility } from "../accounts/tables.ts";
import { followerInstances, hasFollowersOn } from "../graph/follows.ts";
import { findInstanceId } from "../instances/instance_queries.ts";
import type { Context } from "../kernel/context.ts";
import { mentionsOf, type NoteRow } from "./note_queries.ts";

/** The visibilities anyone may see. */
export const everyone: readonly Visibility[] = ["public", "unlisted"];

/**
 * The remote instances a local status is shown on: those of the users it mentions, those of the
 * author's followers unless it is direct, and the instance of the author of the status that a
 * public or unlisted status replies to, so that it can show the thread.
 */
export const audienceOf = async (
    ctx: Context,
    note: Pick<NoteRow, "account_id" | "visibility" | "in_reply_to_account_id">,
    mentionIds: readonly string[],
): Promise<string[]> => {
    const replied = everyone.includes(note.visibility) && note.in_reply_to_account_id !== null
        ? [note.in_reply_to_account_id]
        : [];
    const followers = note.visibility === "direct"
        ? []
        : await followerInstances(ctx, note.account_id);

    return [...new Set([...await instancesHosting(ctx, [...mentionIds, ...replied]), ...followers])]
        .toSorted();
};

/**
 * Whether the remote instance `requester` may see a local status. Anyone may see a public or
 * unlisted status. Otherwise an instance may see it if any of its users is in the audience, as
 * {@link audienceOf} computes it, without having to find every instance the author's followers are
 * on.
 */
export const instanceMaySee = async (
    ctx: Context,
    note: NoteRow,
    requester: string,
): Promise<boolean> => {
    if (everyone.includes(note.visibility)) return true;

    const instanceId = await findInstanceId(ctx, requester);
    if (instanceId === undefined) return false;

    const mentionIds = (await mentionsOf(ctx, [note.id])).get(note.id) ?? [];
    if ((await instancesHosting(ctx, mentionIds)).includes(instanceId)) return true;

    return note.visibility === "private" && await hasFollowersOn(ctx, note.account_id, instanceId);
};

/**
 * Whether the remote instance `requester` may see a local user's like, reaction or boost of `note`,
 * shown as `shown`: the status's own instance may, as may any instance that may see `shown`, which
 * is the status itself except for a boost.
 */
export const instanceMaySeeInteraction = async (
    ctx: Context,
    note: NoteRow,
    shown: NoteRow,
    requester: string,
): Promise<boolean> =>
    (note.instance_id !== null && note.instance_id === await findInstanceId(ctx, requester)) ||
    await instanceMaySee(ctx, shown, requester);
