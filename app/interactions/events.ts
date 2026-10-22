/**
 * What interactions tell the rest of Verso: likes and shares made and undone by local users.
 * @module
 */
import type { DomainEvent } from "../kernel/context.ts";

/** A local user liked a note, or undid it. */
export type LikeEvent = {
    readonly type: "interactions.liked" | "interactions.unliked";
    readonly likeId: string;
    readonly accountId: string;
    readonly noteId: string;
};

export const isLikeEvent = (event: DomainEvent): event is LikeEvent =>
    event.type === "interactions.liked" || event.type === "interactions.unliked";

/** A local user shared a note, or undid it. */
export type ShareEvent = {
    readonly type: "interactions.shared" | "interactions.unshared";
    readonly shareId: string;
    readonly accountId: string;
    readonly noteId: string;
};

export const isShareEvent = (event: DomainEvent): event is ShareEvent =>
    event.type === "interactions.shared" || event.type === "interactions.unshared";
