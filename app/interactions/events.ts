/**
 * Events about interactions for the rest of Verso: likes, boosts and reactions made and undone by
 * local users, and those remote instances send.
 * @module
 */
import type { Visibility } from "../kernel/visibility.ts";
import type { DomainEvent } from "../kernel/context.ts";

/** A local user liked a status, or undid it. */
export type LikeEvent = {
    readonly type: "interactions.liked" | "interactions.unliked";
    readonly likeId: string;
    readonly accountId: string;
    readonly noteId: string;
};

export const isLikeEvent = (event: DomainEvent): event is LikeEvent =>
    event.type === "interactions.liked" || event.type === "interactions.unliked";

/** A local user boosted a status, or undid it. */
export type ShareEvent = {
    readonly type: "interactions.shared" | "interactions.unshared";
    readonly shareId: string;
    readonly accountId: string;
    readonly noteId: string;
    /** The boost's, which may differ from the status's. */
    readonly visibility: Visibility;
};

export const isShareEvent = (event: DomainEvent): event is ShareEvent =>
    event.type === "interactions.shared" || event.type === "interactions.unshared";

/** A local user reacted to a status, or undid it. */
export type ReactionEvent = {
    readonly type: "interactions.reacted" | "interactions.unreacted";
    readonly reactionId: string;
    readonly accountId: string;
    readonly noteId: string;
};

export const isReactionEvent = (event: DomainEvent): event is ReactionEvent =>
    event.type === "interactions.reacted" || event.type === "interactions.unreacted";

/**
 * A remote user liked, boosted or reacted to a status, as their instance sent it. It has its own
 * type, so that what reacts to local users' interactions, such as sending them, never sees it.
 */
export type InteractionReceived = {
    readonly type: "interactions.received";
    readonly kind: "like" | "share" | "reaction";
    /** The like, the boost or the reaction. */
    readonly id: string;
    readonly accountId: string;
    readonly noteId: string;
};

export const isInteractionReceived = (event: DomainEvent): event is InteractionReceived =>
    event.type === "interactions.received";
