/**
 * Likes and dislikes as Versia has them: local users' likes, as other instances fetch them and are
 * sent them, with the collections of who likes what, and other instances' ones, as Verso takes them
 * in.
 * @see https://versia.pub/extensions/likes
 * @module
 */
import { formatReference, parseReference, v0_6 } from "@versia/protocol";
import { findAccount } from "../accounts/account_queries.ts";
import { knownUser, userReferences } from "../accounts/federation.ts";
import { queueDeliveries } from "../federation/deliver.ts";
import type { CollectionProvider, EntityType, Sender } from "../federation/registry.ts";
import { findInstanceId } from "../instances/instances.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { everyone, instanceMaySee } from "../notes/audience.ts";
import { findNote, type NoteRow } from "../notes/note_queries.ts";
import { canSee } from "../notes/notes.ts";
import { knownNote } from "../notes/remote.ts";
import { noteReferenceMap } from "../notes/versia.ts";
import { isLikeEvent } from "./events.ts";
import {
    countLikesOfNote,
    countNotesLikedBy,
    findLocalLike,
    type LikeRow,
    likesOfNote,
    notesLikedBy,
} from "./like_queries.ts";
import { keepRemoteLike, undoRemoteLike } from "./likes.ts";
import type { LikeKind } from "./tables.ts";

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

/** A local user's like as a Versia Like, if its user and note are still there. */
const renderVersiaLike = async (ctx: Context, like: LikeRow): Promise<v0_6.Like | undefined> => {
    const [author] = await userReferences(ctx, [like.account_id]);
    const liked = (await noteReferenceMap(ctx, [like.note_id])).get(like.note_id);
    if (author === undefined || liked === undefined) return undefined;

    return {
        type: "pub.versia:likes/Like",
        id: like.id,
        created_at: like.created_at.toISOString(),
        author,
        liked,
    };
};

/**
 * Whether `requester`, another instance, may see a local user's like of `note`: if it may see the
 * note, or the note is its own.
 */
const maySeeLike = async (ctx: Context, note: NoteRow, requester: string) =>
    (note.instance_id !== null && note.instance_id === await findInstanceId(ctx, requester)) ||
    await instanceMaySee(ctx, note, requester);

/**
 * Sends a local user's like of another instance's note to that instance, and a Delete when they
 * undo it. Likes of local notes are for a local author, so nothing is sent.
 */
export const likeDeliveries = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isLikeEvent(event)) return;

    const note = await findNote(ctx, event.noteId);
    if (note === undefined) return;

    if (event.type === "interactions.liked") {
        const like = await findLocalLike(ctx, event.likeId);
        const entity = like && await renderVersiaLike(ctx, like);
        if (entity) await queueDeliveries(ctx, entity, [note.account_id]);
        return;
    }

    const author = await findAccount(ctx, event.accountId);
    if (author?.domain !== null) return;

    const entity: v0_6.Delete = {
        type: "Delete",
        created_at: ctx.clock.now().toISOString(),
        author: author.id,
        deleted_type: typeNames.like,
        deleted: event.likeId,
    };
    await queueDeliveries(ctx, entity, [note.account_id]);
};

/**
 * The likes or dislikes of a local note, oldest first, for an instance that may see it, as
 * references to them: bare ids for local ones, and the host and id for other instances' ones.
 */
const noteLikes = (kind: LikeKind): CollectionProvider => async (ctx, id, page, requester) => {
    const note = await findNote(ctx, id);
    if (note === undefined || note.instance_id !== null) return undefined;
    if (!await instanceMaySee(ctx, note, requester)) return undefined;

    const likes = await likesOfNote(ctx, id, kind, page.offset, page.limit);
    return {
        author: note.account_id,
        total: await countLikesOfNote(ctx, id, kind),
        items: likes.flatMap((like) => {
            if (like.domain === null) return [like.id];
            return like.remote_id === null
                ? []
                : [formatReference({ host: like.domain, id: like.remote_id }, ctx.urls.domain)];
        }),
    };
};

/**
 * The public and unlisted notes a local user likes or dislikes, the earliest liked first, so pages
 * stay put as more are liked. Local users never dislike notes, so they have none of those.
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

/** The collections likes add to Notes. */
export const noteLikeCollections: Readonly<Record<string, CollectionProvider>> = {
    [collectionNames.like]: noteLikes("like"),
    [collectionNames.dislike]: noteLikes("dislike"),
};

/** The collections likes add to Users. */
export const userLikeCollections: Readonly<Record<string, CollectionProvider>> = {
    [collectionNames.like]: userLikes("like"),
    [collectionNames.dislike]: userLikes("dislike"),
};

/** A Like or Dislike, with the note it is of under one name. */
type Liking = { readonly author: string; readonly note: string };

/** The note `liked`, in a like `sender` sent, if Verso has it. */
const likedNote = async (ctx: Context, liked: string, sender: Sender) => {
    const reference = parseReference(liked, sender.domain);
    const known = reference && await knownNote(ctx, reference);
    return known && await findNote(ctx, known.id);
};

/**
 * Likes or dislikes of notes. Verso keeps those of notes it has, and drops others, rather than
 * fetching notes no one here may want. Those of local notes must be by users who may see them.
 */
const likingType = <T extends v0_6.Like | v0_6.Dislike>(
    kind: LikeKind,
    schema: EntityType<T>["schema"],
    liking: (entity: T) => Liking,
): EntityType<T> => ({
    type: typeNames[kind],
    extension,
    schema,
    // Only its author's instance may send it.
    authority: (entity, origin) => parseReference(entity.author, origin)?.host,
    // The author is often new to Verso, but is only fetched for a like Verso will keep.
    prepare: async (ctx, entity, sender, budget) => {
        if (await likedNote(ctx, liking(entity).note, sender) === undefined) return;

        const author = parseReference(entity.author, sender.domain);
        if (author) await ctx.federation.resolve(ctx, author, "User", budget);
    },
    receive: async (ctx, entity, sender) => {
        const { author, note: liked } = liking(entity);
        const note = await likedNote(ctx, liked, sender);
        if (note === undefined) return;

        const reference = parseReference(author, sender.domain);
        const user = reference && await knownUser(ctx, reference);
        if (user === undefined) throw new PermanentFailure(`Verso doesn't have ${author}`);
        if (note.instance_id === null && !await canSee(ctx, note, user.id)) {
            throw new PermanentFailure(`${author} may not see ${liked}`);
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
});

/**
 * Likes and dislikes, as other instances send them, and Deletes undo them, and local users' likes,
 * which other instances that may see their notes fetch.
 */
export const likeTypes: readonly EntityType[] = [
    {
        ...likingType("like", v0_6.Like, (like) => ({ author: like.author, note: like.liked })),
        find: async (ctx, id, requester) => {
            const like = await findLocalLike(ctx, id);
            const note = like && await findNote(ctx, like.note_id);
            if (like === undefined || note === undefined) return undefined;
            if (!await maySeeLike(ctx, note, requester)) return undefined;

            return await renderVersiaLike(ctx, like);
        },
    },
    likingType(
        "dislike",
        v0_6.Dislike,
        (dislike) => ({ author: dislike.author, note: dislike.disliked }),
    ),
];
