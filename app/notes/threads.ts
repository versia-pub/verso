/**
 * Threads: the statuses that a status replies to, and the replies under it, as far as Verso has
 * them.
 * @module
 */
import { hiddenAmong } from "../graph/hidden.ts";
import type { Context } from "../kernel/context.ts";
import { findNote, type NoteRow } from "./note_queries.ts";
import { notesSeenBy, type Onlooker, repliesTo } from "./thread_queries.ts";
import { onlookerOf } from "./visibility.ts";

/** How many statuses up a thread are examined, as Mastodon shows to anyone. */
const ancestorsLimit = 40;

/** How many replies under a status are examined, as Mastodon shows to anyone. */
const descendantsLimit = 60;

/** The statuses `note` replies to, and the ones they reply to, oldest first. */
const ancestorsOf = async (ctx: Context, note: NoteRow) => {
    const ancestors = [];

    let parentId = note.in_reply_to_id;
    while (parentId !== null && ancestors.length < ancestorsLimit) {
        const parent = await findNote(ctx, parentId);
        if (parent === undefined) break;

        ancestors.push(parent);
        parentId = parent.in_reply_to_id;
    }

    return ancestors.toReversed();
};

/**
 * How many replies under a status are examined, whether visible or not, so that replies nobody may
 * see can't hide the rest, or make Verso traverse a thread without end.
 */
const lookedThroughLimit = 4 * descendantsLimit;

/** Which of `notes` are by accounts that `onlooker` blocks or mutes. */
const hiddenOf = async (ctx: Context, notes: readonly NoteRow[], onlooker: Onlooker) => {
    if (onlooker === null) return new Set<string>();

    const hidden = await hiddenAmong(ctx, onlooker.id, notes.map((each) => each.account_id));
    return new Set(notes.filter((each) => hidden.has(each.account_id)).map((each) => each.id));
};

/**
 * The replies to `note`, and their replies, that `onlooker` may see, in thread order: each reply
 * followed by the replies under it, oldest first. Those nearest `note` are found first, so a long
 * thread loses its deepest replies. Replies under a reply the viewer may not see are shown too, as
 * on Mastodon, but not those under a reply by an account they block or mute, which are omitted
 * along with it.
 */
const descendantsOf = async (ctx: Context, note: NoteRow, onlooker: Onlooker) => {
    const children = new Map<string, NoteRow[]>();
    const shown = new Set<string>();

    let level = [note.id];
    let looked = 0;
    // Stops once there are enough, rather than requesting none.
    while (level.length > 0 && shown.size < descendantsLimit && looked < lookedThroughLimit) {
        const found = await repliesTo(ctx, level, onlooker, lookedThroughLimit - looked);
        const hidden = await hiddenOf(ctx, found.map((each) => each.note), onlooker);
        const replies = found.filter((each) => !hidden.has(each.note.id));
        for (const { note: reply, seen } of replies) {
            const parentId = reply.in_reply_to_id ?? "";
            children.set(parentId, [...children.get(parentId) ?? [], reply]);
            if (seen && shown.size < descendantsLimit) shown.add(reply.id);
        }

        looked += found.length;
        level = replies.map((reply) => reply.note.id);
    }

    const ordered: NoteRow[] = [];
    const visit = (id: string) => {
        for (const reply of children.get(id) ?? []) {
            if (shown.has(reply.id)) ordered.push(reply);
            visit(reply.id);
        }
    };
    visit(note.id);

    return ordered;
};

/**
 * The thread around `note`, as `viewerId` sees it, or as anyone sees it if it is `null`: the
 * statuses it replies to, oldest first, and the replies under it, in thread order, omitting those
 * they may not see and those by the accounts they block or mute.
 */
export const threadOf = async (
    ctx: Context,
    note: NoteRow,
    viewerId: string | null,
): Promise<{ ancestors: NoteRow[]; descendants: NoteRow[] }> => {
    const onlooker = onlookerOf(ctx, viewerId);

    const ancestors = await ancestorsOf(ctx, note);
    const seen = await notesSeenBy(ctx, ancestors.map((each) => each.id), onlooker);
    const hidden = await hiddenOf(ctx, ancestors, onlooker);

    return {
        ancestors: ancestors.filter((each) => seen.has(each.id) && !hidden.has(each.id)),
        descendants: await descendantsOf(ctx, note, onlooker),
    };
};
