/**
 * Notes as Versia shows them: local ones, as other instances fetch them and are sent them, the
 * users they are shown to, and other instances' notes, as Verso keeps them.
 * @see https://versia.pub/entities/note
 * @module
 */
import { getLogger } from "@logtape/logtape";
import { formatReference, parseReference, type Reference, v0_6 } from "@versia/protocol";
import { countNote, findAccount, instancesHosting } from "../accounts/accounts.ts";
import { knownUser, remoteText, userReferenceMap } from "../accounts/federation.ts";
import type { Visibility } from "../accounts/tables.ts";
import { queueDeliveries } from "../federation/deliver.ts";
import type { CollectionProvider, EntityType, Known, Sender } from "../federation/registry.ts";
import { isRemoteFailure } from "../federation/resolver.ts";
import { followerIds } from "../graph/follows.ts";
import { findInstanceId } from "../instances/instances.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Budget, Context, DomainEvent } from "../kernel/context.ts";
import { renderText, scanText } from "../kernel/markup.ts";
import { isNoteDeleted, isNotePosted } from "./events.ts";
import {
    countNotesBy,
    countReply,
    findNote,
    findRemoteNote,
    findRemoteNoteAt,
    insertNote,
    mentionsOf,
    noteOrigins,
    type NoteRow,
    notesBy,
    updateNote,
} from "./note_queries.ts";
import { removeNote } from "./notes.ts";

const logger = getLogger(["verso", "notes"]);

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
    const linked = await noteReferenceMap(
        ctx,
        notes.flatMap((note) => [note.in_reply_to_id ?? [], note.quote_id ?? []].flat()),
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
            replies_to: note.in_reply_to_id === null ? undefined : linked.get(note.in_reply_to_id),
            quotes: note.quote_id === null ? undefined : linked.get(note.quote_id),
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
 * A note's visibility, from who Versia says it is for. Verso has no groups, so a group's note is
 * only for those it mentions.
 */
const visibilityOf = (group: string | null | undefined): Visibility =>
    group === "public" ? "public" : group === "followers" ? "private" : "direct";

/** The note `reference` points at, local or remote, if Verso has it, without fetching it. */
const knownNote = async (ctx: Context, reference: Reference): Promise<Known | undefined> => {
    if (reference.host === ctx.urls.domain) {
        const note = await findNote(ctx, reference.id);
        return note?.instance_id === null ? { id: note.id, fetchedAt: null } : undefined;
    }

    const note = await findRemoteNoteAt(ctx, reference.host, reference.id);
    // A remote note is always saved with when it was fetched.
    return note && { id: note.id, fetchedAt: note.fetched_at ?? new Date(0) };
};

/**
 * Who a note sent by `sender` names: its author, who it mentions, and what it replies to and
 * quotes.
 */
const referencesIn = (note: v0_6.Note, sender: Sender) => ({
    author: parseReference(note.author, sender.domain),
    mentions: note.mentions.flatMap((text) => parseReference(text, sender.domain) ?? []),
    parent: note.replies_to ? parseReference(note.replies_to, sender.domain) : undefined,
    quote: note.quotes ? parseReference(note.quotes, sender.domain) : undefined,
});

/** Fetches what a note names, if Verso doesn't have it; a note does without what can't be had. */
const resolveIfAble = async (
    ctx: Context,
    reference: Reference,
    type: "User" | "Note",
    budget: Budget,
) => {
    try {
        await ctx.federation.resolve(ctx, reference, type, budget);
    } catch (error) {
        if (!isRemoteFailure(error)) throw error;
        logger.warn("Couldn't fetch the {type} {id} on {host}: {error}", {
            type,
            ...reference,
            error,
        });
    }
};

/**
 * Whether a note sent unasked is one Verso wants: by someone a local user follows, or mentioning,
 * replying to or quoting something local. Others could fill Verso with notes nobody here would
 * see.
 */
const wanted = async (
    ctx: Context,
    authorId: string,
    mentions: readonly { readonly id: string; readonly local: boolean }[],
    linked: readonly (NoteRow | undefined)[],
) => mentions.some((mention) => mention.local) ||
    linked.some((note) => note?.instance_id === null) ||
    // Verso keeps only follows with a local side, so any follower of another instance's user is a
    // local one.
    (await followerIds(ctx, authorId)).length > 0;

/** The note `reference` points at, if there is one and Verso has it. */
const knownNoteRow = async (ctx: Context, reference: Reference | undefined) => {
    const known = reference && await knownNote(ctx, reference);
    return known && await findNote(ctx, known.id);
};

/**
 * Saves a note `sender` sent, or a newer version of one Verso has, without who it mentions or the
 * notes it replies to or quotes that Verso doesn't have. A new one is counted, and what it replies
 * to and quotes stay for good, even if a newer version says otherwise.
 */
const receiveNote = async (ctx: Context, note: v0_6.Note, sender: Sender) => {
    const references = referencesIn(note, sender);
    const author = references.author && await knownUser(ctx, references.author);
    if (author === undefined) throw new PermanentFailure(`Verso doesn't have ${note.author}`);

    const mentions = [];
    for (const reference of references.mentions) {
        const user = await knownUser(ctx, reference);
        if (user) mentions.push({ id: user.id, local: reference.host === ctx.urls.domain });
    }
    const parent = await knownNoteRow(ctx, references.parent);
    const quote = await knownNoteRow(ctx, references.quote);

    const existing = await findRemoteNote(ctx, sender.instanceId, note.id);
    if (existing && existing.account_id !== author.id) {
        throw new PermanentFailure(`${sender.domain} may not give ${note.id} another author`);
    }
    if (!existing && !sender.fetched && !await wanted(ctx, author.id, mentions, [parent, quote])) {
        return;
    }

    const content = remoteText(note.content, (text, format) => renderText(text, format));
    const changes = {
        visibility: visibilityOf(note.group),
        content: content.text,
        content_format: content.format,
        content_html: content.html,
        spoiler_text: note.subject ?? "",
        sensitive: note.is_sensitive,
        fetched_at: ctx.clock.now(),
    };
    const mentionIds = mentions.map((mention) => mention.id);
    const tags = scanText(content.text, content.format).hashtags;

    if (existing) return await updateNote(ctx, existing.id, changes, mentionIds, tags);

    const row = await insertNote(
        ctx,
        {
            id: ctx.ids(),
            account_id: author.id,
            instance_id: sender.instanceId,
            remote_id: note.id,
            ...changes,
            // Versia doesn't say.
            language: null,
            in_reply_to_id: parent?.id ?? null,
            in_reply_to_account_id: parent?.account_id ?? null,
            quote_id: quote?.id ?? null,
            created_at: new Date(note.created_at),
            edited_at: null,
        },
        mentionIds,
        tags,
    );
    await countNote(ctx, author.id, 1, row.created_at);
    if (parent !== undefined) await countReply(ctx, parent.id, 1);
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
    prepare: async (ctx, note, sender, budget) => {
        const { author, mentions, parent, quote } = referencesIn(note, sender);
        // Without its author, the note can't be kept, so it is tried again later.
        if (author) await ctx.federation.resolve(ctx, author, "User", budget);

        for (const mention of mentions) await resolveIfAble(ctx, mention, "User", budget);
        if (parent) await resolveIfAble(ctx, parent, "Note", budget);
        if (quote) await resolveIfAble(ctx, quote, "Note", budget);
    },
    receive: receiveNote,
    deleteRemote: async (ctx, id, sender) => {
        const note = await findRemoteNote(ctx, sender.instanceId, id);
        if (note) await removeNote(ctx, note.id);
    },
    known: knownNote,
    find: async (ctx, id, requester) => {
        const note = await findNote(ctx, id);
        if (note === undefined || note.instance_id !== null) return undefined;
        if (!await seenBy(ctx, note, requester)) return undefined;

        const [rendered] = await renderVersiaNotes(ctx, [note]);
        return rendered;
    },
};
