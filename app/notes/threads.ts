/**
 * Threads: the notes a note replies to, and the replies under it, as far as Verso has them.
 * @module
 */
import { followedIds } from "../graph/follows.ts";
import type { Context } from "../kernel/context.ts";
import { findNote, type NoteRow, notesSeenBy, type Onlooker, repliesTo } from "./note_queries.ts";

/** How many notes up a thread are looked at, as Mastodon shows to anyone. */
const ancestorsLimit = 40;

/** How many replies under a note are looked at, as Mastodon shows to anyone. */
const descendantsLimit = 60;

/** The notes `note` replies to, and the ones they reply to, oldest first. */
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
 * How many replies under a note are looked through, seen or not, so replies nobody may see can't
 * hide the rest, or make Verso look through a thread without end.
 */
const lookedThroughLimit = 4 * descendantsLimit;

/**
 * The replies to `note`, and to them, that `onlooker` may see, in thread order: each reply followed
 * by the replies under it, oldest first. Those nearest `note` are found first, so a long thread
 * loses its deepest replies. Replies under one they may not see are shown too, as on Mastodon.
 */
const descendantsOf = async (ctx: Context, note: NoteRow, onlooker: Onlooker) => {
    const children = new Map<string, NoteRow[]>();
    const shown = new Set<string>();

    let level = [note.id];
    let looked = 0;
    // Stops once there are enough, rather than asking for none.
    while (level.length > 0 && shown.size < descendantsLimit && looked < lookedThroughLimit) {
        const replies = await repliesTo(ctx, level, onlooker, lookedThroughLimit - looked);
        for (const { note: reply, seen } of replies) {
            const parentId = reply.in_reply_to_id ?? "";
            children.set(parentId, [...children.get(parentId) ?? [], reply]);
            if (seen && shown.size < descendantsLimit) shown.add(reply.id);
        }

        looked += replies.length;
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
 * The thread around `note`, as `viewerId` sees it, or anyone if it is `null`: the notes it replies
 * to, oldest first, and the replies under it, in thread order, leaving out those they may not see.
 */
export const threadOf = async (
    ctx: Context,
    note: NoteRow,
    viewerId: string | null,
): Promise<{ ancestors: NoteRow[]; descendants: NoteRow[] }> => {
    const onlooker = viewerId === null
        ? null
        : { id: viewerId, followed: followedIds(ctx, viewerId) };

    const ancestors = await ancestorsOf(ctx, note);
    const seen = await notesSeenBy(ctx, ancestors.map((each) => each.id), onlooker);

    return {
        ancestors: ancestors.filter((each) => seen.has(each.id)),
        descendants: await descendantsOf(ctx, note, onlooker),
    };
};
