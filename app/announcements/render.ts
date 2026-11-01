import type { Announcement } from "@versia/client-api";
import { findAccounts } from "../accounts/account_queries.ts";
import { publicAccountsOf } from "../accounts/public.ts";
import { usableEmojis } from "../emojis/emoji_queries.ts";
import { renderEmojis } from "../emojis/render.ts";
import type { Context } from "../kernel/context.ts";
import { scanText } from "../kernel/markup.ts";
import { renderStatuses } from "../notes/render.ts";
import { visibleNotes } from "../notes/visibility.ts";
import { type AnnouncementRow, dismissedAmong } from "./announcement_queries.ts";

/**
 * Renders published announcements in the order given, as `viewerId` sees them, with whether they
 * dismissed each, or as anyone sees them if it is `null`, as they are streamed. Mentions of
 * accounts since deleted are left out, and so are linked statuses the viewer may not see. Its
 * custom emojis are the local instance's that its text names.
 */
export const renderAnnouncements = async (
    ctx: Context,
    rows: readonly AnnouncementRow[],
    viewerId: string | null,
): Promise<Announcement[]> => {
    const accountRows = await findAccounts(ctx, [
        ...new Set(rows.flatMap((row) => row.account_ids)),
    ]);
    const accounts = await publicAccountsOf(ctx, accountRows);
    const notes = await visibleNotes(
        ctx,
        [...new Set(rows.flatMap((row) => row.note_ids))],
        viewerId,
    );
    const statuses = new Map(
        (await renderStatuses(ctx, notes, viewerId)).map((status) => [status.id, status]),
    );
    const emojis = await usableEmojis(ctx, null);
    const dismissed = viewerId === null
        ? undefined
        : await dismissedAmong(ctx, viewerId, rows.map((row) => row.id));

    return rows.map((row) => {
        if (row.published_at === null) throw new Error(`Announcement ${row.id} isn't published`);
        const found = scanText(row.text, "text/plain");
        const shortcodes = new Set(found.shortcodes);

        return {
            id: row.id,
            content: row.content_html,
            starts_at: row.starts_at?.toISOString() ?? null,
            ends_at: row.ends_at?.toISOString() ?? null,
            all_day: row.all_day,
            published_at: row.published_at.toISOString(),
            updated_at: row.updated_at.toISOString(),
            ...(dismissed === undefined ? {} : { read: dismissed.has(row.id) }),
            mentions: row.account_ids.flatMap((id) => {
                const account = accounts.get(id);
                return account
                    ? [{ id, username: account.username, url: account.uri, acct: account.acct }]
                    : [];
            }),
            statuses: row.note_ids.flatMap((id) => statuses.get(id) ?? []),
            tags: found.hashtags.map((name) => ({
                name,
                url: ctx.urls.url`/tags/${name.toLowerCase()}`,
            })),
            emojis: renderEmojis(ctx, emojis.filter((emoji) => shortcodes.has(emoji.shortcode))),
            reactions: [],
        };
    });
};
