import type { Insertable } from "kysely";
import { countNote } from "../accounts/accounts.ts";
import type { Context } from "../kernel/context.ts";
import { insertNote, type NoteRow } from "./note_queries.ts";
import type { NotesTable } from "./tables.ts";

/**
 * Adds a note by `accountId`, public and saying "Hi" unless `note` says otherwise, mentioning
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
