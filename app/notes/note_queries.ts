import type { Insertable, Selectable, Updateable } from "kysely";
import { batchesOf } from "../db/batches.ts";
import { countAll, readCount } from "../db/count.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { Context } from "../kernel/context.ts";
import type { Visibility } from "../accounts/tables.ts";
import { attachmentsOf, hasAttachments } from "../media/attachment_queries.ts";
import type { NoteIdQuery } from "./removal_queries.ts";
import type { NotesTable, NoteVersionsTable } from "./tables.ts";

export type NoteRow = Selectable<NotesTable>;

export type NoteVersionRow = Selectable<NoteVersionsTable>;

/** Adds the users a status mentions and its hashtags, in lower case. */
const insertMentionsAndTags = async (
    ctx: Context,
    noteId: string,
    mentionIds: readonly string[],
    tags: readonly string[],
) => {
    for (const batch of batchesOf([...new Set(mentionIds)])) {
        await ctx.db.insertInto("note_mentions")
            .values(batch.map((account_id) => ({ note_id: noteId, account_id })))
            .execute();
    }

    for (const batch of batchesOf([...new Set(tags.map((tag) => tag.toLowerCase()))])) {
        await ctx.db.insertInto("note_tags")
            .values(batch.map((name) => ({ note_id: noteId, name })))
            .execute();
    }
};

/** Adds a status, with the accounts it mentions and its hashtags in lower case. */
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

/** Updates a status, and replaces its mentions and hashtags. */
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

/** Saves the current text and media of `note`, before it is edited, as a version in its history. */
export const keepVersion = async (ctx: Context, note: NoteRow): Promise<void> => {
    const media = (await attachmentsOf(ctx, [note.id])).get(note.id) ?? [];

    await ctx.db.insertInto("note_versions")
        .values({
            id: ctx.ids(),
            note_id: note.id,
            content_html: note.content_html,
            spoiler_text: note.spoiler_text,
            sensitive: note.sensitive,
            media: media.map((row) => ({ id: row.id, description: row.description })),
            created_at: note.edited_at ?? note.created_at,
        })
        .execute();
};

/** What a status said before each of its edits, oldest first. */
export const versionsOf = async (ctx: Context, noteId: string): Promise<NoteVersionRow[]> =>
    await ctx.db.selectFrom("note_versions").selectAll()
        .where("note_id", "=", noteId)
        .orderBy("id")
        .execute();

export const findNote = async (ctx: Context, id: string): Promise<NoteRow | undefined> =>
    await ctx.db.selectFrom("notes").selectAll().where("id", "=", id).executeTakeFirst();

/** The statuses in `ids` that exist, in no particular order. */
export const findNotes = async (
    ctx: Pick<Context, "db">,
    ids: readonly string[],
): Promise<NoteRow[]> =>
    ids.length === 0
        ? []
        : await ctx.db.selectFrom("notes").selectAll().where("id", "in", ids).execute();

/** The status with the id `remoteId` on the instance `instanceId`, if Verso has it. */
export const findRemoteNote = async (
    ctx: Context,
    instanceId: string,
    remoteId: string,
): Promise<NoteRow | undefined> =>
    await ctx.db.selectFrom("notes").selectAll()
        .where("instance_id", "=", instanceId)
        .where("remote_id", "=", remoteId)
        .executeTakeFirst();

/**
 * The status with the id `remoteId` on the instance at `domain`, if Verso has it. It joins the
 * instances table, as references name instances by domain.
 */
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

/**
 * The statuses in `ids` that exist, each with the domain of its instance, or `null` for a local
 * status. It joins the instances table so a page of statuses takes one query.
 */
export const noteOrigins = async (
    ctx: Context,
    ids: readonly string[],
): Promise<{ id: string; remote_id: string | null; domain: string | null }[]> =>
    ids.length === 0 ? [] : await ctx.db.selectFrom("notes")
        .leftJoin("instances", "instances.id", "notes.instance_id")
        .select(["notes.id", "notes.remote_id", "instances.domain"])
        .where("notes.id", "in", ids)
        .execute();

/**
 * An account's statuses with one of `visibilities`, excluding boosts, oldest first, from `offset`.
 */
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
        .where("reblog_of_id", "is", null)
        .orderBy("id")
        .offset(offset)
        .limit(limit)
        .execute();

/** Which of an account's statuses to page through, besides their visibility. */
export type NoteFilter = {
    /** Excludes replies, other than replies to the account itself. */
    readonly excludeReplies?: boolean;
    /** Excludes boosts. */
    readonly excludeShares?: boolean;
    /** Only statuses with this hashtag. */
    readonly tag?: string;
    /** Only statuses with media attached, which boosts never have. */
    readonly onlyMedia?: boolean;
};

/** A page of an account's statuses and boosts with one of `visibilities`, newest first. */
export const notePageBy = async (
    ctx: Context,
    accountId: string,
    visibilities: readonly Visibility[],
    filter: NoteFilter,
    page: PageBounds,
): Promise<NoteRow[]> => {
    let query = ctx.db.selectFrom("notes").selectAll()
        .where("account_id", "=", accountId)
        .where("visibility", "in", visibilities);

    if (filter.excludeShares) query = query.where("reblog_of_id", "is", null);
    if (filter.onlyMedia) query = query.where(hasAttachments);
    if (filter.excludeReplies) {
        query = query.where((eb) =>
            eb.or([eb("in_reply_to_id", "is", null), eb("in_reply_to_account_id", "=", accountId)])
        );
    }

    const tag = filter.tag?.toLowerCase();
    if (tag !== undefined) {
        query = query.where((eb) =>
            eb.exists(
                eb.selectFrom("note_tags").select("note_tags.note_id")
                    .whereRef("note_tags.note_id", "=", "notes.id")
                    .where("note_tags.name", "=", tag),
            )
        );
    }

    return await readPage(query, "notes.id", page);
};

/** How many statuses an account has with one of `visibilities`, not counting boosts. */
export const countNotesBy = async (
    ctx: Context,
    accountId: string,
    visibilities: readonly Visibility[],
): Promise<number> =>
    readCount(
        await ctx.db.selectFrom("notes").select(countAll)
            .where("account_id", "=", accountId)
            .where("visibility", "in", visibilities)
            .where("reblog_of_id", "is", null)
            .executeTakeFirstOrThrow(),
    );

/** The ids of the accounts mentioned by each of `noteIds`, grouped by status. */
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

/** The hashtags of each of `noteIds`, grouped by status. */
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

/** Whether a status mentions an account. */
export const isMentioned = async (
    ctx: Context,
    noteId: string,
    accountId: string,
): Promise<boolean> =>
    await ctx.db.selectFrom("note_mentions").select("note_id")
        .where("note_id", "=", noteId)
        .where("account_id", "=", accountId)
        .executeTakeFirst() !== undefined;

/** Deletes a status, and returns it if it existed. */
export const deleteNote = async (ctx: Context, id: string): Promise<NoteRow | undefined> =>
    await ctx.db.deleteFrom("notes").where("id", "=", id).returningAll().executeTakeFirst();

/** Increments the reply count of a status, or decrements it when a reply is deleted. */
export const countReply = async (ctx: Context, noteId: string, by: 1 | -1): Promise<void> => {
    await ctx.db.updateTable("notes")
        .set((eb) => ({ replies_count: eb("replies_count", "+", by) }))
        .where("id", "=", noteId)
        .execute();
};

/**
 * Increments the like count of a status, or decrements it when a like is undone. Likes belong to
 * the interactions module.
 */
export const countLike = async (ctx: Context, noteId: string, by: 1 | -1): Promise<void> => {
    await ctx.db.updateTable("notes")
        .set((eb) => ({ likes_count: eb("likes_count", "+", by) }))
        .where("id", "=", noteId)
        .execute();
};

/**
 * Decrements the like count of each of `notes`, such as the statuses liked by an account that is
 * being deleted.
 */
export const uncountLikesOn = async (ctx: Context, notes: NoteIdQuery): Promise<void> => {
    await ctx.db.updateTable("notes")
        .set((eb) => ({ likes_count: eb("likes_count", "-", 1) }))
        .where("id", "in", notes)
        .execute();
};
