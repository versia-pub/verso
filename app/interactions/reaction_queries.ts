import type { Insertable, Selectable } from "kysely";
import { countAll, readCount } from "../db/count.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import { type Excluded, notExcluded } from "../graph/blocks.ts";
import type { Context } from "../kernel/context.ts";
import type { ReactionsTable } from "./tables.ts";

export type ReactionRow = Selectable<ReactionsTable>;

/** What a reaction is made with: a Unicode emoji, as text, or a custom emoji, by id. */
export type ReactionEmoji =
    | { readonly text: string; readonly emoji_id: null }
    | { readonly text: null; readonly emoji_id: string };

/**
 * The emoji a reaction, or group of reactions, is made with. Each has its text or a custom emoji.
 */
export const emojiOf = (row: Pick<ReactionRow, "text" | "emoji_id">): ReactionEmoji => {
    if (row.text !== null) return { text: row.text, emoji_id: null };
    if (row.emoji_id !== null) return { text: null, emoji_id: row.emoji_id };

    throw new Error("A reaction has neither text nor a custom emoji");
};

/**
 * Adds a local reaction, unless the account already reacts to the status with that emoji. Returns
 * it if it was added.
 */
export const insertReaction = async (
    ctx: Context,
    accountId: string,
    noteId: string,
    emoji: ReactionEmoji,
): Promise<ReactionRow | undefined> =>
    await ctx.db.insertInto("reactions")
        .values({
            id: ctx.ids(),
            account_id: accountId,
            note_id: noteId,
            text: emoji.text,
            emoji_id: emoji.emoji_id,
            created_at: ctx.clock.now(),
        })
        // Either index of one reaction with each emoji.
        .onConflict((conflict) => conflict.doNothing())
        .returningAll()
        .executeTakeFirst();

/**
 * Adds a remote reaction, unless it, or the same one under another id, already exists. Returns
 * whether it was added.
 */
export const insertRemoteReaction = async (
    ctx: Context,
    reaction: Insertable<ReactionsTable>,
): Promise<boolean> =>
    await ctx.db.insertInto("reactions")
        .values(reaction)
        // Any index: by its remote id, or of one reaction with each emoji.
        .onConflict((conflict) => conflict.doNothing())
        .returning("id")
        .executeTakeFirst() !== undefined;

/** The reaction with the id `remoteId` on the instance `instanceId`, if Verso has it. */
export const findRemoteReaction = async (
    ctx: Context,
    instanceId: string,
    remoteId: string,
): Promise<ReactionRow | undefined> =>
    await ctx.db.selectFrom("reactions").selectAll()
        .where("instance_id", "=", instanceId)
        .where("remote_id", "=", remoteId)
        .executeTakeFirst();

/** Removes a reaction. */
export const deleteReactionById = async (ctx: Context, id: string): Promise<void> => {
    await ctx.db.deleteFrom("reactions").where("id", "=", id).execute();
};

/** Removes an account's reaction to a status with an emoji, and returns it, if there was one. */
export const deleteReaction = async (
    ctx: Context,
    accountId: string,
    noteId: string,
    emoji: ReactionEmoji,
): Promise<ReactionRow | undefined> => {
    const query = ctx.db.deleteFrom("reactions")
        .where("account_id", "=", accountId)
        .where("note_id", "=", noteId);

    return await (emoji.text === null
        ? query.where("emoji_id", "=", emoji.emoji_id)
        : query.where("text", "=", emoji.text))
        .returningAll()
        .executeTakeFirst();
};

/**
 * Deletes the reactions with the custom emoji `emojiId`, and returns them. Only local users react
 * with the local instance's emojis; remote users react with their instances' own.
 */
export const deleteReactionsWith = async (
    ctx: Context,
    emojiId: string,
): Promise<Pick<ReactionRow, "id" | "account_id" | "note_id">[]> =>
    await ctx.db.deleteFrom("reactions")
        .where("emoji_id", "=", emojiId)
        .returning(["id", "account_id", "note_id"])
        .execute();

/**
 * A page of the reactions to a status with one emoji, newest first, excluding those by the accounts
 * `blocked`.
 */
export const emojiReactionPage = async (
    ctx: Context,
    noteId: string,
    emoji: ReactionEmoji,
    blocked: Excluded | null,
    page: PageBounds,
): Promise<ReactionRow[]> => {
    let query = ctx.db.selectFrom("reactions").selectAll().where("note_id", "=", noteId);
    query = emoji.text === null
        ? query.where("emoji_id", "=", emoji.emoji_id)
        : query.where("text", "=", emoji.text);
    if (blocked !== null) query = query.where(notExcluded(blocked, "reactions.account_id"));

    return await readPage(query, "reactions.id", page);
};

/** A local user's reaction, with its custom emoji's shortcode and picture, if it is one. */
export type LocalReaction = ReactionRow & {
    readonly shortcode: string | null;
    readonly url: string | null;
    readonly media_type: string | null;
    readonly sha256: string | null;
    readonly preview_sha256: string | null;
    readonly processed_at: Date | null;
};

/**
 * A local user's reaction, not one from a remote instance, if there is one with this id. It reads
 * the `emojis` and `media` tables directly rather than going through their modules, so that it
 * takes one query.
 */
export const findLocalReaction = async (
    ctx: Context,
    id: string,
): Promise<LocalReaction | undefined> =>
    await ctx.db.selectFrom("reactions")
        .leftJoin("emojis", "emojis.id", "reactions.emoji_id")
        .leftJoin("media", "media.id", "emojis.media_id")
        .selectAll("reactions")
        .select([
            "emojis.shortcode",
            "media.url",
            "media.media_type",
            "media.sha256",
            "media.preview_sha256",
            "media.processed_at",
        ])
        .where("reactions.id", "=", id)
        .where("reactions.instance_id", "is", null)
        .executeTakeFirst();

/**
 * A status's reactions, oldest first, from `offset`: their local ids, and for remote ones, their
 * ids on the remote instance and the instances' domains. It reads the `instances` table directly
 * rather than going through its module, so that it takes one query.
 */
export const reactionPage = async (
    ctx: Context,
    noteId: string,
    offset: number,
    limit: number,
): Promise<{ id: string; remote_id: string | null; domain: string | null }[]> =>
    await ctx.db.selectFrom("reactions")
        .leftJoin("instances", "instances.id", "reactions.instance_id")
        .select(["reactions.id", "reactions.remote_id", "instances.domain"])
        .where("reactions.note_id", "=", noteId)
        .orderBy("reactions.id")
        .offset(offset)
        .limit(limit)
        .execute();

/** How many reactions a status has, of any emoji. */
export const countReactionsOf = async (ctx: Context, noteId: string): Promise<number> =>
    readCount(
        await ctx.db.selectFrom("reactions").select(countAll)
            .where("note_id", "=", noteId)
            .executeTakeFirstOrThrow(),
    );
