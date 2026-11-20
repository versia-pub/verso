/**
 * Local statuses as Versia Notes, as remote instances fetch them and are sent them.
 * @see https://versia.pub/entities/note
 * @module
 */
import { v0_7 } from "@versia/protocol";
import { findAccounts } from "../accounts/account_queries.ts";
import { userReferenceMap } from "../accounts/federation.ts";
import { statusUrl } from "../accounts/render.ts";
import type { Visibility } from "../kernel/visibility.ts";
import { emojisOfNotes } from "../emojis/emoji_queries.ts";
import { emojiExtensions } from "../emojis/versia.ts";
import type { Context } from "../kernel/context.ts";
import { attachmentsOf } from "../media/attachment_queries.ts";
import { versiaMedia } from "../media/versia.ts";
import { pollsOf } from "../polls/poll_queries.ts";
import { pollExtensions } from "../polls/versia.ts";
import { mentionsOf, noteOrigins, type NoteRow } from "./note_queries.ts";

/** Visibility as Versia's Social extension says it. */
const visibilities = {
    public: "public",
    unlisted: "unlisted",
    private: "subscribers",
    direct: "mentions",
} as const satisfies Record<Visibility, v0_7.Note["visibility"]>;

/** References to the statuses of `ids` that exist, by id, as Verso puts them in what it sends. */
export const noteReferenceMap = async (
    ctx: Context,
    ids: readonly string[],
): Promise<Map<string, string>> => {
    const references = new Map<string, string>();

    for (const note of await noteOrigins(ctx, ids)) {
        if (note.domain === null) {
            references.set(note.id, v0_7.formatReference({ host: ctx.urls.domain, id: note.id }));
            continue;
        }

        if (note.remote_id === null) throw new Error(`Remote note ${note.id} has no remote id`);

        references.set(
            note.id,
            v0_7.formatReference({ host: note.domain, id: note.remote_id }),
        );
    }

    return references;
};

/** Local statuses as Versia Notes, in the order given. */
export const renderVersiaNotes = async (
    ctx: Context,
    notes: readonly NoteRow[],
): Promise<v0_7.Note[]> => {
    const noteIds = notes.map((note) => note.id);
    const mentions = await mentionsOf(ctx, noteIds);
    const emojis = await emojisOfNotes(ctx, noteIds);
    const attachments = await attachmentsOf(ctx, noteIds);
    const polls = await pollsOf(ctx, noteIds);
    const users = await userReferenceMap(ctx, [
        ...new Set([...notes.map((note) => note.account_id), ...[...mentions.values()].flat()]),
    ]);
    const authors = new Map(
        (await findAccounts(ctx, [...new Set(notes.map((note) => note.account_id))]))
            .map((row) => [row.id, row]),
    );
    const linked = await noteReferenceMap(
        ctx,
        notes.flatMap((note) => [note.in_reply_to_id ?? [], note.quote_id ?? []].flat()),
    );

    const linkedTo = (id: string | null) => id === null ? undefined : linked.get(id);

    return notes.map((note): v0_7.Note => {
        const author = users.get(note.account_id);
        const account = authors.get(note.account_id);
        if (author === undefined || account === undefined) {
            throw new Error(`Note ${note.id} has no author`);
        }

        const extensions = {
            ...emojiExtensions(ctx, emojis.get(note.id) ?? []),
            ...pollExtensions(ctx, polls.get(note.id)),
        };

        return {
            type: "pub.versia:social/Note",
            id: note.id,
            created_at: note.created_at.toISOString(),
            updated_at: note.edited_at?.toISOString(),
            author,
            category: "microblog",
            content: note.content_html,
            visibility: visibilities[note.visibility],
            is_sensitive: note.sensitive,
            subject: note.spoiler_text === "" ? undefined : note.spoiler_text,
            mentions: (mentions.get(note.id) ?? []).flatMap((id) => users.get(id) ?? []),
            replies_to: linkedTo(note.in_reply_to_id),
            quoting: linkedTo(note.quote_id),
            url: statusUrl(ctx, account, note.id),
            attachments: (attachments.get(note.id) ?? []).map((row) => versiaMedia(ctx, row))
                .filter((media) => media !== undefined),
            previews: [],
            extensions: Object.keys(extensions).length === 0 ? undefined : extensions,
        };
    });
};
