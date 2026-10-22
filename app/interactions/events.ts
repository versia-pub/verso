/**
 * What interactions tell the rest of Verso: likes made and undone by local users.
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
