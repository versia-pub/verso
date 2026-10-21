import type { Insertable, Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { NotesTable } from "./tables.ts";

export type NoteRow = Selectable<NotesTable>;

/** Adds a note, with the accounts it mentions and its hashtags, in lower case. */
export const insertNote = async (
    ctx: Context,
    note: Insertable<NotesTable>,
    mentionIds: readonly string[],
    tags: readonly string[],
): Promise<NoteRow> => {
    const row = await ctx.db.insertInto("notes").values(note).returningAll()
        .executeTakeFirstOrThrow();

    if (mentionIds.length > 0) {
        await ctx.db.insertInto("note_mentions")
            .values([...new Set(mentionIds)].map((account_id) => ({ note_id: row.id, account_id })))
            .execute();
    }

    if (tags.length > 0) {
        const names = new Set(tags.map((tag) => tag.toLowerCase()));
        await ctx.db.insertInto("note_tags")
            .values([...names].map((name) => ({ note_id: row.id, name })))
            .execute();
    }

    return row;
};

export const findNote = async (ctx: Context, id: string): Promise<NoteRow | undefined> =>
    await ctx.db.selectFrom("notes").selectAll().where("id", "=", id).executeTakeFirst();

/** The ids of the accounts each of `noteIds` mentions, by note. */
export const mentionsOf = async (
    ctx: Context,
    noteIds: readonly string[],
): Promise<Map<string, string[]>> => {
    const mentions = new Map<string, string[]>();
    if (noteIds.length === 0) return mentions;

    const rows = await ctx.db.selectFrom("note_mentions").selectAll()
        .where("note_id", "in", noteIds)
        .orderBy("account_id")
        .execute();
    for (const row of rows) {
        mentions.set(row.note_id, [...mentions.get(row.note_id) ?? [], row.account_id]);
    }

    return mentions;
};

/** The hashtags of each of `noteIds`, by note. */
export const tagsOf = async (
    ctx: Context,
    noteIds: readonly string[],
): Promise<Map<string, string[]>> => {
    const tags = new Map<string, string[]>();
    if (noteIds.length === 0) return tags;

    const rows = await ctx.db.selectFrom("note_tags").selectAll()
        .where("note_id", "in", noteIds)
        .orderBy("name")
        .execute();
    for (const row of rows) tags.set(row.note_id, [...tags.get(row.note_id) ?? [], row.name]);

    return tags;
};

/** Whether a note mentions an account. */
export const mentions = async (ctx: Context, noteId: string, accountId: string): Promise<boolean> =>
    await ctx.db.selectFrom("note_mentions").select("note_id")
        .where("note_id", "=", noteId)
        .where("account_id", "=", accountId)
        .executeTakeFirst() !== undefined;

/** Removes a note, and returns it, if there was one. */
export const deleteNote = async (ctx: Context, id: string): Promise<NoteRow | undefined> =>
    await ctx.db.deleteFrom("notes").where("id", "=", id).returningAll().executeTakeFirst();

/** Counts a reply to a note, or one deleted. */
export const countReply = async (ctx: Context, noteId: string, by: 1 | -1): Promise<void> => {
    await ctx.db.updateTable("notes")
        .set((eb) => ({ replies_count: eb("replies_count", "+", by) }))
        .where("id", "=", noteId)
        .execute();
};
