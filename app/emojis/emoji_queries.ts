import type { ExpressionBuilder, Insertable, Selectable, Updateable } from "kysely";
import type { Database } from "../db/database.ts";
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

/**
 * Of emojis in shortcode order, each global one or `accountId`'s own, one per shortcode: the user's
 * own where both have it.
 */
const ownFirst = <E extends { readonly shortcode: string; readonly account_id: string | null }>(
    emojis: readonly E[],
): E[] => {
    const named = new Map<string, E>();
    for (const emoji of emojis) {
        if (!named.has(emoji.shortcode) || emoji.account_id !== null) {
            named.set(emoji.shortcode, emoji);
        }
    }

    return [...named.values()];
};

/** Only global emojis, or those and the local user `accountId`'s own. */
const usableBy = (accountId: string | null) => (eb: ExpressionBuilder<Database, "emojis">) =>
    accountId === null
        ? eb("emojis.account_id", "is", null)
        : eb.or([eb("emojis.account_id", "is", null), eb("emojis.account_id", "=", accountId)]);

/**
 * The ids of the local instance's custom emojis named any of `shortcodes` that the local user
 * `accountId` may use, by shortcode: global ones and their own, their own where both have a name,
 * or only global ones if `accountId` is `null`. Only those whose pictures are ready are, so that
 * text never uses an emoji that can't be shown. It reads the `media` table directly rather than
 * going through its module, so that it takes one query.
 */
export const usableEmojiIds = async (
    ctx: Context,
    accountId: string | null,
    shortcodes: readonly string[],
): Promise<string[]> => {
    if (shortcodes.length === 0) return [];

    const rows = await ctx.db.selectFrom("emojis")
        .innerJoin("media", "media.id", "emojis.media_id")
        .select(["emojis.id", "emojis.shortcode", "emojis.account_id"])
        .where("emojis.instance_id", "is", null)
        .where(usableBy(accountId))
        .where("emojis.shortcode", "in", shortcodes)
        // Processed and stored, as the local instance stores its emojis' pictures.
        .where("media.processed_at", "is not", null)
        .where("media.sha256", "is not", null)
        .orderBy("emojis.shortcode")
        .execute();
    return ownFirst(rows).map((row) => row.id);
};

export const insertEmoji = async (ctx: Context, emoji: Insertable<EmojisTable>): Promise<void> => {
    await ctx.db.insertInto("emojis").values(emoji).execute();
};

/**
 * Whether the local user `accountId` may already use an emoji named `shortcode`: their own, or a
 * global one, other than the emoji `except`.
 */
export const hasUsableEmoji = async (
    ctx: Context,
    accountId: string,
    shortcode: string,
    except?: string,
): Promise<boolean> => {
    let query = ctx.db.selectFrom("emojis").select("id")
        .where("instance_id", "is", null)
        .where("shortcode", "=", shortcode)
        .where((eb) => eb.or([eb("account_id", "=", accountId), eb("account_id", "is", null)]));
    if (except !== undefined) query = query.where("id", "!=", except);

    return await query.executeTakeFirst() !== undefined;
};

/**
 * Adds one of the local instance's emojis, and returns whether it was added, which it isn't if its
 * owner has one of that name, or, if it is global, a global one does.
 */
export const insertLocalEmoji = async (
    ctx: Context,
    emoji: Insertable<EmojisTable> & { readonly instance_id: null },
): Promise<boolean> => {
    const added = await ctx.db.insertInto("emojis").values(emoji)
        .onConflict((conflict) => conflict.doNothing())
        .returning("id")
        .executeTakeFirst();
    return added !== undefined;
};

/** Changes the emoji `id`. */
export const updateEmojiById = async (
    ctx: Context,
    id: string,
    changes: Pick<Updateable<EmojisTable>, "account_id" | "shortcode" | "media_id" | "category">,
): Promise<void> => {
    await ctx.db.updateTable("emojis").set(changes).where("id", "=", id).execute();
};

/** Deletes the emoji `id`. */
export const deleteEmojiById = async (ctx: Context, id: string): Promise<void> => {
    await ctx.db.deleteFrom("emojis").where("id", "=", id).execute();
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
    /** The emoji picker's group for it, or `null` for none. */
    readonly category: string | null;
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
    "emojis.category",
    "emojis.instance_id",
    "media.url",
    "media.media_type",
    "media.sha256",
    "media.preview_sha256",
    "media.processed_at",
] as const;

/**
 * The local instance's custom emojis that the local user `accountId` may use, by shortcode: global
 * ones and their own, their own where both have a name, or only global ones if `accountId` is
 * `null`. It reads the `media` table directly rather than going through its module, so that it
 * takes one query.
 */
export const usableEmojis = async (
    ctx: Context,
    accountId: string | null,
): Promise<ShownEmoji[]> =>
    ownFirst(
        await ctx.db.selectFrom("emojis")
            .innerJoin("media", "media.id", "emojis.media_id")
            .select(["emojis.account_id", ...shownColumns])
            .where("emojis.instance_id", "is", null)
            .where(usableBy(accountId))
            .orderBy("emojis.shortcode")
            .execute(),
    );

/** One of the local instance's emojis, with its owner and its picture's alt text. */
export type LocalEmoji = ShownEmoji & {
    readonly id: string;
    /** The user it belongs to, or `null` if it is global. */
    readonly account_id: string | null;
    readonly media_id: string;
    readonly description: string | null;
};

/**
 * One of the local instance's emojis, if there is one with this id. It reads the `media` table
 * directly rather than going through its module, so that it takes one query.
 */
export const findLocalEmoji = async (ctx: Context, id: string): Promise<LocalEmoji | undefined> =>
    await ctx.db.selectFrom("emojis")
        .innerJoin("media", "media.id", "emojis.media_id")
        .select([
            "emojis.id",
            "emojis.account_id",
            "emojis.media_id",
            "media.description",
            ...shownColumns,
        ])
        .where("emojis.id", "=", id)
        .where("emojis.instance_id", "is", null)
        .executeTakeFirst();

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
