/**
 * Who a local note is shown to: the other instances it is sent to, and those that may fetch it.
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
 * The other instances a local note is shown on: those of the users it mentions, of the author's
 * followers unless it is direct, and of the author of the note a public or unlisted one replies
 * to, which can then show the thread.
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
 * Whether `requester`, another instance, may see a local note: anyone may see a public or unlisted
 * one, and an instance may see another if any of its users is shown it, as {@link audienceOf} has
 * them, without finding every instance the author's followers are on.
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
 * Whether `requester`, another instance, may see a local user's like, reaction or share of `note`,
 * shown as `shown`: the note's own instance may, as may any instance that may see `shown`, which
 * is the note itself but for a share.
 */
export const instanceMaySeeInteraction = async (
    ctx: Context,
    note: NoteRow,
    shown: NoteRow,
    requester: string,
): Promise<boolean> =>
    (note.instance_id !== null && note.instance_id === await findInstanceId(ctx, requester)) ||
    await instanceMaySee(ctx, shown, requester);
