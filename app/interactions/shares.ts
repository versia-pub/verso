/**
 * Shares of notes, which Mastodon calls reblogs. A share is a note that says nothing itself, and
 * shares another.
 * @see https://versia.pub/extensions/share
 * @module
 */
import { findAccount } from "../accounts/account_queries.ts";
import type { Visibility } from "../accounts/tables.ts";
import type { Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { everyone } from "../notes/audience.ts";
import {
    deleteShare,
    findNote,
    findShare,
    insertNote,
    type NoteRow,
} from "../notes/note_queries.ts";
import { countPosted, visibleNote, visibleOriginal } from "../notes/notes.ts";
import type { ShareEvent } from "./events.ts";

/** What became of sharing a note: the share, or why there is none. */
export type ShareResult =
    | NoteRow
    /** There is no such note, or the sharer may not see it. */
    | "missing"
    /** Only public and unlisted notes can be shared, as on Mastodon. */
    | "unshareable";

/**
 * Shares a note for `accountId`, a local user, with `visibility`, or without one, their default,
 * and counts it. Sharing a share shares what it shares. A note shared already is shared once, and
 * its share returned as it is.
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
                // A share is for at least the sharer's followers.
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
        };
        await emit(tx, event);

        return row;
    });

/**
 * Undoes `accountId`'s share of a note, or of what a share shares, and uncounts it. Returns the
 * note shared as it is now, or `undefined` if there is none. As on Mastodon, a note shared can be
 * unshared even if the sharer may no longer see it, and one not shared only if they may.
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
        };
        await emit(tx, event);

        return await findNote(tx, shared);
    });
