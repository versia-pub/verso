/**
 * Statuses as the client API renders them, in the Mastodon format.
 * @module
 */
import type { Status, StatusEdit } from "@versia/client-api";
import { findAccounts } from "../accounts/account_queries.ts";
import { publicAccount, publicAccountsOf } from "../accounts/public.ts";
import { emojisOfNotes } from "../emojis/emoji_queries.ts";
import { activeFiltersAmong, filterResults } from "../filters/matching.ts";
import { renderEmojis } from "../emojis/render.ts";
import { type Excluded, viewerBlocks } from "../graph/blocks.ts";
import { countLikesBy, likedAmong } from "../interactions/like_queries.ts";
import { reactionsOf } from "../interactions/reaction_render_queries.ts";
import { reactionEmojis, renderReactions } from "../interactions/render.ts";
import type { Context } from "../kernel/context.ts";
import { sanitizeHtml } from "../kernel/html.ts";
import { attachmentsOf, findMediaRows } from "../media/attachment_queries.ts";
import { asVersionMedia, attachedTo } from "../media/attachments.ts";
import { renderAttachment } from "../media/render.ts";
import { entityUrl } from "../kernel/urls.ts";
import { findNotes, mentionsOf, type NoteRow, tagsOf, versionsOf } from "./note_queries.ts";
import { notesSeenBy } from "./thread_queries.ts";
import { countSharesBy, sharedAmong } from "./share_queries.ts";
import { pinnedAmong } from "./pin_queries.ts";
import { bookmarkedAmong } from "./bookmark_queries.ts";
import { mutedThreadsAmong } from "./thread_mute_queries.ts";
import { isPinnable } from "./pins.ts";
import { totalsOf } from "./total_queries.ts";
import { onlookerOf } from "./visibility.ts";
import { pollOf } from "../polls/poll_queries.ts";
import { renderPolls } from "../polls/render.ts";
import { displayNamesOf } from "../tags/tag_queries.ts";

/**
 * The status's id in Versia: the URL its Note entity is fetched from, or for a local boost, its
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
 * What only a logged-in viewer is told: whether they like, boost and bookmark the status, whether
 * they mute its thread and, for their own statuses that they can pin, whether they pin it.
 */
const viewerFlags = (
    liked: boolean,
    shared: boolean,
    muted: boolean,
    bookmarked: boolean,
    pinned: boolean | undefined,
) => ({
    favourited: liked,
    reblogged: shared,
    muted,
    bookmarked,
    ...pinned === undefined ? {} : { pinned },
});

/**
 * The statuses boosted by `shares` that `viewerId` may see, as rendered statuses by id. A boosted
 * status may have been made private since. Boosted statuses aren't boosts themselves, so this goes
 * no deeper.
 */
const sharedStatuses = async (
    ctx: Context,
    shares: readonly NoteRow[],
    viewerId: string | null,
): Promise<Map<string, Status>> => {
    const ids = [...new Set(shares.flatMap((note) => note.reblog_of_id ?? []))];
    if (ids.length === 0) return new Map();

    const seen = await notesSeenBy(ctx, ids, onlookerOf(ctx, viewerId));
    const notes = (await findNotes(ctx, ids)).filter((note) => seen.has(note.id));
    const statuses = await renderStatuses(ctx, notes, viewerId);
    return new Map(statuses.map((status) => [status.id, status]));
};

/**
 * How many likes and boosts of each of `noteIds` are by the accounts `blocked`, which the viewer
 * blocks and isn't shown.
 */
const blockedCounts = async (
    ctx: Context,
    noteIds: readonly string[],
    blocked: Excluded | null,
) => {
    if (blocked === null) return { likes: new Map<string, number>(), shares: new Map() };

    return {
        likes: await countLikesBy(ctx, noteIds, blocked),
        shares: await countSharesBy(ctx, noteIds, blocked),
    };
};

/**
 * Renders statuses in the order given, as `viewerId` sees them, or as anyone sees them if it is
 * `null`. Each status's author must exist, which the database guarantees. A boost has the status it
 * boosts as its `reblog`, and is omitted if the viewer may not see that. A remote status shows the
 * larger of Verso's own count and the count its instance reports, as Mastodon does. The likes,
 * boosts and reactions of the accounts the viewer blocks aren't counted. A viewer is told which of
 * their filters each status matches. With `source`, statuses carry the text their authors wrote, as
 * Mastodon returns a deleted status for redrafting.
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
    const tagNames = await displayNamesOf(ctx, [...tags.values()].flat());
    const attachments = await attachmentsOf(ctx, noteIds);
    const emojis = await emojisOfNotes(ctx, noteIds);
    const blocked = viewerBlocks(ctx, viewerId);
    const reactions = await reactionsOf(ctx, noteIds, viewerId, blocked);
    const uncounted = await blockedCounts(ctx, noteIds, blocked);
    const totals = await totalsOf(ctx, noteIds);
    const liked = viewerId === null ? new Set() : await likedAmong(ctx, viewerId, noteIds);
    const shared = viewerId === null ? new Set() : await sharedAmong(ctx, viewerId, noteIds);
    const pinned = viewerId === null ? new Set() : await pinnedAmong(ctx, viewerId, noteIds);
    const bookmarked = viewerId === null
        ? new Set()
        : await bookmarkedAmong(ctx, viewerId, noteIds);
    const mutedThreads = viewerId === null
        ? new Set()
        : await mutedThreadsAmong(ctx, viewerId, notes.map((note) => note.thread_id));
    const reblogs = await sharedStatuses(ctx, notes, viewerId);
    const polls = await renderPolls(ctx, notes, viewerId);
    const filters = viewerId === null
        ? undefined
        : (await activeFiltersAmong(ctx, [viewerId])).get(viewerId) ?? [];

    const accountIds = [
        ...new Set([...notes.map((note) => note.account_id), ...[...mentions.values()].flat()]),
    ];
    const rows = await findAccounts(ctx, accountIds);
    const domains = new Map(rows.map((row) => [row.id, row.domain]));
    const accounts = await publicAccountsOf(ctx, rows);

    const rendered = notes.flatMap((note): Status[] => {
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
            media_attachments: (attachments.get(note.id) ?? []).map((row) =>
                renderAttachment(ctx, row)
            ),
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
                name: tagNames.get(name) ?? name,
                url: ctx.urls.url`/tags/${name}`,
            })),
            emojis: renderEmojis(ctx, [
                ...emojis.get(note.id) ?? [],
                ...reactionEmojis(reactions.get(note.id) ?? []),
            ]),
            reactions: renderReactions(reactions.get(note.id) ?? [], viewerId !== null),
            reblogs_count: Math.max(note.shares_count, totals.get(note.id)?.shares ?? 0) -
                (uncounted.shares.get(note.id) ?? 0),
            favourites_count: Math.max(note.likes_count, totals.get(note.id)?.likes ?? 0) -
                (uncounted.likes.get(note.id) ?? 0),
            replies_count: Math.max(note.replies_count, totals.get(note.id)?.replies ?? 0),
            // Verso has no web pages for statuses.
            url: null,
            in_reply_to_id: note.in_reply_to_id,
            in_reply_to_account_id: note.in_reply_to_account_id,
            reblog,
            poll: polls.get(note.id) ?? null,
            card: null,
            language: note.language,
            text: options.source ? note.content : null,
            edited_at: note.edited_at?.toISOString() ?? null,
            ...(viewerId === null ? {} : viewerFlags(
                liked.has(note.id),
                shared.has(note.id),
                mutedThreads.has(note.thread_id),
                bookmarked.has(note.id),
                isPinnable(note, viewerId) ? pinned.has(note.id) : undefined,
            )),
        }];
    });
    if (filters === undefined) return rendered;

    // A boost and the status it boosts match the same filters, as on Mastodon.
    return rendered.map((status) => {
        const filtered = filterResults(filters, status);
        return {
            ...status,
            filtered,
            reblog: status.reblog && { ...status.reblog, filtered },
        };
    });
};

/**
 * What a status said before each edit, oldest first, and what it says now, last. A status that was
 * never edited has only the one.
 */
export const renderHistory = async (ctx: Context, note: NoteRow): Promise<StatusEdit[]> => {
    const [author] = await findAccounts(ctx, [note.account_id]);
    if (author === undefined) throw new Error(`Note ${note.id} has no author`);
    const account = await publicAccount(ctx, author);

    const current = {
        ...note,
        media: asVersionMedia(await attachedTo(ctx, note.id)),
        poll_options: (await pollOf(ctx, note.id))?.options.map((option) => option.title) ?? null,
        created_at: note.edited_at ?? note.created_at,
    };
    const versions = [...await versionsOf(ctx, note.id), current];
    // Media removed by an edit is still shown until it is removed with other unattached uploads, at
    // the next hourly run once a day has passed since upload, which for most is soon.
    const ids = versions.flatMap((version) => version.media.map((media) => media.id));
    const files = new Map((await findMediaRows(ctx, ids)).map((row) => [row.id, row]));

    // Versions aren't stored with the custom emojis they used, so each shows the ones the status
    // uses now.
    const emojis = renderEmojis(ctx, (await emojisOfNotes(ctx, [note.id])).get(note.id) ?? []);
    return versions.map((version): StatusEdit => ({
        content: author.domain === null ? version.content_html : sanitizeHtml(version.content_html),
        spoiler_text: version.spoiler_text,
        sensitive: version.sensitive,
        created_at: version.created_at.toISOString(),
        account,
        // With their descriptions as they were.
        media_attachments: version.media.flatMap(({ id, description }) => {
            const row = files.get(id);
            return row ? [renderAttachment(ctx, { ...row, description })] : [];
        }),
        emojis,
        ...version.poll_options === null
            ? {}
            : { poll: { options: version.poll_options.map((title) => ({ title })) } },
    }));
};
