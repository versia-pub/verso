/**
 * Other instances' notes, as Verso takes them in, sent or fetched.
 * @see https://versia.pub/entities/note
 * @module
 */
import { getLogger } from "@logtape/logtape";
import { parseReference, type Reference, type v0_6 } from "@versia/protocol";
import { knownUser, remoteText } from "../accounts/federation.ts";
import type { Visibility } from "../accounts/tables.ts";
import type { Known, Sender } from "../federation/registry.ts";
import { isRemoteFailure } from "../federation/resolver.ts";
import { hasFollowers } from "../graph/follows.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Budget, Context } from "../kernel/context.ts";
import { textOfHtml } from "../kernel/html.ts";
import { renderText, scanText } from "../kernel/markup.ts";
import {
    findNote,
    findRemoteNote,
    findRemoteNoteAt,
    insertNote,
    keepVersion,
    type NoteRow,
    updateNote,
} from "./note_queries.ts";
import { countPosted } from "./notes.ts";

const logger = getLogger(["verso", "notes"]);

/**
 * A note's visibility, from who Versia says it is for. Verso has no groups, so a group's note is
 * only for those it mentions.
 */
const visibilityOf = (group: string | null | undefined): Visibility =>
    group === "public" ? "public" : group === "followers" ? "private" : "direct";

/**
 * The note `reference` points at, local or remote, if Verso has it, without fetching it. Shares
 * aren't notes here.
 */
export const knownNote = async (ctx: Context, reference: Reference): Promise<Known | undefined> => {
    // A share isn't a Note in Versia, so nothing can reply to, quote or like it.
    if (reference.host === ctx.urls.domain) {
        const note = await findNote(ctx, reference.id);
        return note?.instance_id === null && note.reblog_of_id === null
            ? { id: note.id, fetchedAt: null }
            : undefined;
    }

    const note = await findRemoteNoteAt(ctx, reference.host, reference.id);
    // A remote note is always saved with when it was fetched.
    return note?.reblog_of_id === null
        ? { id: note.id, fetchedAt: note.fetched_at ?? new Date(0) }
        : undefined;
};

/**
 * How many mentions and hashtags of another instance's note Verso keeps. Each costs queries, so a
 * note can't make Verso do unbounded work.
 */
const remoteLinks = 100;

/**
 * Who a note sent by `sender` names: its author, the first {@link remoteLinks} it mentions, and
 * what it replies to and quotes.
 */
const referencesIn = (note: v0_6.Note, sender: Sender) => ({
    author: parseReference(note.author, sender.domain),
    mentions: [...new Set(note.mentions)].slice(0, remoteLinks)
        .flatMap((text) => parseReference(text, sender.domain) ?? []),
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
    authorId: string | undefined,
    mentions: readonly { readonly id: string; readonly local: boolean }[],
    linked: readonly (NoteRow | undefined)[],
) => mentions.some((mention) => mention.local) ||
    linked.some((note) => note?.instance_id === null) ||
    // Verso keeps only follows with a local side, so any follower of another instance's user is a
    // local one.
    (authorId !== undefined && await hasFollowers(ctx, authorId));

/**
 * Whether a note sent unasked may be {@link wanted}, from what Verso has, before fetching what it
 * names: those are kept, so an unwanted note mustn't make Verso fetch them.
 */
const mayBeWanted = async (ctx: Context, note: v0_6.Note, sender: Sender) => {
    const references = referencesIn(note, sender);
    const named = [...references.mentions, references.parent, references.quote];
    if (named.some((reference) => reference?.host === ctx.urls.domain)) return true;
    if (await findRemoteNote(ctx, sender.instanceId, note.id)) return true;

    const author = references.author && await knownUser(ctx, references.author);
    return author !== undefined && await hasFollowers(ctx, author.id);
};

/** The note `reference` points at, if there is one and Verso has it. */
const knownNoteRow = async (ctx: Context, reference: Reference | undefined) => {
    const known = reference && await knownNote(ctx, reference);
    return known && await findNote(ctx, known.id);
};

/**
 * Saves a note `sender` sent, or a newer version of one Verso has, without who it mentions or the
 * notes it replies to or quotes that Verso doesn't have. A new one is counted, and what it replies
 * to and quotes stay for good, even if a newer version says otherwise. A newer version that says
 * something else is marked edited now, as Versia doesn't say when, and what it said is kept for its
 * history.
 */
export const receiveNote = async (
    ctx: Context,
    note: v0_6.Note,
    sender: Sender,
): Promise<void> => {
    const references = referencesIn(note, sender);
    const author = references.author && await knownUser(ctx, references.author);

    const mentions = [];
    for (const reference of references.mentions) {
        const user = await knownUser(ctx, reference);
        if (user) mentions.push({ id: user.id, local: reference.host === ctx.urls.domain });
    }
    const parent = await knownNoteRow(ctx, references.parent);
    const quote = await knownNoteRow(ctx, references.quote);

    const existing = await findRemoteNote(ctx, sender.instanceId, note.id);
    if (!existing && !sender.fetched && !await wanted(ctx, author?.id, mentions, [parent, quote])) {
        return;
    }

    if (author === undefined) throw new PermanentFailure(`Verso doesn't have ${note.author}`);
    if (existing && existing.reblog_of_id !== null) {
        throw new PermanentFailure(`${note.id} on ${sender.domain} is a Share, not a Note`);
    }
    if (existing && existing.account_id !== author.id) {
        throw new PermanentFailure(`${sender.domain} may not give ${note.id} another author`);
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
    // A note only in HTML has its hashtags in that.
    const hashtags = content.text === ""
        ? scanText(textOfHtml(content.html), "text/plain").hashtags
        : scanText(content.text, content.format).hashtags;
    const tags = [...new Set(hashtags.map((tag) => tag.toLowerCase()))].slice(0, remoteLinks);

    if (existing) {
        const edited = changes.content !== existing.content ||
            changes.content_format !== existing.content_format ||
            changes.content_html !== existing.content_html ||
            changes.spoiler_text !== existing.spoiler_text ||
            changes.sensitive !== existing.sensitive;
        if (edited) await keepVersion(ctx, existing);

        // Who it is for may change, and with it whether it is counted.
        if (changes.visibility !== existing.visibility) {
            await countPosted(ctx, existing, -1);
            await countPosted(ctx, { ...existing, visibility: changes.visibility }, 1);
        }

        return await updateNote(
            ctx,
            existing.id,
            { ...changes, edited_at: edited ? ctx.clock.now() : existing.edited_at },
            mentionIds,
            tags,
        );
    }

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
    await countPosted(ctx, row, 1);
};

/**
 * Fetches what a note `sender` sent names, before its transaction, unless it was sent unasked and
 * isn't wanted: its author, who it mentions, and what it replies to and quotes.
 */
export const prepareNote = async (
    ctx: Context,
    note: v0_6.Note,
    sender: Sender,
    budget: Budget,
): Promise<void> => {
    if (!sender.fetched && !await mayBeWanted(ctx, note, sender)) return;

    const { author, mentions, parent, quote } = referencesIn(note, sender);
    // Without its author, the note can't be kept, so it is tried again later.
    if (author) await ctx.federation.resolve(ctx, author, "User", budget);

    for (const mention of mentions) await resolveIfAble(ctx, mention, "User", budget);
    if (parent) await resolveIfAble(ctx, parent, "Note", budget);
    if (quote) await resolveIfAble(ctx, quote, "Note", budget);
};
