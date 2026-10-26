import type { Insertable, Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { EmojisTable } from "./tables.ts";

export type EmojiRow = Selectable<EmojisTable>;

/** The custom emoji named `shortcode` on the instance `instanceId`, if Verso has it. */
export const findRemoteEmoji = async (
    ctx: Context,
    instanceId: string,
    shortcode: string,
): Promise<EmojiRow | undefined> =>
    await ctx.db.selectFrom("emojis").selectAll()
        .where("instance_id", "=", instanceId)
        .where("shortcode", "=", shortcode)
        .executeTakeFirst();

/** The ids of the local instance's custom emojis named any of `shortcodes`. */
export const localEmojiIds = async (
    ctx: Context,
    shortcodes: readonly string[],
): Promise<string[]> => {
    if (shortcodes.length === 0) return [];

    const rows = await ctx.db.selectFrom("emojis").select("id")
        .where("instance_id", "is", null)
        .where("shortcode", "in", shortcodes)
        .orderBy("shortcode")
        .execute();
    return rows.map((row) => row.id);
};

export const insertEmoji = async (ctx: Context, emoji: Insertable<EmojisTable>): Promise<void> => {
    await ctx.db.insertInto("emojis").values(emoji).execute();
};

/** Replaces the custom emojis a status uses. */
export const setNoteEmojis = async (
    ctx: Context,
    noteId: string,
    emojiIds: readonly string[],
): Promise<void> => {
    await ctx.db.deleteFrom("note_emojis").where("note_id", "=", noteId).execute();
    if (emojiIds.length === 0) return;

    await ctx.db.insertInto("note_emojis")
        .values(emojiIds.map((emojiId) => ({ note_id: noteId, emoji_id: emojiId })))
        .execute();
};

/** Replaces the custom emojis an account uses. */
export const setAccountEmojis = async (
    ctx: Context,
    accountId: string,
    emojiIds: readonly string[],
): Promise<void> => {
    await ctx.db.deleteFrom("account_emojis").where("account_id", "=", accountId).execute();
    if (emojiIds.length === 0) return;

    await ctx.db.insertInto("account_emojis")
        .values(emojiIds.map((emojiId) => ({ account_id: accountId, emoji_id: emojiId })))
        .execute();
};

/** Where a custom emoji's picture is: at a URL, or stored by Verso. */
export type EmojiPicture = {
    /** Where a remote emoji's picture is, or `null` if Verso stores it. */
    readonly url: string | null;
    readonly media_type: string;
    /** The keys a stored picture and its still preview are stored under, once processed. */
    readonly sha256: string | null;
    readonly preview_sha256: string | null;
    /** When a stored picture was processed, or `null` until then. */
    readonly processed_at: Date | null;
};

/** A custom emoji, with its picture. */
export type ShownEmoji = EmojiPicture & {
    readonly shortcode: string;
    /** The instance it is from, or `null` for the local instance. */
    readonly instance_id: string | null;
};

/** A custom emoji used by something. */
export type UsedEmoji = ShownEmoji & {
    /** The status or account that uses it. */
    readonly user_id: string;
};

/** The columns of {@link ShownEmoji}, from `emojis` joined with `media`. */
const shownColumns = [
    "emojis.shortcode",
    "emojis.instance_id",
    "media.url",
    "media.media_type",
    "media.sha256",
    "media.preview_sha256",
    "media.processed_at",
] as const;

/**
 * The local instance's custom emojis, by shortcode. It reads the `media` table directly rather than
 * going through its module, so that it takes one query.
 */
export const localEmojis = async (ctx: Context): Promise<ShownEmoji[]> =>
    await ctx.db.selectFrom("emojis")
        .innerJoin("media", "media.id", "emojis.media_id")
        .select(shownColumns)
        .where("emojis.instance_id", "is", null)
        .orderBy("emojis.shortcode")
        .execute();

/** Groups emojis by what uses them, in shortcode order. */
const byUser = (rows: readonly UsedEmoji[]) => {
    const groups = new Map<string, UsedEmoji[]>();
    for (const row of rows) groups.set(row.user_id, [...groups.get(row.user_id) ?? [], row]);

    return groups;
};

/**
 * The custom emojis each of `noteIds` uses, by status. It reads the `media` table directly rather
 * than going through its module, so that it takes one query.
 */
export const emojisOfNotes = async (
    ctx: Context,
    noteIds: readonly string[],
): Promise<Map<string, UsedEmoji[]>> => {
    if (noteIds.length === 0) return new Map();

    return byUser(
        await ctx.db.selectFrom("note_emojis")
            .innerJoin("emojis", "emojis.id", "note_emojis.emoji_id")
            .innerJoin("media", "media.id", "emojis.media_id")
            .select(["note_emojis.note_id as user_id", ...shownColumns])
            .where("note_emojis.note_id", "in", noteIds)
            .orderBy("emojis.shortcode")
            .execute(),
    );
};

/**
 * The custom emojis each of `accountIds` uses, by account. It reads the `media` table directly
 * rather than going through its module, so that it takes one query.
 */
export const emojisOfAccounts = async (
    ctx: Context,
    accountIds: readonly string[],
): Promise<Map<string, UsedEmoji[]>> => {
    if (accountIds.length === 0) return new Map();

    return byUser(
        await ctx.db.selectFrom("account_emojis")
            .innerJoin("emojis", "emojis.id", "account_emojis.emoji_id")
            .innerJoin("media", "media.id", "emojis.media_id")
            .select(["account_emojis.account_id as user_id", ...shownColumns])
            .where("account_emojis.account_id", "in", accountIds)
            .orderBy("emojis.shortcode")
            .execute(),
    );
};
