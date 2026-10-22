import { type Selectable, sql } from "kysely";
import { countAll, readCount } from "../db/count.ts";
import type { Context } from "../kernel/context.ts";
import type { ReactionsTable } from "./tables.ts";

export type ReactionRow = Selectable<ReactionsTable>;

/** What a reaction is made with: a Unicode emoji, as text, or a custom emoji, by id. */
export type ReactionEmoji =
    | { readonly text: string; readonly emoji_id: null }
    | { readonly text: null; readonly emoji_id: string };

/** Tells reactions with different emojis apart: by the emoji's text, or custom emoji's id. */
export const emojiKey = (emoji: Pick<ReactionRow, "text" | "emoji_id">): string =>
    emoji.text ?? emoji.emoji_id ?? "";

/**
 * Adds a local reaction, unless the account already reacts to the note with that emoji. Returns
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

/** Removes an account's reaction to a note with an emoji, and returns it, if there was one. */
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

/** The reactions to a note with one emoji, and the custom emoji's picture, if it is one. */
export type ReactionGroup = {
    readonly note_id: string;
    readonly text: string | null;
    readonly emoji_id: string | null;
    readonly shortcode: string | null;
    /** The custom emoji's instance, and its domain, or `null` if it is this one's, or Unicode. */
    readonly instance_id: string | null;
    readonly domain: string | null;
    readonly url: string | null;
    readonly media_type: string | null;
    readonly count: number;
    /** Whether the viewer is among them. */
    readonly me: boolean;
};

/**
 * The reactions to each of `noteIds`, by note, and by emoji in the order they were first used,
 * with whether `viewerId` made each, if there is a viewer.
 */
export const reactionsOf = async (
    ctx: Context,
    noteIds: readonly string[],
    viewerId: string | null,
): Promise<Map<string, ReactionGroup[]>> => {
    if (noteIds.length === 0) return new Map();

    const rows = await ctx.db.selectFrom("reactions")
        .leftJoin("emojis", "emojis.id", "reactions.emoji_id")
        .leftJoin("media", "media.id", "emojis.media_id")
        .leftJoin("instances", "instances.id", "emojis.instance_id")
        .select((eb) => [
            "reactions.note_id",
            "reactions.text",
            "reactions.emoji_id",
            "emojis.shortcode",
            "emojis.instance_id",
            "instances.domain",
            "media.url",
            "media.media_type",
            countAll(eb),
            eb.fn.min("reactions.id").as("first_id"),
            eb.fn.max(
                sql<number>`case when ${
                    eb.ref("reactions.account_id")
                } = ${viewerId} then 1 else 0 end`,
            ).as("me"),
        ])
        .where("reactions.note_id", "in", noteIds)
        .groupBy([
            "reactions.note_id",
            "reactions.text",
            "reactions.emoji_id",
            "emojis.shortcode",
            "emojis.instance_id",
            "instances.domain",
            "media.url",
            "media.media_type",
        ])
        .orderBy("first_id")
        .execute();

    const groups = new Map<string, ReactionGroup[]>();
    for (const { first_id: _, ...row } of rows) {
        const group = { ...row, count: readCount(row), me: Number(row.me) === 1 };
        groups.set(row.note_id, [...groups.get(row.note_id) ?? [], group]);
    }

    return groups;
};

/** Who reacts to a note with each emoji, newest first, by {@link emojiKey}. */
export const reactorsOf = async (
    ctx: Context,
    noteId: string,
): Promise<Map<string, string[]>> => {
    const rows = await ctx.db.selectFrom("reactions")
        .select(["account_id", "text", "emoji_id"])
        .where("note_id", "=", noteId)
        .orderBy("id", "desc")
        .execute();

    const reactors = new Map<string, string[]>();
    for (const row of rows) {
        const key = emojiKey(row);
        reactors.set(key, [...reactors.get(key) ?? [], row.account_id]);
    }

    return reactors;
};

/** A local user's reaction, with its custom emoji's shortcode and picture, if it is one. */
export type LocalReaction = ReactionRow & {
    readonly shortcode: string | null;
    readonly url: string | null;
    readonly media_type: string | null;
};

/** A local user's reaction, not one from another instance, if there is one with this id. */
export const findLocalReaction = async (
    ctx: Context,
    id: string,
): Promise<LocalReaction | undefined> =>
    await ctx.db.selectFrom("reactions")
        .innerJoin("accounts", "accounts.id", "reactions.account_id")
        .leftJoin("emojis", "emojis.id", "reactions.emoji_id")
        .leftJoin("media", "media.id", "emojis.media_id")
        .selectAll("reactions")
        .select(["emojis.shortcode", "media.url", "media.media_type"])
        .where("reactions.id", "=", id)
        .where("accounts.instance_id", "is", null)
        .executeTakeFirst();

/** The ids of a note's reactions, oldest first, from `offset`. */
export const reactionIdsOf = async (
    ctx: Context,
    noteId: string,
    offset: number,
    limit: number,
): Promise<string[]> =>
    (await ctx.db.selectFrom("reactions").select("id")
        .where("note_id", "=", noteId)
        .orderBy("id")
        .offset(offset)
        .limit(limit)
        .execute())
        .map((row) => row.id);

/** How many reactions a note has, of any emoji. */
export const countReactionsOf = async (ctx: Context, noteId: string): Promise<number> =>
    readCount(
        await ctx.db.selectFrom("reactions").select(countAll)
            .where("note_id", "=", noteId)
            .executeTakeFirstOrThrow(),
    );
