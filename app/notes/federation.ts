/**
 * Notes as Versia shows them: local ones, as other instances fetch them and are sent them, and the
 * users they are shown to.
 * @see https://versia.pub/entities/note
 * @module
 */
import { formatReference, parseReference, v0_6 } from "@versia/protocol";
import { findAccount, instancesHosting } from "../accounts/accounts.ts";
import { userReferenceMap } from "../accounts/federation.ts";
import type { Visibility } from "../accounts/tables.ts";
import { queueDeliveries } from "../federation/deliver.ts";
import type { CollectionProvider, EntityType } from "../federation/registry.ts";
import { followerIds } from "../graph/follows.ts";
import { findInstanceId } from "../instances/instances.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { isNoteDeleted, isNotePosted } from "./events.ts";
import {
    countNotesBy,
    findNote,
    mentionsOf,
    noteOrigins,
    type NoteRow,
    notesBy,
} from "./note_queries.ts";

/** Who a note is for, as Versia says it. Unlisted notes are public, as Versia has no unlisted. */
const groups: Record<Visibility, string | undefined> = {
    public: "public",
    unlisted: "public",
    private: "followers",
    // Only the users it mentions.
    direct: undefined,
};

/** The visibilities anyone may see. */
const everyone: readonly Visibility[] = ["public", "unlisted"];

/**
 * The accounts a local note is shown to, other than its author: the users it mentions, the
 * author's followers unless it is direct, and the author of the note a public or unlisted one
 * replies to, whose instance can then show the thread.
 */
export const audienceOf = async (
    ctx: Context,
    note: Pick<NoteRow, "account_id" | "visibility" | "in_reply_to_account_id">,
    mentionIds: readonly string[],
): Promise<string[]> => {
    const followers = note.visibility === "direct" ? [] : await followerIds(ctx, note.account_id);
    const replied = everyone.includes(note.visibility) && note.in_reply_to_account_id !== null
        ? [note.in_reply_to_account_id]
        : [];

    const audience = new Set([...mentionIds, ...followers, ...replied]);
    audience.delete(note.account_id);

    return [...audience];
};

/** References to the notes of `ids` that exist, by id, as Verso puts them in what it sends. */
const noteReferenceMap = async (ctx: Context, ids: readonly string[]) => {
    const references = new Map<string, string>();

    for (const note of await noteOrigins(ctx, ids)) {
        if (note.domain === null) {
            references.set(note.id, note.id);
            continue;
        }

        if (note.remote_id === null) throw new Error(`Remote note ${note.id} has no remote id`);
        references.set(
            note.id,
            formatReference({ host: note.domain, id: note.remote_id }, ctx.urls.domain),
        );
    }

    return references;
};

/** Local notes as Versia Notes, in the order given. */
const renderVersiaNotes = async (ctx: Context, notes: readonly NoteRow[]): Promise<v0_6.Note[]> => {
    const mentions = await mentionsOf(ctx, notes.map((note) => note.id));
    const users = await userReferenceMap(ctx, [
        ...new Set([...notes.map((note) => note.account_id), ...[...mentions.values()].flat()]),
    ]);
    const parents = await noteReferenceMap(
        ctx,
        notes.flatMap((note) => note.in_reply_to_id ?? []),
    );

    return notes.map((note): v0_6.Note => {
        const author = users.get(note.account_id);
        if (author === undefined) throw new Error(`Note ${note.id} has no author`);

        return {
            type: "Note",
            id: note.id,
            created_at: note.created_at.toISOString(),
            author,
            category: "microblog",
            content: {
                [note.content_format]: { content: note.content, remote: false },
                "text/html": { content: note.content_html, remote: false },
            },
            group: groups[note.visibility],
            is_sensitive: note.sensitive,
            subject: note.spoiler_text === "" ? undefined : note.spoiler_text,
            mentions: (mentions.get(note.id) ?? []).flatMap((id) => users.get(id) ?? []),
            replies_to: note.in_reply_to_id === null ? undefined : parents.get(note.in_reply_to_id),
            attachments: [],
            previews: [],
        };
    });
};

/**
 * Whether `requester`, another instance, may see a local note: anyone may see a public or unlisted
 * one, and an instance may see another if any of its users is shown it.
 */
const seenBy = async (ctx: Context, note: NoteRow, requester: string) => {
    if (everyone.includes(note.visibility)) return true;

    // Saves finding the audience for an instance Verso doesn't know, which can't be in it.
    const instanceId = await findInstanceId(ctx, requester);
    if (instanceId === undefined) return false;

    const mentionIds = (await mentionsOf(ctx, [note.id])).get(note.id) ?? [];
    const audience = await audienceOf(ctx, note, mentionIds);

    return (await instancesHosting(ctx, audience)).includes(instanceId);
};

/** Sends a local note just posted to the instances of those it is shown to. */
const sendNote = async (ctx: Context, noteId: string) => {
    const note = await findNote(ctx, noteId);
    if (note === undefined) return;

    const mentionIds = (await mentionsOf(ctx, [note.id])).get(note.id) ?? [];
    const [entity] = await renderVersiaNotes(ctx, [note]);
    await queueDeliveries(ctx, entity, await audienceOf(ctx, note, mentionIds));
};

/**
 * Sends other instances the notes local users post, and Deletes for the ones they delete, to the
 * instances of those each was shown to. A Delete goes to the author's followers as they are now.
 */
export const noteDeliveries = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (isNotePosted(event)) return await sendNote(ctx, event.noteId);
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
    await queueDeliveries(ctx, entity, await audienceOf(ctx, note, event.mentionIds));
};

/** A local user's public and unlisted notes, oldest first, so pages stay put as more are written. */
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

/** The collections notes add to Users. */
export const noteCollections: Readonly<Record<string, CollectionProvider>> = { outbox };

/**
 * Notes: local ones, fetched by other instances that may see them. Other instances' notes aren't
 * taken yet.
 */
export const noteType: EntityType<v0_6.Note> = {
    type: "Note",
    schema: v0_6.Note,
    // Only its author's instance may send it.
    authority: (note, origin) => parseReference(note.author, origin)?.host,
    receive: () =>
        Promise.reject(new PermanentFailure("Verso doesn't take notes from other instances yet")),
    find: async (ctx, id, requester) => {
        const note = await findNote(ctx, id);
        if (note === undefined || note.instance_id !== null) return undefined;
        if (!await seenBy(ctx, note, requester)) return undefined;

        const [rendered] = await renderVersiaNotes(ctx, [note]);
        return rendered;
    },
};
