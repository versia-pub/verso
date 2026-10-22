/**
 * Likes and dislikes as Versia has them: other instances' ones, as Verso takes them in.
 * @see https://versia.pub/extensions/likes
 * @module
 */
import { parseReference, v0_6 } from "@versia/protocol";
import { knownUser } from "../accounts/federation.ts";
import type { EntityType, Sender } from "../federation/registry.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { findNote } from "../notes/note_queries.ts";
import { canSee } from "../notes/notes.ts";
import { knownNote } from "../notes/remote.ts";
import { keepRemoteLike, undoRemoteLike } from "./likes.ts";
import type { LikeKind } from "./tables.ts";

const extension = "pub.versia:likes";

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
    type: kind === "like" ? "pub.versia:likes/Like" : "pub.versia:likes/Dislike",
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

/** Likes and dislikes, as other instances send them, and Deletes undo them. */
export const likeTypes: readonly EntityType[] = [
    likingType("like", v0_6.Like, (like) => ({ author: like.author, note: like.liked })),
    likingType(
        "dislike",
        v0_6.Dislike,
        (dislike) => ({ author: dislike.author, note: dislike.disliked }),
    ),
];
