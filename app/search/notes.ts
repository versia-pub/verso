/**
 * Keeping the words of statuses, local and remote, for searching them. Every status is indexed;
 * who may find which is decided when searching, so an author changing `indexable` needs no
 * reindexing. A deleted status's words go with it.
 * @module
 */
import type { Context, DomainEvent } from "../kernel/context.ts";
import { textOfHtml } from "../kernel/html.ts";
import { attachmentsOf } from "../media/attachment_queries.ts";
import { isNoteEdited, isNotePosted, isNoteReceived } from "../notes/events.ts";
import { findNotes } from "../notes/note_queries.ts";
import { indexNote, unindexedNoteIds } from "./search_queries.ts";
import { searchWords } from "./words.ts";

/**
 * Indexes the words of each of `noteIds`, as Mastodon does: its content warning, its text, and
 * the descriptions of its media. These are never boosts, which have no words of their own.
 * @see https://github.com/mastodon/mastodon/blob/main/app/models/concerns/status/search_concern.rb
 */
const indexNotes = async (ctx: Pick<Context, "db">, noteIds: readonly string[]) => {
    const notes = await findNotes(ctx, noteIds);
    const attachments = await attachmentsOf(ctx, notes.map((note) => note.id));

    for (const note of notes) {
        const descriptions = (attachments.get(note.id) ?? []).map((media) => media.description);
        const text = [note.spoiler_text, textOfHtml(note.content_html), ...descriptions].join(" ");
        await indexNote(ctx, note.id, searchWords(text));
    }
};

/** Indexes statuses as they are posted, edited or received. */
export const indexStatuses = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (isNotePosted(event) || isNoteEdited(event) || isNoteReceived(event)) {
        await indexNotes(ctx, [event.noteId]);
    }
};

/** How many statuses are indexed at a time. */
const batchSize = 500;

/**
 * Indexes the statuses that aren't yet, such as those from before Verso searched them, and returns
 * how many there were.
 */
export const indexUnindexed = async (ctx: Pick<Context, "db">): Promise<number> => {
    let count = 0;
    for (;;) {
        const noteIds = await unindexedNoteIds(ctx, batchSize);
        if (noteIds.length === 0) return count;

        await indexNotes(ctx, noteIds);
        count += noteIds.length;
    }
};
