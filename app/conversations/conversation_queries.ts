import type { Selectable } from "kysely";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { Context } from "../kernel/context.ts";
import type { ConversationsTable } from "./tables.ts";

export type ConversationRow = Selectable<ConversationsTable>;

/** What tells one of a user's conversations from the others. */
export type ConversationKey = {
    readonly accountId: string;
    readonly threadId: string;
    /** The ids of the other accounts in it, sorted and joined by spaces. */
    readonly participants: string;
};

/**
 * Adds the status `noteId` to the conversation `key`, making it if there is none, and marks it
 * `unread` or read. Its latest status stays the latest if this one is older, as one received late
 * is.
 */
export const addToConversation = async (
    ctx: Context,
    key: ConversationKey,
    noteId: string,
    unread: boolean,
): Promise<ConversationRow> => {
    const row = await ctx.db.insertInto("conversations")
        .values({
            id: ctx.ids(),
            account_id: key.accountId,
            thread_id: key.threadId,
            participants: key.participants,
            last_note_id: noteId,
            unread,
            created_at: ctx.clock.now(),
        })
        .onConflict((conflict) =>
            conflict.columns(["account_id", "thread_id", "participants"]).doUpdateSet((eb) => {
                const older = eb.or([
                    eb("conversations.last_note_id", "is", null),
                    eb("conversations.last_note_id", "<", noteId),
                ]);

                return {
                    last_note_id: eb.case().when(older).then(noteId)
                        .else(eb.ref("conversations.last_note_id")).end(),
                    unread,
                };
            })
        )
        .returningAll()
        .executeTakeFirstOrThrow();

    await ctx.db.insertInto("conversation_notes")
        .values({ conversation_id: row.id, note_id: noteId })
        .onConflict((conflict) => conflict.doNothing())
        .execute();

    return row;
};

/**
 * Finds the latest status again of the conversations of `accountIds` whose latest was deleted, and
 * removes those left with none.
 */
export const refreshConversations = async (
    ctx: Context,
    accountIds: readonly string[],
): Promise<void> => {
    if (accountIds.length === 0) return;

    await ctx.db.updateTable("conversations")
        .set((eb) => ({
            last_note_id: eb.selectFrom("conversation_notes")
                .select((inner) => inner.fn.max("conversation_notes.note_id").as("latest"))
                .whereRef("conversation_notes.conversation_id", "=", "conversations.id"),
        }))
        .where("account_id", "in", accountIds)
        .where("last_note_id", "is", null)
        .execute();

    await ctx.db.deleteFrom("conversations")
        .where("account_id", "in", accountIds)
        .where("last_note_id", "is", null)
        .execute();
};

/** `accountId`'s conversation `id`, if they have it. */
export const findConversation = async (
    ctx: Context,
    accountId: string,
    id: string,
): Promise<ConversationRow | undefined> =>
    await ctx.db.selectFrom("conversations").selectAll()
        .where("id", "=", id)
        .where("account_id", "=", accountId)
        .executeTakeFirst();

/** Marks `accountId`'s conversation `id` read or unread, and returns it, if they have it. */
export const markConversation = async (
    ctx: Context,
    accountId: string,
    id: string,
    unread: boolean,
): Promise<ConversationRow | undefined> =>
    await ctx.db.updateTable("conversations")
        .set({ unread })
        .where("id", "=", id)
        .where("account_id", "=", accountId)
        .returningAll()
        .executeTakeFirst();

/** Removes `accountId`'s conversation `id`. Returns whether they had it. */
export const deleteConversation = async (
    ctx: Context,
    accountId: string,
    id: string,
): Promise<boolean> => {
    const { numDeletedRows } = await ctx.db.deleteFrom("conversations")
        .where("id", "=", id)
        .where("account_id", "=", accountId)
        .executeTakeFirst();

    return numDeletedRows > 0n;
};

/**
 * A page of `accountId`'s conversations, the latest first, paged by their latest statuses, as on
 * Mastodon. Those whose latest status was deleted, until it is found again, aren't in it.
 */
export const conversationPage = async (
    ctx: Context,
    accountId: string,
    page: PageBounds,
): Promise<(ConversationRow & { last_note_id: string })[]> => {
    const query = ctx.db.selectFrom("conversations").selectAll()
        .where("account_id", "=", accountId)
        .where("last_note_id", "is not", null);

    return await readPage(query, "conversations.last_note_id", page) as (ConversationRow & {
        last_note_id: string;
    })[];
};
