/**
 * Reactions as Versia has them: local users' reactions, as other instances fetch them and are sent
 * them, with the collection of a note's reactions.
 * @see https://versia.pub/extensions/reactions
 * @module
 */
import { parseReference, v0_6 } from "@versia/protocol";
import { instancesHosting } from "../accounts/account_queries.ts";
import { userReferences } from "../accounts/federation.ts";
import { emojiExtensions } from "../emojis/versia.ts";
import { queueDeliveriesTo } from "../federation/deliver.ts";
import type { CollectionProvider, EntityType } from "../federation/registry.ts";
import { followerInstances } from "../graph/follows.ts";
import { findInstanceId } from "../instances/instances.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { everyone, instanceMaySee } from "../notes/audience.ts";
import { findNote, type NoteRow } from "../notes/note_queries.ts";
import { noteReferenceMap } from "../notes/versia.ts";
import { isReactionEvent } from "./events.ts";
import {
    countReactionsOf,
    findLocalReaction,
    type LocalReaction,
    reactionIdsOf,
} from "./reaction_queries.ts";

const extension = "pub.versia:reactions";

const typeName = "pub.versia:reactions/Reaction";

/**
 * A local user's reaction as a Versia Reaction, if its user and note are still there. A custom
 * emoji is named in colons, with its picture in the extension for custom emojis, as Versia Server
 * sends them.
 */
const renderVersiaReaction = async (
    ctx: Context,
    reaction: LocalReaction,
): Promise<v0_6.Reaction | undefined> => {
    const [author] = await userReferences(ctx, [reaction.account_id]);
    const object = (await noteReferenceMap(ctx, [reaction.note_id])).get(reaction.note_id);
    if (author === undefined || object === undefined) return undefined;

    const { shortcode, url, media_type } = reaction;
    const emojis = shortcode === null || media_type === null
        ? []
        : [{ shortcode, instance_id: null, url, media_type }];

    return {
        type: typeName,
        id: reaction.id,
        created_at: reaction.created_at.toISOString(),
        author,
        object,
        content: reaction.text ?? `:${shortcode ?? ""}:`,
        extensions: emojiExtensions(emojis),
    };
};

/**
 * The other instances a local user's reaction to a note is sent to: the one of the note's author,
 * which must be told, and for a note anyone may see, those of the reactor's followers, as Versia
 * says. Others aren't told of reactions to notes they may not see.
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

    const entity: v0_6.Delete = {
        type: "Delete",
        created_at: ctx.clock.now().toISOString(),
        author: event.accountId,
        deleted_type: typeName,
        deleted: event.reactionId,
    };
    await queueDeliveriesTo(ctx, entity, audience);
};

/**
 * Whether `requester`, another instance, may see a local user's reaction to `note`: if it may see
 * the note, or the note is its own.
 */
const maySeeReaction = async (ctx: Context, note: NoteRow, requester: string) =>
    (note.instance_id !== null && note.instance_id === await findInstanceId(ctx, requester)) ||
    await instanceMaySee(ctx, note, requester);

/** The reactions to a local note, oldest first, for an instance that may see it. */
const noteReactions: CollectionProvider = async (ctx, id, page, requester) => {
    const note = await findNote(ctx, id);
    if (note === undefined || note.instance_id !== null || note.reblog_of_id !== null) {
        return undefined;
    }
    if (!await instanceMaySee(ctx, note, requester)) return undefined;

    return {
        author: note.account_id,
        total: await countReactionsOf(ctx, id),
        items: await reactionIdsOf(ctx, id, page.offset, page.limit),
    };
};

/** The collections reactions add to Notes. */
export const noteReactionCollections: Readonly<Record<string, CollectionProvider>> = {
    "pub.versia:reactions/Reactions": noteReactions,
};

/** Reactions: local users' ones, which other instances that may see their notes fetch. */
export const reactionType: EntityType<v0_6.Reaction> = {
    type: typeName,
    extension,
    schema: v0_6.Reaction,
    // Only its author's instance may send it.
    authority: (reaction, origin) => parseReference(reaction.author, origin)?.host,
    receive: () => {
        throw new PermanentFailure("Verso doesn't take in other instances' reactions yet");
    },
    find: async (ctx, id, requester) => {
        const reaction = await findLocalReaction(ctx, id);
        const note = reaction && await findNote(ctx, reaction.note_id);
        if (reaction === undefined || note === undefined) return undefined;
        if (!await maySeeReaction(ctx, note, requester)) return undefined;

        return await renderVersiaReaction(ctx, reaction);
    },
};
