/**
 * Local statuses as Versia Notes, as remote instances fetch them and are sent them.
 * @see https://versia.pub/entities/note
 * @module
 */
import { formatReference, type v0_6 } from "@versia/protocol";
import { userReferenceMap } from "../accounts/federation.ts";
import type { Visibility } from "../accounts/tables.ts";
import { emojisOfNotes } from "../emojis/emoji_queries.ts";
import { emojiExtensions } from "../emojis/versia.ts";
import type { Context } from "../kernel/context.ts";
import { attachmentsOf } from "../media/attachment_queries.ts";
import { versiaFile } from "../media/versia.ts";
import { mentionsOf, noteOrigins, type NoteRow } from "./note_queries.ts";

/**
 * Who a status is for, as Versia says it. Unlisted statuses are public, as Versia has no unlisted.
 */
const groups: Record<Visibility, string | undefined> = {
    public: "public",
    unlisted: "public",
    private: "followers",
    // Only the users it mentions.
    direct: undefined,
};

/** References to the statuses of `ids` that exist, by id, as Verso puts them in what it sends. */
export const noteReferenceMap = async (
    ctx: Context,
    ids: readonly string[],
): Promise<Map<string, string>> => {
    const references = new Map<string, string>();

    for (const note of await noteOrigins(ctx, ids)) {
        if (note.domain === null) {
            references.set(note.id, note.id);
            continue;
        }

        if (note.remote_id === null) throw new Error(`Remote note ${note.id} has no remote id`);
        references.set(
            note.id,
            formatReference({ host: note.domain, id: note.remote_id }, ctx.urls.domain),
        );
    }

    return references;
};

/** Local statuses as Versia Notes, in the order given. */
export const renderVersiaNotes = async (
    ctx: Context,
    notes: readonly NoteRow[],
): Promise<v0_6.Note[]> => {
    const noteIds = notes.map((note) => note.id);
    const mentions = await mentionsOf(ctx, noteIds);
    const emojis = await emojisOfNotes(ctx, noteIds);
    const attachments = await attachmentsOf(ctx, noteIds);
    const users = await userReferenceMap(ctx, [
        ...new Set([...notes.map((note) => note.account_id), ...[...mentions.values()].flat()]),
    ]);
    const linked = await noteReferenceMap(
        ctx,
        notes.flatMap((note) => [note.in_reply_to_id ?? [], note.quote_id ?? []].flat()),
    );

    return notes.map((note): v0_6.Note => {
        const author = users.get(note.account_id);
        if (author === undefined) throw new Error(`Note ${note.id} has no author`);

        return {
            type: "Note",
            id: note.id,
            created_at: note.created_at.toISOString(),
            author,
            category: "microblog",
            content: {
                [note.content_format]: { content: note.content, remote: false },
                "text/html": { content: note.content_html, remote: false },
            },
            group: groups[note.visibility],
            is_sensitive: note.sensitive,
            subject: note.spoiler_text === "" ? undefined : note.spoiler_text,
            mentions: (mentions.get(note.id) ?? []).flatMap((id) => users.get(id) ?? []),
            replies_to: note.in_reply_to_id === null ? undefined : linked.get(note.in_reply_to_id),
            quotes: note.quote_id === null ? undefined : linked.get(note.quote_id),
            attachments: (attachments.get(note.id) ?? []).map((row) => versiaFile(ctx, row))
                .filter((file) => file !== undefined),
            previews: [],
            extensions: emojiExtensions(emojis.get(note.id) ?? []),
        };
    });
};
