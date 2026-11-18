/**
 * Who a local status is shown to: the remote instances it is sent to, and those that may fetch it.
 * @module
 */
import { instancesHosting } from "../accounts/account_queries.ts";
import type { Visibility } from "../kernel/visibility.ts";
import type { Audience } from "../federation/deliver.ts";
import { hasUnblockedFollowersOn } from "../graph/follows.ts";
import { findInstanceId } from "../instances/instance_queries.ts";
import type { Context } from "../kernel/context.ts";
import { mentionsOf, type NoteRow } from "./note_queries.ts";

/** The visibilities anyone may see. */
export const everyone: readonly Visibility[] = ["public", "unlisted"];

/**
 * The remote instances a local status is shown on. These are the instances of the users it
 * mentions and of the author of the status it replies to, and those of the author's followers
 * unless it is direct. A public or unlisted status also goes to the instance of `quotedAccountId`,
 * the author of the status it quotes.
 * @see https://versia.pub/extensions/social#delivery-and-access
 */
export const audienceOf = async (
    ctx: Context,
    note: Pick<NoteRow, "account_id" | "visibility" | "in_reply_to_account_id">,
    mentionIds: readonly string[],
    quotedAccountId: string | null = null,
): Promise<Audience> => {
    const quoted = everyone.includes(note.visibility) ? [quotedAccountId] : [];
    const linked = [note.in_reply_to_account_id, ...quoted].flatMap((id) => id ?? []);
    const instanceIds = await instancesHosting(ctx, [...mentionIds, ...linked]);

    return note.visibility === "direct"
        ? { instanceIds }
        : { instanceIds, followersOf: note.account_id };
};

/**
 * Whether the remote instance `requester` may see a local status. Anyone may see a public or
 * unlisted status. Otherwise an instance may see it if any of its users is in the audience, as
 * {@link audienceOf} computes it and a followers-only status is sent, without having to find every
 * instance the author's followers are on.
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
    const shownTo = [...mentionIds, note.in_reply_to_account_id].flatMap((id) => id ?? []);
    if ((await instancesHosting(ctx, shownTo)).includes(instanceId)) return true;

    return note.visibility === "private" &&
        await hasUnblockedFollowersOn(ctx, note.account_id, instanceId);
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
