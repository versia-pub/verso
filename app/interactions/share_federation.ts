/**
 * Shares as Versia has them: local users' shares, as other instances fetch them and are sent them,
 * with the collection of who shares a note, and other instances' ones, as Verso takes them in.
 * @see https://versia.pub/extensions/share
 * @module
 */
import { parseReference, v0_6 } from "@versia/protocol";
import { instancesHosting } from "../accounts/account_queries.ts";
import { knownUser, userReferences } from "../accounts/federation.ts";
import { queueDeliveriesTo } from "../federation/deliver.ts";
import type { CollectionProvider, EntityType, Sender } from "../federation/registry.ts";
import { followerInstances, hasFollowers } from "../graph/follows.ts";
import { findInstanceId } from "../instances/instances.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { everyone, instanceMaySee } from "../notes/audience.ts";
import { countSharesOf, findNote, type NoteRow, shareIdsOf } from "../notes/note_queries.ts";
import { canSee } from "../notes/notes.ts";
import { knownNote } from "../notes/remote.ts";
import { noteReferenceMap } from "../notes/versia.ts";
import { isShareEvent } from "./events.ts";
import { keepRemoteShare, undoRemoteShare } from "./shares.ts";

const extension = "pub.versia:share";

const typeName = "pub.versia:share/Share";

/** A local user's share as a Versia Share, if its user and the note it shares are still there. */
const renderVersiaShare = async (
    ctx: Context,
    share: NoteRow,
): Promise<v0_6.Share | undefined> => {
    if (share.reblog_of_id === null) return undefined;

    const [author] = await userReferences(ctx, [share.account_id]);
    const shared = (await noteReferenceMap(ctx, [share.reblog_of_id])).get(share.reblog_of_id);
    if (author === undefined || shared === undefined) return undefined;

    return {
        type: typeName,
        id: share.id,
        created_at: share.created_at.toISOString(),
        author,
        shared,
    };
};

/**
 * The other instances a local user's share of a note is sent to: those of their followers, and
 * the one of the note's author, which must be told. Local users' shares are never direct.
 */
const audienceOfShare = async (ctx: Context, accountId: string, noteId: string) => {
    const note = await findNote(ctx, noteId);
    const author = note ? await instancesHosting(ctx, [note.account_id]) : [];

    return [...new Set([...await followerInstances(ctx, accountId), ...author])].toSorted();
};

/** Sends local users' shares, and a Delete when they undo one. */
export const shareDeliveries = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isShareEvent(event)) return;

    const audience = await audienceOfShare(ctx, event.accountId, event.noteId);

    if (event.type === "interactions.shared") {
        const share = await findNote(ctx, event.shareId);
        const entity = share && await renderVersiaShare(ctx, share);
        if (entity) await queueDeliveriesTo(ctx, entity, audience);
        return;
    }

    const entity: v0_6.Delete = {
        type: "Delete",
        created_at: ctx.clock.now().toISOString(),
        author: event.accountId,
        deleted_type: typeName,
        deleted: event.shareId,
    };
    await queueDeliveriesTo(ctx, entity, audience);
};

/**
 * Whether `requester`, another instance, may see a local user's share of `note`: if it may see the
 * share, or the note is its own. Only public and unlisted notes are shared, and edits don't change
 * that, so anyone may see a local note shared.
 */
const maySeeShare = async (ctx: Context, share: NoteRow, note: NoteRow, requester: string) =>
    (note.instance_id !== null && note.instance_id === await findInstanceId(ctx, requester)) ||
    await instanceMaySee(ctx, share, requester);

/**
 * The public and unlisted shares of a local note, oldest first, for an instance that may see it,
 * as references to them: bare ids for local ones, and the host and id for other instances' ones.
 */
const noteShares: CollectionProvider = async (ctx, id, page, requester) => {
    const note = await findNote(ctx, id);
    if (note === undefined || note.instance_id !== null || note.reblog_of_id !== null) {
        return undefined;
    }
    if (!await instanceMaySee(ctx, note, requester)) return undefined;

    const ids = await shareIdsOf(ctx, id, everyone, page.offset, page.limit);
    const references = await noteReferenceMap(ctx, ids);
    return {
        author: note.account_id,
        total: await countSharesOf(ctx, id, everyone),
        items: ids.flatMap((each) => references.get(each) ?? []),
    };
};

/** The collections shares add to Notes. */
export const noteShareCollections: Readonly<Record<string, CollectionProvider>> = {
    "pub.versia:share/Shares": noteShares,
};

/**
 * Whether a share `sender` sent is one Verso wants, from what Verso has: one of a local note, or by
 * someone a local user follows. Others could fill Verso with shares nobody here would see.
 */
const wanted = async (ctx: Context, share: v0_6.Share, sender: Sender) => {
    if (parseReference(share.shared, sender.domain)?.host === ctx.urls.domain) return true;

    const reference = parseReference(share.author, sender.domain);
    const author = reference && await knownUser(ctx, reference);
    return author !== undefined && await hasFollowers(ctx, author.id);
};

/**
 * Shares: other instances' ones, as they send them, and Deletes undo them, and local users' ones,
 * which other instances that may see them fetch. Verso keeps those it wants, with the notes they
 * share, which are fetched for the timelines they are shown in.
 */
export const shareType: EntityType<v0_6.Share> = {
    type: typeName,
    extension,
    schema: v0_6.Share,
    // Only its author's instance may send it.
    authority: (share, origin) => parseReference(share.author, origin)?.host,
    prepare: async (ctx, share, sender, budget) => {
        if (!await wanted(ctx, share, sender)) return;

        // Without them, the share can't be kept, so it is tried again later.
        const author = parseReference(share.author, sender.domain);
        if (author) await ctx.federation.resolve(ctx, author, "User", budget);
        const shared = parseReference(share.shared, sender.domain);
        if (shared) await ctx.federation.resolve(ctx, shared, "Note", budget);
    },
    receive: async (ctx, share, sender) => {
        if (!await wanted(ctx, share, sender)) return;

        const author = parseReference(share.author, sender.domain);
        const user = author && await knownUser(ctx, author);
        if (user === undefined) throw new PermanentFailure(`Verso doesn't have ${share.author}`);

        const shared = parseReference(share.shared, sender.domain);
        const known = shared && await knownNote(ctx, shared);
        const note = known && await findNote(ctx, known.id);
        if (note === undefined) throw new PermanentFailure(`Verso doesn't have ${share.shared}`);
        // As for local users' shares.
        if (!everyone.includes(note.visibility)) {
            throw new PermanentFailure(`${share.shared} can't be shared`);
        }
        if (note.instance_id === null && !await canSee(ctx, note, user.id)) {
            throw new PermanentFailure(`${share.author} may not see ${share.shared}`);
        }

        await keepRemoteShare(ctx, {
            accountId: user.id,
            note,
            instanceId: sender.instanceId,
            remoteId: share.id,
            createdAt: new Date(share.created_at),
        });
    },
    deleteRemote: (ctx, id, sender) => undoRemoteShare(ctx, sender.instanceId, id),
    find: async (ctx, id, requester) => {
        const share = await findNote(ctx, id);
        if (share?.instance_id !== null || share.reblog_of_id === null) return undefined;

        const note = await findNote(ctx, share.reblog_of_id);
        if (note === undefined || !await maySeeShare(ctx, share, note, requester)) {
            return undefined;
        }

        return await renderVersiaShare(ctx, share);
    },
};
