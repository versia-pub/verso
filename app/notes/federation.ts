/**
 * Statuses as Versia Notes: local ones, as remote instances fetch them and are sent them, and
 * remote ones, as Verso receives them. What each side accepts is in `audience.ts`, `versia.ts` and
 * `remote.ts`; this module connects them to the federation engine.
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
import { countNotesBy, findNote, findRemoteNote, mentionsOf, notesBy } from "./note_queries.ts";
import { countLinkedNotes, linkedNoteIds, type NoteLink } from "./thread_queries.ts";
import { removeNote, removeNotesOf } from "./removal.ts";
import { pinnedNotes } from "./pin_queries.ts";
import { knownNote, prepareNote, receiveNote } from "./remote.ts";
import { noteReferenceMap, renderVersiaNotes } from "./versia.ts";
import { deleteEntity } from "../federation/delete.ts";

/**
 * Sends a local status that was just posted or edited to the instances of its audience. Versia has
 * no edits, so an edited status is sent again in full and replaces the version the remote instance
 * has.
 */
const sendNote = async (ctx: Context, noteId: string) => {
    const note = await findNote(ctx, noteId);
    if (note === undefined) return;

    const mentionIds = (await mentionsOf(ctx, [note.id])).get(note.id) ?? [];
    const [entity] = await renderVersiaNotes(ctx, [note]);
    await queueDeliveriesTo(ctx, entity, await audienceOf(ctx, note, mentionIds));
};

/**
 * Sends remote instances the statuses local users post and edit, and Deletes for the ones they
 * delete, to the instances of each status's audience. An edit and a Delete go to the author's
 * followers as they are now, and an edit to the users it mentions now.
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
    const entity = deleteEntity(ctx, author.id, "Note", event.noteId);
    await queueDeliveriesTo(ctx, entity, await audienceOf(ctx, note, event.mentionIds));
};

/**
 * A local user's public and unlisted statuses, oldest first, so pages stay stable as more are
 * posted.
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
 * The public and unlisted statuses a local user pins to their profile, which Versia calls featuring
 * them, latest pinned first, as the profile shows them.
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

/** The collections that statuses add to Users. */
export const noteCollections: Readonly<Record<string, CollectionProvider>> = { outbox, featured };

/**
 * Removes the statuses of a user that a remote instance deleted, before the user is removed, in
 * batches, so that a user with many statuses doesn't hold one transaction open over all of them.
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
 * The statuses that link to a local status by `link`, oldest first, for an instance that may see
 * it. Only public and unlisted statuses are listed, so none is exposed to an instance that may not
 * see it.
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
 * Versia Notes: local ones, fetched by remote instances that may see them, and remote ones, sent or
 * fetched, with their authors, mentioned users and replied-to statuses fetched first.
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
        // A boost is deleted as a Share, not a Note.
        if (note?.reblog_of_id === null) await removeNote(ctx, note.id);
    },
    known: knownNote,
    collections: { replies: linkCollection("in_reply_to_id"), quotes: linkCollection("quote_id") },
    find: async (ctx, id, requester) => {
        const note = await findNote(ctx, id);
        // A boost is fetched as a Share, not a Note.
        if (note === undefined || note.instance_id !== null || note.reblog_of_id !== null) {
            return undefined;
        }
        if (!await instanceMaySee(ctx, note, requester)) return undefined;

        const [rendered] = await renderVersiaNotes(ctx, [note]);
        return rendered;
    },
};
