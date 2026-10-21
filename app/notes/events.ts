/**
 * What notes tell the rest of Verso: notes deleted.
 * @module
 */
import type { Visibility } from "../accounts/tables.ts";
import type { DomainEvent } from "../kernel/context.ts";

/** A local or remote note was deleted. It carries who could see it, so they can be told too. */
export type NoteDeleted = {
    readonly type: "notes.deleted";
    readonly noteId: string;
    readonly accountId: string;
    readonly visibility: Visibility;
    readonly mentionIds: readonly string[];
};

export const isNoteDeleted = (event: DomainEvent): event is NoteDeleted =>
    event.type === "notes.deleted";
