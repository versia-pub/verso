import type { Insertable } from "kysely";
import { countNote } from "../accounts/count_queries.ts";
import type { Context } from "../kernel/context.ts";
import { insertNote, type NoteRow } from "./note_queries.ts";
import { countPosted } from "./notes.ts";
import type { NotesTable } from "./tables.ts";

/**
 * Adds a status by `accountId`, public and saying "Hi" unless `note` says otherwise, mentioning
 * `mentionIds`, and counts it, as posting would.
 */
export const createNote = async (
    ctx: Context,
    accountId: string,
    note: Partial<Insertable<NotesTable>> = {},
    mentionIds: readonly string[] = [],
    tags: readonly string[] = [],
): Promise<NoteRow> => {
    const row = await insertNote(
        ctx,
        {
            id: ctx.ids(),
            account_id: accountId,
            instance_id: null,
            remote_id: null,
            visibility: "public",
            content: "Hi",
            content_format: "text/plain",
            content_html: "<p>Hi</p>",
            language: null,
            in_reply_to_id: null,
            in_reply_to_account_id: null,
            created_at: ctx.clock.now(),
            edited_at: null,
            ...note,
        },
        mentionIds,
        tags,
    );
    await countNote(ctx, accountId, 1, row.created_at);

    return row;
};

/** Adds a public boost by `accountId` of `noteId`, and counts it, as boosting would. */
export const createShare = async (
    ctx: Context,
    accountId: string,
    noteId: string,
    share: Partial<Insertable<NotesTable>> = {},
): Promise<NoteRow> => {
    const row = await insertNote(
        ctx,
        {
            id: ctx.ids(),
            account_id: accountId,
            instance_id: null,
            remote_id: null,
            visibility: "public",
            content: "",
            content_format: "text/plain",
            content_html: "",
            language: null,
            in_reply_to_id: null,
            in_reply_to_account_id: null,
            reblog_of_id: noteId,
            created_at: ctx.clock.now(),
            edited_at: null,
            ...share,
        },
        [],
        [],
    );
    await countPosted(ctx, row, 1);

    return row;
};
