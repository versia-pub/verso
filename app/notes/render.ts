/**
 * Notes as the client API shows them, as Mastodon statuses.
 * @module
 */
import type { Status, StatusEdit } from "@versia/client-api";
import { findAccounts } from "../accounts/account_queries.ts";
import { publicAccount, publicAccountsOf } from "../accounts/public.ts";
import { likedAmong } from "../interactions/like_queries.ts";
import type { Context } from "../kernel/context.ts";
import { sanitizeHtml } from "../kernel/html.ts";
import { entityUrl } from "../kernel/urls.ts";
import {
    findNotes,
    mentionsOf,
    type NoteRow,
    sharedAmong,
    tagsOf,
    versionsOf,
} from "./note_queries.ts";

/**
 * The note's id in Versia, the URL its Note entity is fetched from, or for a local share, its
 * Share entity.
 */
const noteUri = (ctx: Context, note: NoteRow, domain: string | null) => {
    if (domain === null) {
        const type = note.reblog_of_id === null ? "Note" : "pub.versia:share/Share";
        return entityUrl(ctx.urls.domain, type, note.id);
    }

    if (note.remote_id === null) throw new Error(`Remote note ${note.id} has no remote id`);
    return entityUrl(domain, "Note", note.remote_id);
};

/**
 * What only a logged-in viewer is told: whether they like a note, and share it. The rest isn't
 * possible yet.
 */
const viewerFlags = (liked: boolean, shared: boolean) => ({
    favourited: liked,
    reblogged: shared,
    muted: false,
    bookmarked: false,
});

/**
 * The notes `shares` share, as statuses, by id, as `viewerId` sees them. Notes shared aren't
 * shares themselves, so this goes no deeper.
 */
const sharedStatuses = async (
    ctx: Context,
    shares: readonly NoteRow[],
    viewerId: string | null,
): Promise<Map<string, Status>> => {
    const ids = [...new Set(shares.flatMap((note) => note.reblog_of_id ?? []))];
    if (ids.length === 0) return new Map();

    const statuses = await renderStatuses(ctx, await findNotes(ctx, ids), viewerId);
    return new Map(statuses.map((status) => [status.id, status]));
};

/**
 * Notes as statuses, in the order given, as `viewerId` sees them, or anyone if it is `null`. Each
 * note's author must exist, which the database makes sure of. A share has the note it shares as its
 * `reblog`. With `source`, they carry what their authors wrote, as Mastodon gives a deleted status
 * back for redrafting.
 */
export const renderStatuses = async (
    ctx: Context,
    notes: readonly NoteRow[],
    viewerId: string | null,
    options: { readonly source?: boolean } = {},
): Promise<Status[]> => {
    const noteIds = notes.map((note) => note.id);
    const mentions = await mentionsOf(ctx, noteIds);
    const tags = await tagsOf(ctx, noteIds);
    const liked = viewerId === null ? new Set() : await likedAmong(ctx, viewerId, noteIds);
    const shared = viewerId === null ? new Set() : await sharedAmong(ctx, viewerId, noteIds);
    const reblogs = await sharedStatuses(ctx, notes, viewerId);

    const accountIds = [
        ...new Set([...notes.map((note) => note.account_id), ...[...mentions.values()].flat()]),
    ];
    const rows = await findAccounts(ctx, accountIds);
    const domains = new Map(rows.map((row) => [row.id, row.domain]));
    const accounts = await publicAccountsOf(ctx, rows);

    return notes.map((note): Status => {
        const account = accounts.get(note.account_id);
        if (account === undefined) throw new Error(`Note ${note.id} has no author`);
        const domain = domains.get(note.account_id) ?? null;

        return {
            id: note.id,
            uri: noteUri(ctx, note, domain).href,
            created_at: note.created_at.toISOString(),
            account,
            content: domain === null ? note.content_html : sanitizeHtml(note.content_html),
            visibility: note.visibility,
            sensitive: note.sensitive,
            spoiler_text: note.spoiler_text,
            media_attachments: [],
            mentions: (mentions.get(note.id) ?? []).flatMap((id) => {
                const mentioned = accounts.get(id);
                return mentioned
                    ? [{
                        id,
                        username: mentioned.username,
                        // Verso has no profile pages, so it links to the account's Versia URI.
                        url: mentioned.uri,
                        acct: mentioned.acct,
                    }]
                    : [];
            }),
            tags: (tags.get(note.id) ?? []).map((name) => ({
                name,
                url: ctx.urls.url`/tags/${name}`,
            })),
            emojis: [],
            reblogs_count: note.shares_count,
            favourites_count: note.likes_count,
            replies_count: note.replies_count,
            // Verso has no web pages for notes.
            url: null,
            in_reply_to_id: note.in_reply_to_id,
            in_reply_to_account_id: note.in_reply_to_account_id,
            reblog: note.reblog_of_id === null ? null : reblogs.get(note.reblog_of_id) ?? null,
            poll: null,
            card: null,
            language: note.language,
            text: options.source ? note.content : null,
            edited_at: note.edited_at?.toISOString() ?? null,
            ...(viewerId === null ? {} : viewerFlags(liked.has(note.id), shared.has(note.id))),
        };
    });
};

/**
 * What a note said before each edit, oldest first, and what it says now, last. A note never edited
 * has only the one.
 */
export const renderHistory = async (ctx: Context, note: NoteRow): Promise<StatusEdit[]> => {
    const [author] = await findAccounts(ctx, [note.account_id]);
    if (author === undefined) throw new Error(`Note ${note.id} has no author`);
    const account = await publicAccount(ctx, author);

    const current = { ...note, created_at: note.edited_at ?? note.created_at };
    return [...await versionsOf(ctx, note.id), current].map((version): StatusEdit => ({
        content: author.domain === null ? version.content_html : sanitizeHtml(version.content_html),
        spoiler_text: version.spoiler_text,
        sensitive: version.sensitive,
        created_at: version.created_at.toISOString(),
        account,
        media_attachments: [],
        emojis: [],
    }));
};
