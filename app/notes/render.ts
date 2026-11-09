/**
 * Statuses as the client API renders them, in the Mastodon format.
 * @module
 */
import type { Quote, ShallowQuote, Status, StatusEdit } from "@versia/client-api";
import { findAccounts } from "../accounts/account_queries.ts";
import { publicAccount, publicAccountsOf } from "../accounts/public.ts";
import { emojisOfNotes } from "../emojis/emoji_queries.ts";
import { activeFiltersAmong, filterResults } from "../filters/matching.ts";
import { renderEmojis } from "../emojis/render.ts";
import { blockingAny, type Excluded, viewerBlocks } from "../graph/blocks.ts";
import { countLikesBy, likedAmong, likerIdsQuery } from "../interactions/like_queries.ts";
import { reactorIdsQuery } from "../interactions/reaction_queries.ts";
import { reactionsFor } from "../interactions/reaction_render_queries.ts";
import { reactionEmojis, renderReactions } from "../interactions/render.ts";
import type { Context } from "../kernel/context.ts";
import { sanitizeHtml } from "../kernel/html.ts";
import { attachmentsOf, findMediaRows } from "../media/attachment_queries.ts";
import { asVersionMedia, attachedTo } from "../media/attachments.ts";
import { renderAttachment } from "../media/render.ts";
import { entityUrl } from "../kernel/urls.ts";
import { findNotes, mentionsOf, type NoteRow, tagsOf, versionsOf } from "./note_queries.ts";
import { notesSeenBy, quoteCounts } from "./thread_queries.ts";
import { everyone } from "./audience.ts";
import { quoteApproval, type QuoteView, quoteViews } from "./quotes.ts";
import { countSharesBy, sharedAmong, sharerIdsQuery } from "./share_queries.ts";
import { pinnedAmong } from "./pin_queries.ts";
import { bookmarkedAmong } from "./bookmark_queries.ts";
import { mutedThreadsAmong } from "./thread_mute_queries.ts";
import { isPinnable } from "./pins.ts";
import { totalsOf } from "./total_queries.ts";
import { onlookerOf } from "./visibility.ts";
import { pollOf } from "../polls/poll_queries.ts";
import { renderPollsFor } from "../polls/render.ts";
import { cardsOf } from "../previews/card_queries.ts";
import { renderCard } from "../previews/render.ts";
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

/** Someone statuses are rendered for, or `null` for anyone. */
type ViewerId = string | null;

/**
 * The statuses boosted by `shares` that each of `viewerIds` may see, as rendered statuses by id, by
 * viewer. A boosted status may have been made private since. Boosted statuses aren't boosts
 * themselves, so this goes no deeper.
 */
const sharedStatuses = async (
    ctx: Context,
    shares: readonly NoteRow[],
    viewerIds: readonly ViewerId[],
): Promise<Map<ViewerId, Map<string, Status>>> => {
    const ids = [...new Set(shares.flatMap((note) => note.reblog_of_id ?? []))];
    if (ids.length === 0) return new Map();

    const seen = new Map<ViewerId, Set<string>>();
    for (const viewerId of viewerIds) {
        seen.set(viewerId, await notesSeenBy(ctx, ids, onlookerOf(ctx, viewerId)));
    }
    const notes = (await findNotes(ctx, ids)).filter((note) =>
        viewerIds.some((viewerId) => seen.get(viewerId)?.has(note.id))
    );
    const statuses = await renderStatusesFor(ctx, notes, viewerIds);

    return new Map(viewerIds.map((viewerId) => [
        viewerId,
        new Map(
            (statuses.get(viewerId) ?? []).flatMap((status) =>
                seen.get(viewerId)?.has(status.id) ? [[status.id, status] as const] : []
            ),
        ),
    ]));
};

/**
 * The quotes that `notes` have, by viewer, then by status, as each of `viewerIds` sees them. The
 * quoted statuses are shown by id if `nested`, and otherwise rendered, as quotes inside them are
 * shown by id.
 */
const quotedStatuses = async (
    ctx: Context,
    notes: readonly NoteRow[],
    viewerIds: readonly ViewerId[],
    nested: boolean,
): Promise<Map<ViewerId, Map<string, Quote | ShallowQuote>>> => {
    const quoting = new Map(
        notes.flatMap((note) =>
            note.quote_id === null || note.reblog_of_id !== null ? [] : [[note.id, note.quote_id]]
        ),
    );
    if (quoting.size === 0) return new Map();

    const views = new Map<ViewerId, Map<string, QuoteView>>();
    for (const viewerId of viewerIds) views.set(viewerId, await quoteViews(ctx, quoting, viewerId));
    if (nested) {
        return new Map([...views].map(([viewerId, each]) => [
            viewerId,
            new Map([...each].map(([id, { state, note }]) => [id, {
                state,
                quoted_status_id: note?.id ?? null,
            }])),
        ]));
    }

    const shown = [
        ...new Map(
            [...views.values()].flatMap((each) => [...each.values()]).flatMap(({ note }) =>
                note === null ? [] : [[note.id, note] as const]
            ),
        ).values(),
    ];
    const statuses = await renderStatusesFor(ctx, shown, viewerIds, { nested: true });

    return new Map([...views].map(([viewerId, each]) => {
        const rendered = new Map(
            (statuses.get(viewerId) ?? []).map((status) => [status.id, status]),
        );
        return [
            viewerId,
            new Map([...each].map(([id, { state, note }]) => [id, {
                state,
                quoted_status: (note && rendered.get(note.id)) ?? null,
            }])),
        ];
    }));
};

/**
 * How many likes and boosts of each of `noteIds` are by the accounts each viewer blocks, the value
 * of `blocked`, which it isn't shown, by viewer.
 */
const blockedCounts = async (
    ctx: Context,
    noteIds: readonly string[],
    blocked: ReadonlyMap<ViewerId, Excluded | null>,
) => {
    const counts = new Map<ViewerId, { likes: Map<string, number>; shares: Map<string, number> }>();
    for (const [viewerId, excluded] of blocked) {
        if (excluded === null) continue;

        counts.set(viewerId, {
            likes: await countLikesBy(ctx, noteIds, excluded),
            shares: await countSharesBy(ctx, noteIds, excluded),
        });
    }

    return counts;
};

/**
 * The accounts each of `viewerIds` blocks, for those that block some who liked, boosted or reacted
 * to any of `noteIds`, by viewer. The others have nothing of theirs to take out.
 */
const blockedAmong = async (
    ctx: Context,
    noteIds: readonly string[],
    viewerIds: readonly ViewerId[],
): Promise<Map<ViewerId, Excluded | null>> => {
    const signedIn = viewerIds.filter((viewerId) => viewerId !== null);
    const interacting = likerIdsQuery(ctx, noteIds)
        .unionAll(sharerIdsQuery(ctx, noteIds))
        .unionAll(reactorIdsQuery(ctx, noteIds));
    const blocking = await blockingAny(ctx, signedIn, interacting);

    return new Map(viewerIds.map((viewerId) => [
        viewerId,
        viewerId !== null && blocking.has(viewerId) ? viewerBlocks(ctx, viewerId) : null,
    ]));
};

/**
 * Renders statuses in the order given, as each of `viewerIds` sees them, or as anyone sees them for
 * `null`, by viewer. Each status's author must exist, which the database guarantees. A boost has
 * the status it boosts as its `reblog`, and is omitted if the viewer may not see that. A remote
 * status shows the larger of Verso's own count and the count its instance reports, as Mastodon
 * does. The likes, boosts and reactions of the accounts the viewer blocks aren't counted. A viewer
 * is told which of their filters each status matches. With `source`, statuses carry the text their
 * authors wrote, as Mastodon returns a deleted status for redrafting. A status that quotes another
 * has it as its `quote`, which is shown by id only if `nested`, as it is inside a quote, so a quote
 * goes no deeper.
 *
 * What is the same for every viewer is looked up once, and what isn't, for all of them together,
 * except whether each may see a boosted or quoted status, and for those that block some who liked,
 * boosted or reacted to the statuses, those likes, boosts and reactions.
 */
export const renderStatusesFor = async (
    ctx: Context,
    notes: readonly NoteRow[],
    viewerIds: readonly ViewerId[],
    options: { readonly source?: boolean; readonly nested?: boolean } = {},
): Promise<Map<ViewerId, Status[]>> => {
    const viewers = [...new Set(viewerIds)];
    if (notes.length === 0) return new Map(viewers.map((viewerId) => [viewerId, []]));

    const signedIn = viewers.filter((viewerId) => viewerId !== null);
    const noteIds = notes.map((note) => note.id);
    // None of these depend on each other, so on Postgres they run at once, each on a connection of
    // its own. In a transaction, they share its connection and run one after another.
    const [
        [mentions, domains, accounts],
        [tags, tagNames],
        attachments,
        emojis,
        [reactions, uncounted],
        totals,
        liked,
        shared,
        pinned,
        bookmarked,
        mutedThreads,
        reblogs,
        quotes,
        quoted,
        polls,
        cards,
        filters,
    ] = await Promise.all([
        mentionsOf(ctx, noteIds).then(async (mentions) => {
            const accountIds = new Set([
                ...notes.map((note) => note.account_id),
                ...[...mentions.values()].flat(),
            ]);
            const rows = await findAccounts(ctx, [...accountIds]);
            const domains = new Map(rows.map((row) => [row.id, row.domain]));
            return [mentions, domains, await publicAccountsOf(ctx, rows)] as const;
        }),
        tagsOf(ctx, noteIds).then(async (tags) =>
            [tags, await displayNamesOf(ctx, [...tags.values()].flat())] as const
        ),
        attachmentsOf(ctx, noteIds),
        emojisOfNotes(ctx, noteIds),
        blockedAmong(ctx, noteIds, viewers).then((blocked) =>
            Promise.all([
                reactionsFor(ctx, noteIds, blocked),
                blockedCounts(ctx, noteIds, blocked),
            ])
        ),
        totalsOf(ctx, noteIds),
        likedAmong(ctx, signedIn, noteIds),
        sharedAmong(ctx, signedIn, noteIds),
        pinnedAmong(ctx, signedIn, noteIds),
        bookmarkedAmong(ctx, signedIn, noteIds),
        mutedThreadsAmong(ctx, signedIn, notes.map((note) => note.thread_id)),
        sharedStatuses(ctx, notes, viewers),
        quotedStatuses(ctx, notes, viewers, options.nested ?? false),
        quoteCounts(ctx, noteIds, everyone),
        renderPollsFor(ctx, notes, viewers),
        cardsOf(ctx, noteIds),
        activeFiltersAmong(ctx, signedIn),
    ]);

    const renderFor = (viewerId: ViewerId): Status[] => {
        const noted = (sets: ReadonlyMap<string, ReadonlySet<string>>, id: string) =>
            viewerId !== null && (sets.get(viewerId)?.has(id) ?? false);
        const reactionsOf = reactions.get(viewerId) ?? new Map();

        const rendered = notes.flatMap((note): Status[] => {
            const reblog = note.reblog_of_id === null
                ? null
                : reblogs.get(viewerId)?.get(note.reblog_of_id);
            if (reblog === undefined) return [];

            const account = accounts.get(note.account_id);
            if (account === undefined) throw new Error(`Note ${note.id} has no author`);
            const domain = domains.get(note.account_id) ?? null;
            const card = cards.get(note.id);

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
                    ...reactionEmojis(reactionsOf.get(note.id) ?? []),
                ]),
                reactions: renderReactions(ctx, reactionsOf.get(note.id) ?? [], viewerId !== null),
                reblogs_count: Math.max(note.shares_count, totals.get(note.id)?.shares ?? 0) -
                    (uncounted.get(viewerId)?.shares.get(note.id) ?? 0),
                favourites_count: Math.max(note.likes_count, totals.get(note.id)?.likes ?? 0) -
                    (uncounted.get(viewerId)?.likes.get(note.id) ?? 0),
                replies_count: Math.max(note.replies_count, totals.get(note.id)?.replies ?? 0),
                quotes_count: quoted.get(note.id) ?? 0,
                // Verso has no web pages for statuses, so this is the same as `uri`.
                url: noteUri(ctx, note, domain).href,
                in_reply_to_id: note.in_reply_to_id,
                in_reply_to_account_id: note.in_reply_to_account_id,
                reblog,
                quote: quotes.get(viewerId)?.get(note.id) ?? null,
                quote_approval: reblog?.quote_approval ?? quoteApproval(note, viewerId),
                poll: polls.get(viewerId)?.get(note.id) ?? null,
                card: card === undefined ? null : renderCard(ctx, card, card.link, viewerId),
                language: note.language,
                text: options.source ? note.content : null,
                edited_at: note.edited_at?.toISOString() ?? null,
                ...(viewerId === null ? {} : viewerFlags(
                    noted(liked, note.id),
                    noted(shared, note.id),
                    noted(mutedThreads, note.thread_id),
                    noted(bookmarked, note.id),
                    isPinnable(note, viewerId) ? noted(pinned, note.id) : undefined,
                )),
            }];
        });
        if (viewerId === null) return rendered;

        // A boost and the status it boosts match the same filters, as on Mastodon.
        const active = filters.get(viewerId) ?? [];
        return rendered.map((status) => {
            const filtered = filterResults(active, status);
            return {
                ...status,
                filtered,
                reblog: status.reblog && { ...status.reblog, filtered },
            };
        });
    };

    return new Map(viewers.map((viewerId) => [viewerId, renderFor(viewerId)]));
};

/** Renders statuses in the order given, as `viewerId` sees them, as {@link renderStatusesFor} does. */
export const renderStatuses = async (
    ctx: Context,
    notes: readonly NoteRow[],
    viewerId: ViewerId,
    options: { readonly source?: boolean; readonly nested?: boolean } = {},
): Promise<Status[]> =>
    (await renderStatusesFor(ctx, notes, [viewerId], options)).get(viewerId) ?? [];

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
