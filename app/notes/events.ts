/**
 * Events about statuses for the rest of Verso: statuses posted, edited and deleted, and remote ones
 * received.
 * @module
 */
import type { Visibility } from "../kernel/visibility.ts";
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

/**
 * A remote status was received, new or edited. It has its own type, so that what reacts to local
 * users' statuses, such as sending them, never sees it.
 */
export type NoteReceived = {
    readonly type: "notes.received";
    readonly noteId: string;
    /** Whether it was edited, rather than new. */
    readonly edited: boolean;
    /** Whether Verso fetched it, rather than its instance sending it unsolicited. */
    readonly fetched: boolean;
};

export const isNotePosted = (event: DomainEvent): event is NotePosted =>
    event.type === "notes.posted";

export const isNoteEdited = (event: DomainEvent): event is NoteEdited =>
    event.type === "notes.edited";

export const isNoteDeleted = (event: DomainEvent): event is NoteDeleted =>
    event.type === "notes.deleted";

export const isNoteReceived = (event: DomainEvent): event is NoteReceived =>
    event.type === "notes.received";
