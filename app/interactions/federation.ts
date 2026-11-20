/**
 * Likes and dislikes in Versia: local users' likes, which remote instances fetch and are sent, with
 * the collections of who likes what, and remote likes, which Verso receives.
 * @see https://versia.pub/extensions/likes
 * @module
 */
import { v0_7 } from "@versia/protocol";
import { findAccount } from "../accounts/account_queries.ts";
import { knownUser, userReferences } from "../accounts/federation.ts";
import { queueDeliveriesTo } from "../federation/deliver.ts";
import type { CollectionProvider, EntityType } from "../federation/registry.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { everyone, instanceMaySee, instanceMaySeeInteraction } from "../notes/audience.ts";
import { findNote, type NoteRow } from "../notes/note_queries.ts";
import { canSee } from "../notes/visibility.ts";
import { knownNoteRow } from "../notes/remote.ts";
import { noteReferenceMap } from "../notes/versia.ts";
import { audienceOfInteraction } from "./audience.ts";
import { authorityOf, resolveAuthor } from "./authors.ts";
import { isLikeEvent } from "./events.ts";
import {
    countLikesOfNote,
    countNotesLikedBy,
    findLocalLike,
    findRemoteLike,
    type LikeRow,
    likesOfNote,
    notesLikedBy,
} from "./like_queries.ts";
import { keepRemoteLike, undoRemoteLike } from "./likes.ts";
import type { LikeKind } from "./tables.ts";
import { queueDelete } from "../federation/tombstones.ts";
import { referencesTo } from "../federation/references.ts";

const extension = "pub.versia:likes";

const typeNames: Readonly<Record<LikeKind, string>> = {
    like: "pub.versia:likes/Like",
    dislike: "pub.versia:likes/Dislike",
};

/** The names of the collections of likes and dislikes, on Notes and Users alike. */
const collectionNames: Readonly<Record<LikeKind, string>> = {
    like: "pub.versia:likes/Likes",
    dislike: "pub.versia:likes/Dislikes",
};

/** A local user's like as a Versia Like, if its user and status still exist. */
const renderVersiaLike = async (ctx: Context, like: LikeRow): Promise<v0_7.Like | undefined> => {
    const [author] = await userReferences(ctx, [like.account_id]);
    const target = (await noteReferenceMap(ctx, [like.note_id])).get(like.note_id);
    if (author === undefined || target === undefined) return undefined;

    return {
        type: "pub.versia:likes/Like",
        id: like.id,
        created_at: like.created_at.toISOString(),
        author,
        target,
    };
};

/**
 * Whether `requester`, a remote instance, may see a local user's like of `note`: if it may see the
 * status, or the status is its own.
 */
const maySeeLike = (ctx: Context, note: NoteRow, requester: string) =>
    instanceMaySeeInteraction(ctx, note, note, requester);

/**
 * Sends a local user's like to the instance of the status's author, and for a status anyone may see,
 * to those of the user's followers. A Delete goes to the same instances when they undo it.
 */
export const likeDeliveries = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isLikeEvent(event)) return;

    const note = await findNote(ctx, event.noteId);
    if (note === undefined) return;

    if (event.type === "interactions.liked") {
        const like = await findLocalLike(ctx, event.likeId);
        const entity = like && await renderVersiaLike(ctx, like);
        if (entity) {
            await queueDeliveriesTo(
                ctx,
                entity,
                await audienceOfInteraction(ctx, like.account_id, note),
            );
        }
        return;
    }

    const author = await findAccount(ctx, event.accountId);
    if (author?.domain !== null) return;

    await queueDelete(
        ctx,
        author.id,
        typeNames.like,
        event.likeId,
        await audienceOfInteraction(ctx, author.id, note),
    );
};

/**
 * The likes or dislikes of a local status, oldest first, for an instance that may see it, as
 * references to them, each with its host and id.
 */
const noteLikes = (kind: LikeKind): CollectionProvider => async (ctx, id, page, requester) => {
    const note = await findNote(ctx, id);
    if (note === undefined || note.instance_id !== null) return undefined;
    if (!await instanceMaySee(ctx, note, requester)) return undefined;

    const likes = await likesOfNote(ctx, id, kind, page.offset, page.limit);
    return {
        author: note.account_id,
        total: await countLikesOfNote(ctx, id, kind),
        items: referencesTo(ctx, likes),
    };
};

/**
 * The public and unlisted statuses a local user likes or dislikes, earliest liked first, so pages
 * stay stable as more are liked. Local users never dislike statuses, so they have none of those.
 */
const userLikes = (kind: LikeKind): CollectionProvider => async (ctx, id, page) => {
    const owner = await findAccount(ctx, id);
    if (owner?.domain !== null) return undefined;

    const ids = await notesLikedBy(ctx, id, kind, everyone, page.offset, page.limit);
    const references = await noteReferenceMap(ctx, ids);
    return {
        author: id,
        total: await countNotesLikedBy(ctx, id, kind, everyone),
        items: ids.flatMap((each) => references.get(each) ?? []),
    };
};

/** The collections that likes add to Notes. */
export const noteLikeCollections: Readonly<Record<string, CollectionProvider>> = {
    [collectionNames.like]: noteLikes("like"),
    [collectionNames.dislike]: noteLikes("dislike"),
};

/** The collections that likes add to Users. */
export const userLikeCollections: Readonly<Record<string, CollectionProvider>> = {
    [collectionNames.like]: userLikes("like"),
    [collectionNames.dislike]: userLikes("dislike"),
};

/** The status `target`, in a like, if Verso has it. */
const likedNote = (ctx: Context, target: string) => knownNoteRow(ctx, v0_7.parseReference(target));

/**
 * Likes or dislikes of statuses. Verso stores those of statuses it has, and drops others, rather
 * than fetching statuses no local user may want. Those of local statuses must be by users who may
 * see them.
 */
const likingType = <T extends v0_7.Like | v0_7.Dislike>(
    kind: LikeKind,
    schema: EntityType<T>["schema"],
): EntityType<T> => ({
    type: typeNames[kind],
    extension,
    schema,
    // Only its author's instance may send it.
    authority: authorityOf,
    // The author is only fetched for a like Verso will store.
    prepare: async (ctx, entity, _sender, budget) => {
        if (await likedNote(ctx, entity.target) === undefined) return;

        await resolveAuthor(ctx, entity, budget);
    },
    receive: async (ctx, entity, sender) => {
        const { author, target } = entity;
        const note = await likedNote(ctx, target);
        if (note === undefined) return;

        const reference = v0_7.parseReference(author);
        const user = reference && await knownUser(ctx, reference);
        if (user === undefined) throw new PermanentFailure(`Verso doesn't have ${author}`);
        if (note.instance_id === null && !await canSee(ctx, note, user.id)) {
            throw new PermanentFailure(`${author} may not see ${target}`);
        }

        await keepRemoteLike(ctx, {
            accountId: user.id,
            noteId: note.id,
            kind,
            instanceId: sender.instanceId,
            remoteId: entity.id,
            createdAt: new Date(entity.created_at),
        });
    },
    deleteRemote: (ctx, id, sender) => undoRemoteLike(ctx, sender.instanceId, id),
    hasRemote: async (ctx, id, sender) =>
        (await findRemoteLike(ctx, sender.instanceId, id))?.kind === kind,
});

/**
 * Likes and dislikes that remote instances send, which Deletes undo, and local users' likes, which
 * remote instances that may see their statuses fetch.
 */
export const likeTypes: readonly EntityType[] = [
    {
        ...likingType("like", v0_7.Like),
        find: async (ctx, id, requester) => {
            const like = await findLocalLike(ctx, id);
            const note = like && await findNote(ctx, like.note_id);
            if (like === undefined || note === undefined) return undefined;
            if (!await maySeeLike(ctx, note, requester)) return undefined;

            return await renderVersiaLike(ctx, like);
        },
    },
    likingType("dislike", v0_7.Dislike),
];
