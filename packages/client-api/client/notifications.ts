import { z } from "zod";
import { Account } from "../account.ts";
import { Markers } from "../marker.ts";
import {
    GroupedNotificationsResults,
    Notification,
    type NotificationGroup,
    type NotificationType,
} from "../notification.ts";
import { type CallOptions, type Http, path } from "./http.ts";
import { Page, type PageQuery } from "./pages.ts";

/** Which notifications to list or count. */
export type NotificationFilter = {
    /** Only these types. */
    readonly types?: readonly NotificationType[];
    /** None of these types. */
    readonly exclude_types?: readonly NotificationType[];
    /** Only those from this account. */
    readonly account_id?: string;
};

/** Which notifications to list. */
export type NotificationsQuery = PageQuery & NotificationFilter;

/** Which unread notifications to count. */
export type UnreadCountQuery = NotificationFilter & {
    /** Count at most this many. The instance has a default and a maximum. */
    readonly limit?: number;
};

/** How to group notifications. */
export type Grouping = {
    /**
     * Only these types are grouped, and the rest are each on their own. Defaults to Mastodon's:
     * `favourite`, `follow` and `reblog`.
     */
    readonly grouped_types?: readonly NotificationType[];
};

/** Which notification groups to list. */
export type GroupedNotificationsQuery = NotificationsQuery & Grouping & {
    /**
     * With `partial_avatars`, only each group's newest account is given in full, and the others
     * in part, in `partial_accounts`. Defaults to `full`.
     */
    readonly expand_accounts?: "full" | "partial_avatars";
};

/** Which timelines' markers to get. */
export type MarkerTimeline = keyof Markers;

/** Where to set the viewer's markers. Timelines omitted keep theirs. */
export type MarkerChanges = {
    readonly [timeline in MarkerTimeline]?: {
        /** The newest status, or notification, read. */
        readonly last_read_id: string;
    };
};

const Count = z.object({ count: z.int() });

/** The viewer's notifications, each on its own. */
export class NotificationMethods {
    constructor(private readonly http: Http) {}

    /**
     * The viewer's notifications, newest first. Those from accounts the viewer blocks, or mutes
     * with their notifications, and about statuses they may no longer see, are left out.
     * @see https://docs.joinmastodon.org/methods/notifications/#get
     */
    list(query: NotificationsQuery = {}, options?: CallOptions): Promise<Page<Notification>> {
        return Page.get(this.http, Notification, "/api/v1/notifications", query, options);
    }

    /**
     * One of the viewer's notifications.
     * @see https://docs.joinmastodon.org/methods/notifications/#get-one
     */
    get(id: string, options?: CallOptions): Promise<Notification> {
        return this.http.json(Notification, "GET", path`/api/v1/notifications/${id}`, options);
    }

    /**
     * How many of the viewer's notifications are newer than their notifications marker, up to a
     * limit.
     * @see https://docs.joinmastodon.org/methods/notifications/#unread-notification-count
     */
    async unreadCount(query: UnreadCountQuery = {}, options?: CallOptions): Promise<number> {
        const { count } = await this.http.json(Count, "GET", "/api/v1/notifications/unread_count", {
            ...options,
            query,
        });

        return count;
    }

    /**
     * Dismisses one of the viewer's notifications.
     * @see https://docs.joinmastodon.org/methods/notifications/#dismiss
     */
    async dismiss(id: string, options?: CallOptions): Promise<void> {
        await this.http.send("POST", path`/api/v1/notifications/${id}/dismiss`, options);
    }

    /**
     * Dismisses all of the viewer's notifications.
     * @see https://docs.joinmastodon.org/methods/notifications/#clear
     */
    async clear(options?: CallOptions): Promise<void> {
        await this.http.send("POST", "/api/v1/notifications/clear", options);
    }
}

/**
 * The viewer's notifications in groups, such as the likes of a status. Each page gives its groups
 * as its items, and the accounts and statuses they refer to in its `body`.
 */
export class GroupedNotificationMethods {
    constructor(private readonly http: Http) {}

    /**
     * The viewer's notification groups, newest first. `reaction` notifications are grouped by
     * status too, when `grouped_types` has `reaction`, and a `reaction` group has its emojis.
     * @see https://docs.joinmastodon.org/methods/grouped_notifications/#get-grouped
     */
    list(
        query: GroupedNotificationsQuery = {},
        options?: CallOptions,
    ): Promise<Page<NotificationGroup, GroupedNotificationsResults>> {
        return Page.getIn(
            this.http,
            GroupedNotificationsResults,
            (body) => body.notification_groups,
            "/api/v2/notifications",
            query,
            options,
        );
    }

    /**
     * One of the viewer's notification groups, with the accounts and status it refers to.
     * @see https://docs.joinmastodon.org/methods/grouped_notifications/#get-notification-group
     */
    get(groupKey: string, options?: CallOptions): Promise<GroupedNotificationsResults> {
        return this.http.json(
            GroupedNotificationsResults,
            "GET",
            path`/api/v2/notifications/${groupKey}`,
            options,
        );
    }

    /**
     * The accounts that caused a group's notifications, newest first, each once.
     * @see https://docs.joinmastodon.org/methods/grouped_notifications/#get-group-accounts
     */
    accounts(
        groupKey: string,
        query: PageQuery = {},
        options?: CallOptions,
    ): Promise<Page<Account>> {
        return Page.get(
            this.http,
            Account,
            path`/api/v2/notifications/${groupKey}/accounts`,
            query,
            options,
        );
    }

    /**
     * How many of the viewer's notification groups are newer than their notifications marker, up
     * to a limit.
     * @see https://docs.joinmastodon.org/methods/grouped_notifications/#unread-group-count
     */
    async unreadCount(
        query: UnreadCountQuery & Grouping = {},
        options?: CallOptions,
    ): Promise<number> {
        const { count } = await this.http.json(Count, "GET", "/api/v2/notifications/unread_count", {
            ...options,
            query,
        });

        return count;
    }

    /**
     * Dismisses one of the viewer's notification groups.
     * @see https://docs.joinmastodon.org/methods/grouped_notifications/#dismiss-group
     */
    async dismiss(groupKey: string, options?: CallOptions): Promise<void> {
        await this.http.send("POST", path`/api/v2/notifications/${groupKey}/dismiss`, options);
    }
}

/** Where the viewer last read up to in their home timeline and notifications. */
export class MarkerMethods {
    constructor(private readonly http: Http) {}

    /**
     * The viewer's markers in `timelines`, of those that have one.
     * @see https://docs.joinmastodon.org/methods/markers/#get
     */
    get(timelines: readonly MarkerTimeline[], options?: CallOptions): Promise<Markers> {
        return this.http.json(Markers, "GET", "/api/v1/markers", {
            ...options,
            query: { timeline: timelines },
        });
    }

    /**
     * Sets the viewer's markers, and gives those it set.
     * @see https://docs.joinmastodon.org/methods/markers/#create
     */
    set(changes: MarkerChanges, options?: CallOptions): Promise<Markers> {
        return this.http.json(Markers, "POST", "/api/v1/markers", { ...options, json: changes });
    }
}
