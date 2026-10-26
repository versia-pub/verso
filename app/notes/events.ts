/**
 * Events about statuses for the rest of Verso: statuses posted, edited and deleted.
 * @module
 */
import type { Visibility } from "../accounts/tables.ts";
import type { DomainEvent } from "../kernel/context.ts";

/** A local user posted a status. */
export type NotePosted = {
    readonly type: "notes.posted";
    readonly noteId: string;
};

/** A local user edited a status. */
export type NoteEdited = {
    readonly type: "notes.edited";
    readonly noteId: string;
};

/**
 * A local or remote status was deleted. It carries who could see it, so they can be notified too.
 */
export type NoteDeleted = {
    readonly type: "notes.deleted";
    readonly noteId: string;
    readonly accountId: string;
    readonly visibility: Visibility;
    readonly mentionIds: readonly string[];
    /** The author of the status it replied to, if any. */
    readonly inReplyToAccountId: string | null;
};

export const isNotePosted = (event: DomainEvent): event is NotePosted =>
    event.type === "notes.posted";

export const isNoteEdited = (event: DomainEvent): event is NoteEdited =>
    event.type === "notes.edited";

export const isNoteDeleted = (event: DomainEvent): event is NoteDeleted =>
    event.type === "notes.deleted";
