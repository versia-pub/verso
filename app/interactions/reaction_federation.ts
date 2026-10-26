/**
 * Reactions as Versia has them: local users' reactions, as remote instances fetch them and are sent
 * them, with the collection of a status's reactions, and remote reactions, as Verso receives them.
 * @see https://versia.pub/extensions/reactions
 * @module
 */
import { parseReference, v0_6 } from "@versia/protocol";
import { instancesHosting } from "../accounts/account_queries.ts";
import { knownUser, userReferences } from "../accounts/federation.ts";
import type { RemoteEmoji } from "../emojis/emojis.ts";
import { emojiExtensions, remoteEmojisOf } from "../emojis/versia.ts";
import { queueDeliveriesTo } from "../federation/deliver.ts";
import type { CollectionProvider, EntityType, Sender } from "../federation/registry.ts";
import { followerInstances } from "../graph/follows.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { everyone, instanceMaySee, instanceMaySeeInteraction } from "../notes/audience.ts";
import { findNote, type NoteRow } from "../notes/note_queries.ts";
import { canSee } from "../notes/visibility.ts";
import { knownNoteRow } from "../notes/remote.ts";
import { noteReferenceMap } from "../notes/versia.ts";
import { isReactionEvent } from "./events.ts";
import {
    countReactionsOf,
    findLocalReaction,
    type LocalReaction,
    reactionPage,
} from "./reaction_queries.ts";
import { isUnicodeEmoji, keepRemoteReaction, undoRemoteReaction } from "./reactions.ts";
import { deleteEntity } from "../federation/delete.ts";
import { referencesTo } from "../federation/references.ts";

const extension = "pub.versia:reactions";

const typeName = "pub.versia:reactions/Reaction";

/**
 * A local user's reaction as a Versia Reaction, if its user and status still exist. A custom emoji
 * is named in colons, with its picture in the extension for custom emojis, as Versia Server sends
 * them.
 */
const renderVersiaReaction = async (
    ctx: Context,
    reaction: LocalReaction,
): Promise<v0_6.Reaction | undefined> => {
    const [author] = await userReferences(ctx, [reaction.account_id]);
    const object = (await noteReferenceMap(ctx, [reaction.note_id])).get(reaction.note_id);
    if (author === undefined || object === undefined) return undefined;

    const { shortcode, media_type } = reaction;
    const emojis = shortcode === null || media_type === null
        ? []
        : [{ ...reaction, shortcode, media_type, instance_id: null }];

    return {
        type: typeName,
        id: reaction.id,
        created_at: reaction.created_at.toISOString(),
        author,
        object,
        content: reaction.text ?? `:${shortcode ?? ""}:`,
        extensions: emojiExtensions(ctx, emojis),
    };
};

/**
 * The remote instances a local user's reaction to a status is sent to: the instance of the status's
 * author, which must be told, and for a status anyone may see, those of the reactor's followers, as
 * Versia specifies. Other instances aren't told of reactions to statuses they may not see.
 */
const audienceOfReaction = async (ctx: Context, accountId: string, note: NoteRow) => {
    const author = await instancesHosting(ctx, [note.account_id]);
    const followers = everyone.includes(note.visibility)
        ? await followerInstances(ctx, accountId)
        : [];

    return [...new Set([...followers, ...author])].toSorted();
};

/** Sends local users' reactions, and a Delete when they undo one. */
export const reactionDeliveries = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isReactionEvent(event)) return;

    const note = await findNote(ctx, event.noteId);
    if (note === undefined) return;
    const audience = await audienceOfReaction(ctx, event.accountId, note);

    if (event.type === "interactions.reacted") {
        const reaction = await findLocalReaction(ctx, event.reactionId);
        const entity = reaction && await renderVersiaReaction(ctx, reaction);
        if (entity) await queueDeliveriesTo(ctx, entity, audience);
        return;
    }

    const entity = deleteEntity(ctx, event.accountId, typeName, event.reactionId);
    await queueDeliveriesTo(ctx, entity, audience);
};

/**
 * Whether `requester`, a remote instance, may see a local user's reaction to `note`: if it may see
 * the status, or the status is its own.
 */
const maySeeReaction = (ctx: Context, note: NoteRow, requester: string) =>
    instanceMaySeeInteraction(ctx, note, note, requester);

/**
 * The reactions to a local status, oldest first, for an instance that may see it, as references to
 * them: bare ids for local ones, and the host and id for remote ones.
 */
const noteReactions: CollectionProvider = async (ctx, id, page, requester) => {
    const note = await findNote(ctx, id);
    if (note === undefined || note.instance_id !== null || note.reblog_of_id !== null) {
        return undefined;
    }
    if (!await instanceMaySee(ctx, note, requester)) return undefined;

    const reactions = await reactionPage(ctx, id, page.offset, page.limit);
    return {
        author: note.account_id,
        total: await countReactionsOf(ctx, id),
        items: referencesTo(ctx, reactions),
    };
};

/** The collections that reactions add to Notes. */
export const noteReactionCollections: Readonly<Record<string, CollectionProvider>> = {
    "pub.versia:reactions/Reactions": noteReactions,
};

/** The status that a reaction sent by `sender` is to, if Verso has it. */
const reactedNote = (ctx: Context, reaction: v0_6.Reaction, sender: Sender) =>
    knownNoteRow(ctx, parseReference(reaction.object, sender.domain));

/**
 * The emoji of a reaction sent by a remote instance: a Unicode emoji, or one of its custom emojis,
 * named in colons, with its picture in the reaction's extensions. Versia lets a reaction be any
 * text, which Mastodon's clients can't display, so for others it is `undefined`.
 */
const remoteReactionEmoji = (reaction: v0_6.Reaction): string | RemoteEmoji | undefined => {
    if (isUnicodeEmoji(reaction.content)) return reaction.content;

    const shortcode = /^:([A-Za-z0-9_-]+):$/u.exec(reaction.content)?.[1];
    return remoteEmojisOf(reaction.extensions).find((emoji) => emoji.shortcode === shortcode);
};

/**
 * Reactions: remote ones, as remote instances send them, and Deletes undo them, and local users'
 * ones, which remote instances that may see their statuses fetch. Verso stores those to statuses it
 * has, with an emoji it can display, and drops others. Those to local statuses must be by users who
 * may see them.
 */
export const reactionType: EntityType<v0_6.Reaction> = {
    type: typeName,
    extension,
    schema: v0_6.Reaction,
    // Only its author's instance may send it.
    authority: (reaction, origin) => parseReference(reaction.author, origin)?.host,
    // The author is often new to Verso, but is only fetched for a reaction Verso will store.
    prepare: async (ctx, reaction, sender, budget) => {
        if (remoteReactionEmoji(reaction) === undefined) return;
        if (await reactedNote(ctx, reaction, sender) === undefined) return;

        const author = parseReference(reaction.author, sender.domain);
        if (author) await ctx.federation.resolve(ctx, author, "User", budget);
    },
    receive: async (ctx, reaction, sender) => {
        const emoji = remoteReactionEmoji(reaction);
        const note = await reactedNote(ctx, reaction, sender);
        if (emoji === undefined || note === undefined) return;

        const reference = parseReference(reaction.author, sender.domain);
        const user = reference && await knownUser(ctx, reference);
        if (user === undefined) throw new PermanentFailure(`Verso doesn't have ${reaction.author}`);
        if (note.instance_id === null && !await canSee(ctx, note, user.id)) {
            throw new PermanentFailure(`${reaction.author} may not see ${reaction.object}`);
        }

        await keepRemoteReaction(ctx, {
            accountId: user.id,
            noteId: note.id,
            emoji,
            instanceId: sender.instanceId,
            remoteId: reaction.id,
            createdAt: new Date(reaction.created_at),
        });
    },
    deleteRemote: (ctx, id, sender) => undoRemoteReaction(ctx, sender.instanceId, id),
    find: async (ctx, id, requester) => {
        const reaction = await findLocalReaction(ctx, id);
        const note = reaction && await findNote(ctx, reaction.note_id);
        if (reaction === undefined || note === undefined) return undefined;
        if (!await maySeeReaction(ctx, note, requester)) return undefined;

        return await renderVersiaReaction(ctx, reaction);
    },
};
