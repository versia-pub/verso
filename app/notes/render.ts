/**
 * Notes as the client API shows them, as Mastodon statuses.
 * @module
 */
import type { Status, StatusEdit } from "@versia/client-api";
import { findAccounts } from "../accounts/account_queries.ts";
import { publicAccount, publicAccountsOf } from "../accounts/public.ts";
import type { Context } from "../kernel/context.ts";
import { sanitizeHtml } from "../kernel/html.ts";
import { entityUrl } from "../kernel/urls.ts";
import { mentionsOf, type NoteRow, tagsOf, versionsOf } from "./note_queries.ts";

/** The note's id in Versia, the URL its Note entity is fetched from. */
const noteUri = (ctx: Context, note: NoteRow, domain: string | null) => {
    if (domain === null) return entityUrl(ctx.urls.domain, "Note", note.id);

    if (note.remote_id === null) throw new Error(`Remote note ${note.id} has no remote id`);
    return entityUrl(domain, "Note", note.remote_id);
};

/** What only a logged-in viewer is told: none of it is possible yet. */
const viewerFlags = { favourited: false, reblogged: false, muted: false, bookmarked: false };

/**
 * Notes as statuses, in the order given, as `viewerId` sees them, or anyone if it is `null`. Each
 * note's author must exist, which the database makes sure of. With `source`, they carry what their
 * authors wrote, as Mastodon gives a deleted status back for redrafting.
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
                        // Verso has no profile pages, so it links to the account as Versia gives it.
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
            reblogs_count: 0,
            favourites_count: 0,
            replies_count: note.replies_count,
            // Verso has no web pages for notes.
            url: null,
            in_reply_to_id: note.in_reply_to_id,
            in_reply_to_account_id: note.in_reply_to_account_id,
            reblog: null,
            poll: null,
            card: null,
            language: note.language,
            text: options.source ? note.content : null,
            edited_at: note.edited_at?.toISOString() ?? null,
            ...(viewerId === null ? {} : viewerFlags),
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
