/**
 * Boosts of statuses (Mastodon calls them reblogs, Versia calls them Shares). A boost is a status
 * with no content of its own, which boosts another status.
 * @see https://versia.pub/extensions/share
 * @module
 */
import { findAccount } from "../accounts/account_queries.ts";
import type { Visibility } from "../accounts/tables.ts";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { everyone } from "../notes/audience.ts";
import { findNote, findRemoteNote, insertNote, type NoteRow } from "../notes/note_queries.ts";
import { deleteShare, findShare } from "../notes/share_queries.ts";
import { countPosted } from "../notes/notes.ts";
import { removeNote } from "../notes/removal.ts";
import { visibleNote, visibleOriginal } from "../notes/visibility.ts";
import type { InteractionReceived, ShareEvent } from "./events.ts";

/** The result of boosting a status: the boost, or why there is none. */
export type ShareResult =
    | NoteRow
    /** There is no such status, or the booster may not see it. */
    | "missing"
    /** Only public and unlisted statuses can be boosted, as on Mastodon. */
    | "unshareable";

/**
 * Boosts a status for `accountId`, a local user, with `visibility`, or without one, their default,
 * and increments the counts. Boosting a boost boosts the status it boosts. A status that is already
 * boosted is boosted once, and its boost is returned as it is.
 */
export const share = (
    ctx: Context,
    accountId: string,
    noteId: string,
    visibility?: Exclude<Visibility, "direct">,
): Promise<ShareResult> =>
    ctx.transaction(async (tx) => {
        const note = await visibleOriginal(tx, noteId, accountId);
        if (note === undefined) return "missing";
        if (!everyone.includes(note.visibility)) return "unshareable";

        const existing = await findShare(tx, accountId, note.id);
        if (existing) return existing;

        const author = await findAccount(tx, accountId);
        if (author === undefined) throw new Error(`Account ${accountId} doesn't exist`);

        const row = await insertNote(
            tx,
            {
                id: tx.ids(),
                account_id: accountId,
                instance_id: null,
                remote_id: null,
                // A boost is for at least the booster's followers.
                visibility: visibility ??
                    (author.default_visibility === "direct"
                        ? "private"
                        : author.default_visibility),
                content: "",
                content_format: "text/plain",
                content_html: "",
                language: null,
                in_reply_to_id: null,
                in_reply_to_account_id: null,
                reblog_of_id: note.id,
                created_at: tx.clock.now(),
                edited_at: null,
            },
            [],
            [],
        );
        await countPosted(tx, row, 1);

        const event: ShareEvent = {
            type: "interactions.shared",
            shareId: row.id,
            accountId,
            noteId: note.id,
            visibility: row.visibility,
        };
        await emit(tx, event);

        return row;
    });

/**
 * Undoes `accountId`'s boost of a status, or of the status a boost boosts, and decrements the
 * counts. Returns the boosted status as it is now, or `undefined` if there is none. As on Mastodon,
 * a boosted status can be unboosted even if the booster may no longer see it, and one that isn't
 * boosted only if they may.
 */
export const unshare = (
    ctx: Context,
    accountId: string,
    noteId: string,
): Promise<NoteRow | undefined> =>
    ctx.transaction(async (tx) => {
        const shared = (await findNote(tx, noteId))?.reblog_of_id ?? noteId;

        const removed = await deleteShare(tx, accountId, shared);
        if (removed === undefined) return await visibleNote(tx, shared, accountId);

        await countPosted(tx, removed, -1);

        const event: ShareEvent = {
            type: "interactions.unshared",
            shareId: removed.id,
            accountId,
            noteId: shared,
            visibility: removed.visibility,
        };
        await emit(tx, event);

        return await findNote(tx, shared);
    });

/** A remote boost of a status, by one of the remote instance's users. */
export type RemoteShare = {
    readonly accountId: string;
    /** A public or unlisted status, not a boost. */
    readonly note: NoteRow;
    readonly instanceId: string;
    readonly remoteId: string;
    readonly createdAt: Date;
};

/**
 * Stores a remote boost, and counts it, replacing the account's other boost of the status if it has
 * one, as an account boosts a status once. Versia doesn't say who a Share is for, so it is for
 * whoever the status is. One Verso already has is left unchanged, and isn't emitted again.
 */
export const keepRemoteShare = async (ctx: Context, share: RemoteShare): Promise<void> => {
    const existing = await findRemoteNote(ctx, share.instanceId, share.remoteId);
    if (existing?.reblog_of_id === null) {
        throw new PermanentFailure(`${share.remoteId} is a Note, not a Share`);
    }
    if (existing) return;

    const replaced = await deleteShare(ctx, share.accountId, share.note.id);
    if (replaced) await countPosted(ctx, replaced, -1);

    const row = await insertNote(
        ctx,
        {
            id: ctx.ids(),
            account_id: share.accountId,
            instance_id: share.instanceId,
            remote_id: share.remoteId,
            visibility: share.note.visibility,
            content: "",
            content_format: "text/plain",
            content_html: "",
            language: null,
            in_reply_to_id: null,
            in_reply_to_account_id: null,
            reblog_of_id: share.note.id,
            created_at: share.createdAt,
            edited_at: null,
            fetched_at: ctx.clock.now(),
        },
        [],
        [],
    );
    await countPosted(ctx, row, 1);

    const event: InteractionReceived = {
        type: "interactions.received",
        kind: "share",
        id: row.id,
        accountId: share.accountId,
        noteId: share.note.id,
    };
    await emit(ctx, event);
};

/** Undoes a remote boost, which a Delete said is gone, if Verso has it. */
export const undoRemoteShare = async (
    ctx: Context,
    instanceId: string,
    remoteId: string,
): Promise<void> => {
    const share = await findRemoteNote(ctx, instanceId, remoteId);
    // A Note is deleted as a Note, not a Share.
    if (share && share.reblog_of_id !== null) await removeNote(ctx, share.id);
};
