/**
 * Threads: the notes a note replies to, and the replies under it, as far as Verso has them.
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { findNote, type NoteRow, repliesTo } from "./note_queries.ts";
import { canSee } from "./notes.ts";

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
 * The replies to `note`, and to them, in thread order: each reply followed by the replies under it,
 * oldest first. Those nearest `note` are found first, so a long thread loses its deepest replies.
 */
const descendantsOf = async (ctx: Context, note: NoteRow) => {
    const children = new Map<string, NoteRow[]>();

    let level = [note.id];
    let found = 0;
    // Stops once there are enough, rather than asking for none.
    while (level.length > 0 && found < descendantsLimit) {
        const replies = await repliesTo(ctx, level, descendantsLimit - found);
        for (const reply of replies) {
            const parentId = reply.in_reply_to_id ?? "";
            children.set(parentId, [...children.get(parentId) ?? [], reply]);
        }

        found += replies.length;
        level = replies.map((reply) => reply.id);
    }

    const ordered: NoteRow[] = [];
    const visit = (id: string) => {
        for (const reply of children.get(id) ?? []) {
            ordered.push(reply);
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
    const visible = async (notes: readonly NoteRow[]) => {
        const shown = [];
        for (const each of notes) if (await canSee(ctx, each, viewerId)) shown.push(each);
        return shown;
    };

    return {
        ancestors: await visible(await ancestorsOf(ctx, note)),
        descendants: await visible(await descendantsOf(ctx, note)),
    };
};
