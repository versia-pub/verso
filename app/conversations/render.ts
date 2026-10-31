import type { Conversation } from "@versia/client-api";
import { publicAccounts } from "../accounts/public.ts";
import type { Context } from "../kernel/context.ts";
import { findNotes } from "../notes/note_queries.ts";
import { renderStatuses } from "../notes/render.ts";
import type { ConversationRow } from "./conversation_queries.ts";

/**
 * Conversations as Mastodon renders them for their owner, `viewerId`: with the other accounts in
 * each, or the viewer for none, and its latest status as they see it.
 */
export const renderConversations = async (
    ctx: Context,
    rows: readonly ConversationRow[],
    viewerId: string,
): Promise<Conversation[]> => {
    const noteIds = rows.flatMap((row) => row.last_note_id ?? []);
    const statuses = new Map(
        (await renderStatuses(ctx, await findNotes(ctx, noteIds), viewerId))
            .map((status) => [status.id, status]),
    );
    const participants = rows.map((row) =>
        row.participants === "" ? [viewerId] : row.participants.split(" ")
    );
    const accounts = new Map(
        (await publicAccounts(ctx, [...new Set(participants.flat())])).map((account) => [
            account.id,
            account,
        ]),
    );

    return rows.map((row, i) => ({
        id: row.id,
        unread: row.unread,
        accounts: participants[i].flatMap((id) => accounts.get(id) ?? []),
        last_status: statuses.get(row.last_note_id ?? "") ?? null,
    }));
};

/** A conversation as Mastodon renders it for its owner. */
export const renderConversation = async (
    ctx: Context,
    row: ConversationRow,
): Promise<Conversation> => (await renderConversations(ctx, [row], row.account_id))[0];
