/**
 * The `fallback` of a notification: what an app that doesn't know its type can show instead. It is
 * given only when the app said which types it supports, and only for types outside Mastodon's
 * baseline ones, which every app is taken to know. Of Verso's types, only `reaction` is outside.
 * @see https://docs.joinmastodon.org/entities/Notification/#fallback
 * @see https://github.com/mastodon/mastodon/blob/v4.7.0/app/serializers/concerns/notification_fallback_concern.rb
 * @module
 */
import type { Account, NotificationFallback } from "@versia/client-api";
import type { NotificationType } from "./tables.ts";

const baseline: ReadonlySet<NotificationType> = new Set([
    "mention",
    "status",
    "reblog",
    "follow",
    "follow_request",
    "favourite",
    "poll",
    "update",
    "quote",
    "quoted_update",
]);

const escapes: Readonly<Record<string, string>> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => escapes[char] ?? char);

/** A link to `account`, named by its handle. */
const linkTo = ({ acct, url }: Pick<Account, "acct" | "url">) =>
    `<a href="${escapeHtml(url)}">@${escapeHtml(acct)}</a>`;

/** Who did it: the newest of `accounts`, and how many others. */
const whoOf = (accounts: readonly Pick<Account, "acct" | "url">[]) => {
    const [newest, ...others] = accounts;
    if (newest === undefined) return "Someone";
    if (others.length === 0) return linkTo(newest);

    return `${linkTo(newest)} and ${others.length === 1 ? "one other" : `${others.length} others`}`;
};

/**
 * The fallback of a notification, or group, of `type` from `accounts`, newest first, for an app
 * that supports `supported`, if it has one.
 */
export const fallbackOf = (
    type: NotificationType,
    supported: readonly string[] | undefined,
    accounts: readonly Pick<Account, "acct" | "url">[],
): NotificationFallback | undefined => {
    if (supported === undefined || baseline.has(type) || supported.includes(type)) {
        return undefined;
    }

    return {
        title: `${whoOf(accounts)} reacted to your post`,
        summary: "Your app doesn't support this kind of notification.",
        description: null,
    };
};
