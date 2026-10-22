/**
 * Notes as the client API shows them, as Mastodon statuses.
 * @module
 */
import type { Status, StatusEdit } from "@versia/client-api";
import { findAccounts } from "../accounts/account_queries.ts";
import { publicAccount, publicAccountsOf } from "../accounts/public.ts";
import { emojisOfNotes } from "../emojis/emoji_queries.ts";
import { renderEmojis } from "../emojis/render.ts";
import { viewerBlocks } from "../graph/blocks.ts";
import type { AccountIdQuery } from "../graph/follows.ts";
import { followedSubquery } from "../graph/follows.ts";
import { countLikesBy, likedAmong } from "../interactions/like_queries.ts";
import { reactionsOf } from "../interactions/reaction_queries.ts";
import { reactionEmojis, renderReactions } from "../interactions/render.ts";
import type { Context } from "../kernel/context.ts";
import { sanitizeHtml } from "../kernel/html.ts";
import { entityUrl } from "../kernel/urls.ts";
import {
    countSharesBy,
    findNotes,
    mentionsOf,
    type NoteRow,
    notesSeenBy,
    sharedAmong,
    tagsOf,
    versionsOf,
} from "./note_queries.ts";
import { pinnedAmong } from "./pin_queries.ts";
import { isPinnable } from "./pins.ts";
import { totalsOf } from "./total_queries.ts";

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
 * What only a logged-in viewer is told: whether they like a note, and share it, and, of their own
 * that they can pin, whether they pin it. The rest isn't possible yet.
 */
const viewerFlags = (liked: boolean, shared: boolean, pinned: boolean | undefined) => ({
    favourited: liked,
    reblogged: shared,
    muted: false,
    bookmarked: false,
    ...pinned === undefined ? {} : { pinned },
});

/**
 * The notes `shares` share that `viewerId` may see, as statuses, by id. A note shared can have
 * been made private since. Notes shared aren't shares themselves, so this goes no deeper.
 */
const sharedStatuses = async (
    ctx: Context,
    shares: readonly NoteRow[],
    viewerId: string | null,
): Promise<Map<string, Status>> => {
    const ids = [...new Set(shares.flatMap((note) => note.reblog_of_id ?? []))];
    if (ids.length === 0) return new Map();

    const onlooker = viewerId === null
        ? null
        : { id: viewerId, followed: followedSubquery(ctx, viewerId) };
    const seen = await notesSeenBy(ctx, ids, onlooker);
    const notes = (await findNotes(ctx, ids)).filter((note) => seen.has(note.id));
    const statuses = await renderStatuses(ctx, notes, viewerId);
    return new Map(statuses.map((status) => [status.id, status]));
};

/**
 * How many likes and shares of each of `noteIds` are by the accounts `blocked`, which the viewer
 * blocks and isn't shown.
 */
const blockedCounts = async (
    ctx: Context,
    noteIds: readonly string[],
    blocked: AccountIdQuery | null,
) => {
    if (blocked === null) return { likes: new Map<string, number>(), shares: new Map() };

    return {
        likes: await countLikesBy(ctx, noteIds, blocked),
        shares: await countSharesBy(ctx, noteIds, blocked),
    };
};

/**
 * Notes as statuses, in the order given, as `viewerId` sees them, or anyone if it is `null`. Each
 * note's author must exist, which the database makes sure of. A share has the note it shares as its
 * `reblog`, and is left out if the viewer may not see that. Another instance's note counts the
 * larger of what Verso counted and what its instance says, as Mastodon does. The likes, shares and
 * reactions of the accounts the viewer blocks aren't counted. With `source`, they carry what their
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
    const emojis = await emojisOfNotes(ctx, noteIds);
    const blocked = viewerBlocks(ctx, viewerId);
    const reactions = await reactionsOf(ctx, noteIds, viewerId, blocked);
    const uncounted = await blockedCounts(ctx, noteIds, blocked);
    const totals = await totalsOf(ctx, noteIds);
    const liked = viewerId === null ? new Set() : await likedAmong(ctx, viewerId, noteIds);
    const shared = viewerId === null ? new Set() : await sharedAmong(ctx, viewerId, noteIds);
    const pinned = viewerId === null ? new Set() : await pinnedAmong(ctx, viewerId, noteIds);
    const reblogs = await sharedStatuses(ctx, notes, viewerId);

    const accountIds = [
        ...new Set([...notes.map((note) => note.account_id), ...[...mentions.values()].flat()]),
    ];
    const rows = await findAccounts(ctx, accountIds);
    const domains = new Map(rows.map((row) => [row.id, row.domain]));
    const accounts = await publicAccountsOf(ctx, rows);

    return notes.flatMap((note): Status[] => {
        const reblog = note.reblog_of_id === null ? null : reblogs.get(note.reblog_of_id);
        if (reblog === undefined) return [];

        const account = accounts.get(note.account_id);
        if (account === undefined) throw new Error(`Note ${note.id} has no author`);
        const domain = domains.get(note.account_id) ?? null;

        return [{
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
            emojis: renderEmojis([
                ...emojis.get(note.id) ?? [],
                ...reactionEmojis(reactions.get(note.id) ?? []),
            ]),
            reactions: renderReactions(reactions.get(note.id) ?? [], viewerId !== null),
            reblogs_count: Math.max(note.shares_count, totals.get(note.id)?.shares ?? 0) -
                (uncounted.shares.get(note.id) ?? 0),
            favourites_count: Math.max(note.likes_count, totals.get(note.id)?.likes ?? 0) -
                (uncounted.likes.get(note.id) ?? 0),
            replies_count: Math.max(note.replies_count, totals.get(note.id)?.replies ?? 0),
            // Verso has no web pages for notes.
            url: null,
            in_reply_to_id: note.in_reply_to_id,
            in_reply_to_account_id: note.in_reply_to_account_id,
            reblog,
            poll: null,
            card: null,
            language: note.language,
            text: options.source ? note.content : null,
            edited_at: note.edited_at?.toISOString() ?? null,
            ...(viewerId === null ? {} : viewerFlags(
                liked.has(note.id),
                shared.has(note.id),
                isPinnable(note, viewerId) ? pinned.has(note.id) : undefined,
            )),
        }];
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
    // Versions aren't kept with the emojis they used, so each has the ones the note uses now.
    const emojis = renderEmojis((await emojisOfNotes(ctx, [note.id])).get(note.id) ?? []);
    return [...await versionsOf(ctx, note.id), current].map((version): StatusEdit => ({
        content: author.domain === null ? version.content_html : sanitizeHtml(version.content_html),
        spoiler_text: version.spoiler_text,
        sensitive: version.sensitive,
        created_at: version.created_at.toISOString(),
        account,
        media_attachments: [],
        emojis,
    }));
};
