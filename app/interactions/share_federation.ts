/**
 * Shares as Versia has them: local users' shares, as other instances fetch them and are sent them,
 * with the collection of who shares a note.
 * @see https://versia.pub/extensions/share
 * @module
 */
import { parseReference, v0_6 } from "@versia/protocol";
import { instancesHosting } from "../accounts/account_queries.ts";
import { userReferences } from "../accounts/federation.ts";
import { queueDeliveriesTo } from "../federation/deliver.ts";
import type { CollectionProvider, EntityType } from "../federation/registry.ts";
import { followerInstances } from "../graph/follows.ts";
import { findInstanceId } from "../instances/instances.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { everyone, instanceMaySee } from "../notes/audience.ts";
import { countSharesOf, findNote, type NoteRow, shareIdsOf } from "../notes/note_queries.ts";
import { noteReferenceMap } from "../notes/versia.ts";
import { isShareEvent } from "./events.ts";

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

/** Local users' shares, which other instances that may see them fetch. */
export const shareType: EntityType<v0_6.Share> = {
    type: typeName,
    extension,
    schema: v0_6.Share,
    // Only its author's instance may send it.
    authority: (share, origin) => parseReference(share.author, origin)?.host,
    receive: () => {
        throw new PermanentFailure("Verso doesn't take in other instances' shares yet");
    },
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
