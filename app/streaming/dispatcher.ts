/**
 * Giving a process's streaming sessions what they stream: statuses, notifications, filter changes,
 * conversations, merged notification requests, announcements and reactions to them. It subscribes
 * once to each channel, not once for every session, and passes each message to a listener for each
 * kind of stream. Messages are handled one at a time, in the order they are heard, so a session is
 * never sent a status's delete before its update. What published a message doesn't wait for it to
 * be streamed.
 * @module
 */
import { getLogger } from "@logtape/logtape";
import {
    announcementChanged,
    type AnnouncementChangedMessage,
} from "../announcements/announcements.ts";
import {
    announcementReacted,
    type AnnouncementReactedMessage,
} from "../announcements/reactions.ts";
import {
    conversationChanged,
    type ConversationChangedMessage,
} from "../conversations/conversations.ts";
import type { RouteViewer } from "../http/route.ts";
import { filtersChanged, type FiltersChangedMessage } from "../filters/filters.ts";
import type { Context } from "../kernel/context.ts";
import { subscribe } from "../kernel/pubsub.ts";
import { notified, type NotifiedMessage } from "../notifications/notifications.ts";
import { notificationsMerged, type NotificationsMergedMessage } from "../notifications/requests.ts";
import type { Session } from "./session.ts";
import { type StatusMessage, statusMessages } from "./statuses.ts";

/** How a kind of stream sends its sessions each kind of message it handles. */
export type Listener = {
    readonly statuses?: (message: StatusMessage) => Promise<void>;
    readonly notifications?: (message: NotifiedMessage) => Promise<void>;
    readonly filtersChanged?: (message: FiltersChangedMessage) => Promise<void>;
    readonly conversations?: (message: ConversationChangedMessage) => Promise<void>;
    readonly notificationsMerged?: (message: NotificationsMergedMessage) => Promise<void>;
    readonly announcements?: (message: AnnouncementChangedMessage) => Promise<void>;
    readonly announcementReactions?: (message: AnnouncementReactedMessage) => Promise<void>;
};

/** A session's viewer, who is logged in. */
export type StreamViewer = RouteViewer & { readonly accountId: string };

/** A listener that sends a kind of stream to the sessions added to it. */
export type Sessions = Listener & {
    /** Adds `session` of `viewer`. Calling the function returned removes it. */
    readonly add: (viewer: StreamViewer, session: Session) => () => void;
};

export type Dispatcher = {
    /** Gives `listener` each message from now on. Calling the function returned stops that. */
    readonly listen: (listener: Listener) => () => void;
    /** Resolves once every message heard so far is handled. */
    readonly idle: () => Promise<void>;
};

/**
 * How many messages may wait to be handled. Past that, streaming has fallen behind, and messages
 * are dropped rather than kept in memory.
 */
const maxWaiting = 1000;

const logger = getLogger(["verso", "streaming"]);

/** Runs `run` on each of `items`, `limit` at a time, logging rather than throwing if any fails. */
export const atMost = async <T>(
    limit: number,
    items: readonly T[],
    run: (item: T) => Promise<void>,
): Promise<void> => {
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const item = items[next++];
            try {
                await run(item);
            } catch (error) {
                logger.error("Failed to stream a message: {error}", { error });
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
};

/** A dispatcher for the sessions of the process `ctx` belongs to. */
export const dispatcher = (ctx: Context): Dispatcher => {
    const listeners = new Set<Listener>();
    let handled = Promise.resolve();
    let waiting = 0;

    const handle = (run: (listener: Listener) => Promise<void>) => {
        if (waiting >= maxWaiting) {
            logger.warning("Dropped a message, as streaming is {waiting} messages behind", {
                waiting,
            });
            return Promise.resolve();
        }

        waiting++;
        handled = handled.then(async () => {
            // There is one listener for each kind of stream, so run them all at once.
            await atMost(listeners.size, [...listeners], run);
            waiting--;
        });

        return Promise.resolve();
    };

    subscribe(
        ctx,
        statusMessages,
        (message) => handle(async (listener) => await listener.statuses?.(message)),
    );
    subscribe(
        ctx,
        notified,
        (message) => handle(async (listener) => await listener.notifications?.(message)),
    );
    subscribe(
        ctx,
        filtersChanged,
        (message) => handle(async (listener) => await listener.filtersChanged?.(message)),
    );
    subscribe(
        ctx,
        conversationChanged,
        (message) => handle(async (listener) => await listener.conversations?.(message)),
    );
    subscribe(
        ctx,
        notificationsMerged,
        (message) => handle(async (listener) => await listener.notificationsMerged?.(message)),
    );
    subscribe(
        ctx,
        announcementChanged,
        (message) => handle(async (listener) => await listener.announcements?.(message)),
    );
    subscribe(
        ctx,
        announcementReacted,
        (message) => handle(async (listener) => await listener.announcementReactions?.(message)),
    );

    return {
        listen: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        idle: () => handled,
    };
};
