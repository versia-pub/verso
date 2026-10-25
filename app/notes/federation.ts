/**
 * Notes as Versia has them: local ones, as other instances fetch them and are sent them, and other
 * instances' ones, as Verso takes them in. What each takes is in `audience.ts`, `versia.ts` and
 * `remote.ts`; this joins them to the federation engine.
 * @see https://versia.pub/entities/note
 * @module
 */
import { parseReference, v0_6 } from "@versia/protocol";
import { findAccount, findRemoteAccount } from "../accounts/account_queries.ts";
import { queueDeliveriesTo } from "../federation/deliver.ts";
import type { CollectionProvider, EntityType, Sender } from "../federation/registry.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { audienceOf, everyone, instanceMaySee } from "./audience.ts";
import { isNoteDeleted, isNoteEdited, isNotePosted } from "./events.ts";
import {
    countLinkedNotes,
    countNotesBy,
    findNote,
    findRemoteNote,
    linkedNoteIds,
    mentionsOf,
    type NoteLink,
    notesBy,
} from "./note_queries.ts";
import { removeNote, removeNotesOf } from "./notes.ts";
import { pinnedNotes } from "./pin_queries.ts";
import { knownNote, prepareNote, receiveNote } from "./remote.ts";
import { noteReferenceMap, renderVersiaNotes } from "./versia.ts";

/**
 * Sends a local note just posted or edited to the instances of those it is shown to. Versia has no
 * edits, so an edited note is sent again whole, and replaces the one they have.
 */
const sendNote = async (ctx: Context, noteId: string) => {
    const note = await findNote(ctx, noteId);
    if (note === undefined) return;

    const mentionIds = (await mentionsOf(ctx, [note.id])).get(note.id) ?? [];
    const [entity] = await renderVersiaNotes(ctx, [note]);
    await queueDeliveriesTo(ctx, entity, await audienceOf(ctx, note, mentionIds));
};

/**
 * Sends other instances the notes local users post and edit, and Deletes for the ones they delete,
 * to the instances of those each is shown to. An edit and a Delete go to the author's followers as
 * they are now, and an edit to who it mentions now.
 */
export const noteDeliveries = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (isNotePosted(event) || isNoteEdited(event)) return await sendNote(ctx, event.noteId);
    if (!isNoteDeleted(event)) return;

    const author = await findAccount(ctx, event.accountId);
    if (author?.domain !== null) return;

    const note = {
        account_id: event.accountId,
        visibility: event.visibility,
        in_reply_to_account_id: event.inReplyToAccountId,
    };
    const entity: v0_6.Delete = {
        type: "Delete",
        created_at: ctx.clock.now().toISOString(),
        author: author.id,
        deleted_type: "Note",
        deleted: event.noteId,
    };
    await queueDeliveriesTo(ctx, entity, await audienceOf(ctx, note, event.mentionIds));
};

/**
 * A local user's public and unlisted notes, oldest first, so pages stay put as more are written.
 */
const outbox: CollectionProvider = async (ctx, id, page) => {
    const owner = await findAccount(ctx, id);
    if (owner?.domain !== null) return undefined;

    const notes = await notesBy(ctx, id, everyone, page.offset, page.limit);
    return {
        author: id,
        total: await countNotesBy(ctx, id, everyone),
        items: await renderVersiaNotes(ctx, notes),
    };
};

/**
 * The public and unlisted notes a local user pins to their profile, which Versia calls featuring
 * them, the latest pinned first, as their profile shows them.
 */
const featured: CollectionProvider = async (ctx, id, page) => {
    const owner = await findAccount(ctx, id);
    if (owner?.domain !== null) return undefined;

    const notes = await pinnedNotes(ctx, id, everyone);
    return {
        author: id,
        total: notes.length,
        items: await renderVersiaNotes(ctx, notes.slice(page.offset, page.offset + page.limit)),
    };
};

/** The collections notes add to Users. */
export const noteCollections: Readonly<Record<string, CollectionProvider>> = { outbox, featured };

/**
 * Removes the notes of a user another instance deleted, before the user is, in batches, so that a
 * user with many doesn't hold one transaction open over them all.
 */
export const removeNotesOfDeletedUser = async (
    ctx: Context,
    id: string,
    sender: Sender,
): Promise<void> => {
    const account = await findRemoteAccount(ctx, sender.instanceId, id);
    if (account) await removeNotesOf(ctx, account.id);
};

/**
 * The notes that link to a local note by `link`, oldest first, for an instance that may see it.
 * Only public and unlisted ones are listed, so none is shown to an instance that may not see it.
 */
const linkCollection = (link: NoteLink): CollectionProvider => async (ctx, id, page, requester) => {
    const note = await findNote(ctx, id);
    if (note === undefined || note.instance_id !== null) return undefined;
    if (!await instanceMaySee(ctx, note, requester)) return undefined;

    const ids = await linkedNoteIds(ctx, link, id, everyone, page.offset, page.limit);
    const references = await noteReferenceMap(ctx, ids);
    return {
        author: note.account_id,
        total: await countLinkedNotes(ctx, link, id, everyone),
        items: ids.flatMap((each) => references.get(each) ?? []),
    };
};

/**
 * Notes: local ones, fetched by other instances that may see them, and other instances' ones,
 * sent or fetched, with their authors, who they mention and what they reply to fetched first.
 */
export const noteType: EntityType<v0_6.Note> = {
    type: "Note",
    schema: v0_6.Note,
    // Only its author's instance may send it.
    authority: (note, origin) => parseReference(note.author, origin)?.host,
    prepare: prepareNote,
    receive: receiveNote,
    deleteRemote: async (ctx, id, sender) => {
        const note = await findRemoteNote(ctx, sender.instanceId, id);
        // A share is deleted as a Share, not a Note.
        if (note?.reblog_of_id === null) await removeNote(ctx, note.id);
    },
    known: knownNote,
    collections: { replies: linkCollection("in_reply_to_id"), quotes: linkCollection("quote_id") },
    find: async (ctx, id, requester) => {
        const note = await findNote(ctx, id);
        // A share is fetched as a Share, not a Note.
        if (note === undefined || note.instance_id !== null || note.reblog_of_id !== null) {
            return undefined;
        }
        if (!await instanceMaySee(ctx, note, requester)) return undefined;

        const [rendered] = await renderVersiaNotes(ctx, [note]);
        return rendered;
    },
};
