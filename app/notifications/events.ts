/**
 * Events about notifications for the rest of Verso.
 * @module
 */
import type { DomainEvent } from "../kernel/context.ts";
import type { NotificationType } from "./tables.ts";

/** A local user was notified of something. */
export type NotificationCreated = {
    readonly type: "notifications.created";
    readonly notificationId: string;
    /** The user notified. */
    readonly accountId: string;
    readonly notificationType: NotificationType;
    /** Who caused it. */
    readonly fromId: string;
};

export const isNotificationCreated = (event: DomainEvent): event is NotificationCreated =>
    event.type === "notifications.created";
