import type { ExpressionBuilder, Insertable, Selectable, Updateable } from "kysely";
import { batchesOf } from "../db/batches.ts";
import { countAll, readCount } from "../db/count.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { Database } from "../db/database.ts";
import type { AccountIdQuery } from "../graph/follows.ts";
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

/** The notes of `ids` that exist, in no order. */
export const findNotes = async (ctx: Context, ids: readonly string[]): Promise<NoteRow[]> =>
    ids.length === 0
        ? []
        : await ctx.db.selectFrom("notes").selectAll().where("id", "in", ids).execute();

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

/**
 * The note with the id `remoteId` on the instance at `domain`, if Verso has it. It joins the
 * instances' table, as references name instances by domain.
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
 * The notes of `ids` that exist, with the domain of the instance each is from, or `null`, joining
 * the instances' table so a page of notes is one query.
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

/** An account's notes with one of `visibilities`, not its shares, oldest first, from `offset`. */
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

/** Which of an account's notes to page through, besides their visibility. */
export type NoteFilter = {
    /** Leaves out replies, other than to the account itself. */
    readonly excludeReplies?: boolean;
    /** Only those with this hashtag. */
    readonly tag?: string;
};

/** A page of an account's notes with one of `visibilities`, not its shares yet, newest first. */
export const notePageBy = async (
    ctx: Context,
    accountId: string,
    visibilities: readonly Visibility[],
    filter: NoteFilter,
    page: PageBounds,
): Promise<NoteRow[]> => {
    let query = ctx.db.selectFrom("notes").selectAll()
        .where("account_id", "=", accountId)
        .where("visibility", "in", visibilities)
        .where("reblog_of_id", "is", null);

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

/** Someone looking at notes, with the accounts they follow, or `null` for anyone. */
export type Onlooker = { readonly id: string; readonly followed: AccountIdQuery } | null;

/**
 * Whether `onlooker` may see a note, as `canSee` decides one at a time: public and unlisted notes
 * are for anyone, private ones for the author's followers, and direct ones for those they mention,
 * who may always see a note, as may its author.
 */
const seenBy = (onlooker: Onlooker) => (eb: ExpressionBuilder<Database, "notes">) => {
    const listed = eb("notes.visibility", "in", ["public", "unlisted"]);
    if (onlooker === null) return listed;

    return eb.or([
        listed,
        eb("notes.account_id", "=", onlooker.id),
        eb.and([
            eb("notes.visibility", "=", "private"),
            eb("notes.account_id", "in", onlooker.followed),
        ]),
        eb.exists(
            eb.selectFrom("note_mentions").select("note_mentions.note_id")
                .whereRef("note_mentions.note_id", "=", "notes.id")
                .where("note_mentions.account_id", "=", onlooker.id),
        ),
    ]);
};

/** Which of `ids` are notes `onlooker` may see, in no particular order. */
export const notesSeenBy = async (
    ctx: Context,
    ids: readonly string[],
    onlooker: Onlooker,
): Promise<Set<string>> => {
    if (ids.length === 0) return new Set();

    const rows = await ctx.db.selectFrom("notes").select("id")
        .where("id", "in", ids)
        .where(seenBy(onlooker))
        .execute();
    return new Set(rows.map((row) => row.id));
};

/**
 * The replies to any of `noteIds`, oldest first, at most `limit`, with whether `onlooker` may see
 * each.
 */
export const repliesTo = async (
    ctx: Context,
    noteIds: readonly string[],
    onlooker: Onlooker,
    limit: number,
): Promise<{ note: NoteRow; seen: boolean }[]> => {
    if (noteIds.length === 0) return [];

    const rows = await ctx.db.selectFrom("notes").selectAll()
        .select((eb) => seenBy(onlooker)(eb).as("seen"))
        .where("in_reply_to_id", "in", noteIds)
        .orderBy("id")
        .limit(limit)
        .execute();
    // SQLite gives 1 or 0.
    return rows.map(({ seen, ...note }) => ({ note, seen: Boolean(seen) }));
};

/** How a note links to another: by replying to it, or quoting it. */
export type NoteLink = "in_reply_to_id" | "quote_id";

/** The notes with one of `visibilities` that link to `noteId` by `link`. */
const linkedTo = (
    ctx: Context,
    link: NoteLink,
    noteId: string,
    visibilities: readonly Visibility[],
) => ctx.db.selectFrom("notes")
    .where(link, "=", noteId)
    .where("visibility", "in", visibilities)
    .where("reblog_of_id", "is", null);

/** The ids of the notes linking to `noteId`, as {@link linkedTo} finds them, oldest first. */
export const linkedNoteIds = async (
    ctx: Context,
    link: NoteLink,
    noteId: string,
    visibilities: readonly Visibility[],
    offset: number,
    limit: number,
): Promise<string[]> =>
    (await linkedTo(ctx, link, noteId, visibilities).select("id")
        .orderBy("id")
        .offset(offset)
        .limit(limit)
        .execute())
        .map((row) => row.id);

/** How many notes link to `noteId`, as {@link linkedTo} finds them. */
export const countLinkedNotes = async (
    ctx: Context,
    link: NoteLink,
    noteId: string,
    visibilities: readonly Visibility[],
): Promise<number> =>
    readCount(
        await linkedTo(ctx, link, noteId, visibilities).select(countAll).executeTakeFirstOrThrow(),
    );

/** How many notes an account has with one of `visibilities`, not counting its shares. */
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
export const isMentioned = async (
    ctx: Context,
    noteId: string,
    accountId: string,
): Promise<boolean> =>
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

/** Uncounts the public and unlisted replies an account wrote from the notes they reply to. */
export const uncountRepliesBy = async (ctx: Context, accountId: string): Promise<void> => {
    await ctx.db.updateTable("notes")
        .set((eb) => ({
            replies_count: eb(
                "replies_count",
                "-",
                eb.selectFrom("notes as reply")
                    .select((count) => count.fn.countAll<number>().as("count"))
                    .whereRef("reply.in_reply_to_id", "=", "notes.id")
                    .where("reply.account_id", "=", accountId)
                    .where("reply.visibility", "in", ["public", "unlisted"]),
            ),
        }))
        // Only the notes it replied to, rather than every note, less nothing.
        .where("id", "in", (eb) =>
            eb.selectFrom("notes as reply").select("reply.in_reply_to_id")
                .where("reply.account_id", "=", accountId))
        .execute();
};

/** Counts a share of a note, or one deleted. */
export const countShare = async (ctx: Context, noteId: string, by: 1 | -1): Promise<void> => {
    await ctx.db.updateTable("notes")
        .set((eb) => ({ shares_count: eb("shares_count", "+", by) }))
        .where("id", "=", noteId)
        .execute();
};

/** Uncounts the shares an account made from the notes they share. An account shares a note once. */
export const uncountSharesBy = async (ctx: Context, accountId: string): Promise<void> => {
    await ctx.db.updateTable("notes")
        .set((eb) => ({ shares_count: eb("shares_count", "-", 1) }))
        .where("id", "in", (eb) =>
            eb.selectFrom("notes as share").select("share.reblog_of_id")
                .where("share.account_id", "=", accountId)
                .where("share.reblog_of_id", "is not", null))
        .execute();
};

/**
 * Uncounts the shares of `noteId` from the statuses of the accounts that made them, as they go with
 * it. Direct ones aren't counted, so they aren't uncounted.
 */
export const uncountSharersOf = async (ctx: Context, noteId: string): Promise<void> => {
    await ctx.db.updateTable("accounts")
        .set((eb) => ({ statuses_count: eb("statuses_count", "-", 1) }))
        .where("id", "in", (eb) =>
            eb.selectFrom("notes").select("notes.account_id")
                .where("notes.reblog_of_id", "=", noteId)
                .where("notes.visibility", "!=", "direct"))
        .execute();
};

/**
 * Uncounts the shares of an account's notes from the statuses of the accounts that made them, as
 * they go with its notes when it is deleted.
 */
export const uncountSharersOfNotesBy = async (ctx: Context, authorId: string): Promise<void> => {
    const sharesBy = (eb: ExpressionBuilder<Database, "accounts">) =>
        eb.selectFrom("notes as share")
            .innerJoin("notes as shared", "shared.id", "share.reblog_of_id")
            .where("shared.account_id", "=", authorId)
            .where("share.visibility", "!=", "direct");

    await ctx.db.updateTable("accounts")
        .set((eb) => ({
            statuses_count: eb(
                "statuses_count",
                "-",
                sharesBy(eb).select((count) => count.fn.countAll<number>().as("count"))
                    .whereRef("share.account_id", "=", "accounts.id"),
            ),
        }))
        .where("id", "in", (eb) => sharesBy(eb).select("share.account_id"))
        .execute();
};
