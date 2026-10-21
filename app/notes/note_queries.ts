import type { Insertable, Selectable, Updateable } from "kysely";
import { countAll, readCount } from "../db/count.ts";
import type { Context } from "../kernel/context.ts";
import type { Visibility } from "../accounts/tables.ts";
import type { NotesTable, NoteVersionsTable } from "./tables.ts";

export type NoteRow = Selectable<NotesTable>;
export type NoteVersionRow = Selectable<NoteVersionsTable>;

/** Adds who a note mentions, and its hashtags, in lower case. */
const insertMentionsAndTags = async (
    ctx: Context,
    noteId: string,
    mentionIds: readonly string[],
    tags: readonly string[],
) => {
    if (mentionIds.length > 0) {
        await ctx.db.insertInto("note_mentions")
            .values([...new Set(mentionIds)].map((account_id) => ({ note_id: noteId, account_id })))
            .execute();
    }

    if (tags.length > 0) {
        const names = new Set(tags.map((tag) => tag.toLowerCase()));
        await ctx.db.insertInto("note_tags")
            .values([...names].map((name) => ({ note_id: noteId, name })))
            .execute();
    }
};

/** Adds a note, with the accounts it mentions and its hashtags, in lower case. */
export const insertNote = async (
    ctx: Context,
    note: Insertable<NotesTable>,
    mentionIds: readonly string[],
    tags: readonly string[],
): Promise<NoteRow> => {
    const row = await ctx.db.insertInto("notes").values(note).returningAll()
        .executeTakeFirstOrThrow();
    await insertMentionsAndTags(ctx, row.id, mentionIds, tags);

    return row;
};

/** Changes a note, and replaces who it mentions and its hashtags. */
export const updateNote = async (
    ctx: Context,
    id: string,
    changes: Updateable<NotesTable>,
    mentionIds: readonly string[],
    tags: readonly string[],
): Promise<void> => {
    await ctx.db.updateTable("notes").set(changes).where("id", "=", id).execute();

    await ctx.db.deleteFrom("note_mentions").where("note_id", "=", id).execute();
    await ctx.db.deleteFrom("note_tags").where("note_id", "=", id).execute();
    await insertMentionsAndTags(ctx, id, mentionIds, tags);
};

/** Keeps what `note` says now, before it is edited, for its edit history. */
export const keepVersion = async (ctx: Context, note: NoteRow): Promise<void> => {
    await ctx.db.insertInto("note_versions")
        .values({
            id: ctx.ids(),
            note_id: note.id,
            content_html: note.content_html,
            spoiler_text: note.spoiler_text,
            sensitive: note.sensitive,
            created_at: note.edited_at ?? note.created_at,
        })
        .execute();
};

/** What a note said before each of its edits, oldest first. */
export const versionsOf = async (ctx: Context, noteId: string): Promise<NoteVersionRow[]> =>
    await ctx.db.selectFrom("note_versions").selectAll()
        .where("note_id", "=", noteId)
        .orderBy("id")
        .execute();

export const findNote = async (ctx: Context, id: string): Promise<NoteRow | undefined> =>
    await ctx.db.selectFrom("notes").selectAll().where("id", "=", id).executeTakeFirst();

/** The note with the id `remoteId` on the instance `instanceId`, if Verso has it. */
export const findRemoteNote = async (
    ctx: Context,
    instanceId: string,
    remoteId: string,
): Promise<NoteRow | undefined> =>
    await ctx.db.selectFrom("notes").selectAll()
        .where("instance_id", "=", instanceId)
        .where("remote_id", "=", remoteId)
        .executeTakeFirst();

/** The note with the id `remoteId` on the instance at `domain`, if Verso has it. */
export const findRemoteNoteAt = async (
    ctx: Context,
    domain: string,
    remoteId: string,
): Promise<NoteRow | undefined> =>
    await ctx.db.selectFrom("notes").selectAll("notes")
        .innerJoin("instances", "instances.id", "notes.instance_id")
        .where("instances.domain", "=", domain)
        .where("notes.remote_id", "=", remoteId)
        .executeTakeFirst();

/** The notes of `ids` that exist, with the domain of the instance each is from, or `null`. */
export const noteOrigins = async (
    ctx: Context,
    ids: readonly string[],
): Promise<{ id: string; remote_id: string | null; domain: string | null }[]> =>
    ids.length === 0 ? [] : await ctx.db.selectFrom("notes")
        .leftJoin("instances", "instances.id", "notes.instance_id")
        .select(["notes.id", "notes.remote_id", "instances.domain"])
        .where("notes.id", "in", ids)
        .execute();

/** An account's notes with one of `visibilities`, oldest first, from `offset`. */
export const notesBy = async (
    ctx: Context,
    accountId: string,
    visibilities: readonly Visibility[],
    offset: number,
    limit: number,
): Promise<NoteRow[]> =>
    await ctx.db.selectFrom("notes").selectAll()
        .where("account_id", "=", accountId)
        .where("visibility", "in", visibilities)
        .orderBy("id")
        .offset(offset)
        .limit(limit)
        .execute();

/** How many notes an account has with one of `visibilities`. */
export const countNotesBy = async (
    ctx: Context,
    accountId: string,
    visibilities: readonly Visibility[],
): Promise<number> =>
    readCount(
        await ctx.db.selectFrom("notes").select(countAll)
            .where("account_id", "=", accountId)
            .where("visibility", "in", visibilities)
            .executeTakeFirstOrThrow(),
    );

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

/** Uncounts the replies an account wrote from the notes they reply to. */
export const uncountRepliesBy = async (ctx: Context, accountId: string): Promise<void> => {
    await ctx.db.updateTable("notes")
        .set((eb) => ({
            replies_count: eb(
                "replies_count",
                "-",
                eb.selectFrom("notes as reply")
                    .select((count) => count.fn.countAll<number>().as("count"))
                    .whereRef("reply.in_reply_to_id", "=", "notes.id")
                    .where("reply.account_id", "=", accountId),
            ),
        }))
        // Only the notes it replied to, rather than every note, less nothing.
        .where("id", "in", (eb) =>
            eb.selectFrom("notes as reply").select("reply.in_reply_to_id")
                .where("reply.account_id", "=", accountId))
        .execute();
};
