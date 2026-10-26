/**
 * Shares as Versia has them: local users' boosts, as remote instances fetch them and are sent them,
 * with the collection of who boosts a status, and remote boosts, as Verso receives them.
 * @see https://versia.pub/extensions/share
 * @module
 */
import { parseReference, v0_6 } from "@versia/protocol";
import { instancesHosting } from "../accounts/account_queries.ts";
import { knownUser, userReferences } from "../accounts/federation.ts";
import { queueDeliveriesTo } from "../federation/deliver.ts";
import type { CollectionProvider, EntityType, Sender } from "../federation/registry.ts";
import { followerInstances, hasFollowers } from "../graph/follows.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { everyone, instanceMaySee, instanceMaySeeInteraction } from "../notes/audience.ts";
import { findNote, type NoteRow } from "../notes/note_queries.ts";
import { countSharesOf, shareIdsOf } from "../notes/share_queries.ts";
import { canSee } from "../notes/visibility.ts";
import { knownNoteRow } from "../notes/remote.ts";
import { noteReferenceMap } from "../notes/versia.ts";
import { isShareEvent } from "./events.ts";
import { keepRemoteShare, undoRemoteShare } from "./shares.ts";
import { deleteEntity } from "../federation/delete.ts";

const extension = "pub.versia:share";

const typeName = "pub.versia:share/Share";

/** A local user's boost as a Versia Share, if its user and the status it boosts still exist. */
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
 * The remote instances a local user's boost of a status is sent to: those of their followers, and
 * the instance of the status's author, which must be told. Local users' boosts are never direct.
 */
const audienceOfShare = async (ctx: Context, accountId: string, noteId: string) => {
    const note = await findNote(ctx, noteId);
    const author = note ? await instancesHosting(ctx, [note.account_id]) : [];

    return [...new Set([...await followerInstances(ctx, accountId), ...author])].toSorted();
};

/** Sends local users' boosts, and a Delete when they undo one. */
export const shareDeliveries = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isShareEvent(event)) return;

    const audience = await audienceOfShare(ctx, event.accountId, event.noteId);

    if (event.type === "interactions.shared") {
        const share = await findNote(ctx, event.shareId);
        const entity = share && await renderVersiaShare(ctx, share);
        if (entity) await queueDeliveriesTo(ctx, entity, audience);
        return;
    }

    const entity = deleteEntity(ctx, event.accountId, typeName, event.shareId);
    await queueDeliveriesTo(ctx, entity, audience);
};

/**
 * Whether `requester`, a remote instance, may see a local user's boost of `note`: if it may see the
 * boost, or the status is its own. Only public and unlisted statuses are boosted, and edits don't
 * change that, so anyone may see a boost of a local status.
 */
const maySeeShare = (ctx: Context, share: NoteRow, note: NoteRow, requester: string) =>
    instanceMaySeeInteraction(ctx, note, share, requester);

/**
 * The public and unlisted boosts of a local status, oldest first, for an instance that may see it,
 * as references to them: bare ids for local ones, and the host and id for remote ones.
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

/** The collections that boosts add to Notes. */
export const noteShareCollections: Readonly<Record<string, CollectionProvider>> = {
    "pub.versia:share/Shares": noteShares,
};

/**
 * Whether a Share sent by `sender` is one Verso wants, judging from what Verso has: a boost of a
 * local status, or by someone a local user follows. Others could fill Verso with boosts nobody
 * local would see.
 */
const wanted = async (ctx: Context, share: v0_6.Share, sender: Sender) => {
    if (parseReference(share.shared, sender.domain)?.host === ctx.urls.domain) return true;

    const reference = parseReference(share.author, sender.domain);
    const author = reference && await knownUser(ctx, reference);
    return author !== undefined && await hasFollowers(ctx, author.id);
};

/**
 * Shares: remote ones, as remote instances send them, and Deletes undo them, and local users' ones,
 * which remote instances that may see them fetch. Verso stores those it wants, with the statuses
 * they boost, which are fetched for the timelines they are shown in.
 */
export const shareType: EntityType<v0_6.Share> = {
    type: typeName,
    extension,
    schema: v0_6.Share,
    // Only its author's instance may send it.
    authority: (share, origin) => parseReference(share.author, origin)?.host,
    prepare: async (ctx, share, sender, budget) => {
        if (!await wanted(ctx, share, sender)) return;

        // Without them, the boost can't be stored, so it is retried later.
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

        const note = await knownNoteRow(ctx, parseReference(share.shared, sender.domain));
        if (note === undefined) throw new PermanentFailure(`Verso doesn't have ${share.shared}`);
        // As for local users' boosts.
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
