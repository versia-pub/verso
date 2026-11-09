/**
 * Reading reactions as statuses and notifications show them: counted by emoji, with each custom
 * emoji's picture. Its queries read the `emojis`, `instances` and `media` tables directly rather
 * than going through their modules, so that each takes one query.
 * @module
 */
import { countAll, readCount } from "../db/count.ts";
import { setsBy } from "../db/grouping.ts";
import type { Excluded } from "../graph/blocks.ts";
import type { Context } from "../kernel/context.ts";
import type { ReactionRow } from "./reaction_queries.ts";

/** The reactions to a status with one emoji, and the custom emoji's picture, if it is one. */
export type ReactionGroup = {
    readonly note_id: string;
    readonly text: string | null;
    readonly emoji_id: string | null;
    readonly shortcode: string | null;
    readonly category: string | null;
    /**
     * The custom emoji's instance, and its domain, or `null` if it is the local instance's, or
     * Unicode.
     */
    readonly instance_id: string | null;
    readonly domain: string | null;
    readonly url: string | null;
    readonly media_type: string | null;
    readonly sha256: string | null;
    readonly preview_sha256: string | null;
    readonly processed_at: Date | null;
    readonly count: number;
    /** Whether the viewer is among them. */
    readonly me: boolean;
};

/** A status and one of the emojis it was reacted with. */
const emojiKey = (
    row: Pick<ReactionRow, "note_id" | "text" | "emoji_id">,
): string => `${row.note_id} ${row.emoji_id ?? ""} ${row.text ?? ""}`;

/** How many reactions the accounts `by` made to each of `noteIds`, by {@link emojiKey}. */
const reactionsBy = async (
    ctx: Context,
    noteIds: readonly string[],
    by: Excluded,
): Promise<Map<string, number>> => {
    const rows = await ctx.db.selectFrom("reactions")
        .select((eb) => ["note_id", "text", "emoji_id", countAll(eb)])
        .where("note_id", "in", noteIds)
        .where("account_id", "in", by.all)
        .groupBy(["note_id", "text", "emoji_id"])
        .execute();

    return new Map(rows.map((row) => [emojiKey(row), readCount(row)]));
};

/**
 * Which of the reactions to `noteIds` each of `accountIds` made, by account, by {@link emojiKey}.
 */
const reactedAmong = async (
    ctx: Context,
    accountIds: readonly string[],
    noteIds: readonly string[],
): Promise<Map<string, Set<string>>> => {
    if (accountIds.length === 0) return new Map();

    const rows = await ctx.db.selectFrom("reactions")
        .select(["account_id", "note_id", "text", "emoji_id"])
        .where("account_id", "in", accountIds)
        .where("note_id", "in", noteIds)
        .execute();
    return setsBy(rows, (row) => row.account_id, emojiKey);
};

/**
 * The reactions to each of `noteIds`, as each viewer in `viewers` sees them, by viewer, then by
 * status, and by emoji in the order they were first used: with whether the viewer made each, if
 * it isn't `null`, and without those of the accounts it blocks, its value. It reads the `emojis`,
 * `instances` and `media` tables directly rather than going through their modules, so that it
 * takes one query for everyone, one more for the reactions of the viewers, and one for each that
 * blocks some.
 *
 * The blocked accounts' reactions are counted from those accounts and taken away, rather than
 * each reaction's account being looked up among them. An emoji first used by one of them keeps
 * its place.
 */
export const reactionsFor = async (
    ctx: Context,
    noteIds: readonly string[],
    viewers: ReadonlyMap<string | null, Excluded | null>,
): Promise<Map<string | null, Map<string, ReactionGroup[]>>> => {
    if (noteIds.length === 0) return new Map([...viewers.keys()].map((id) => [id, new Map()]));

    const rows = await ctx.db.selectFrom("reactions")
        .leftJoin("emojis", "emojis.id", "reactions.emoji_id")
        .leftJoin("media", "media.id", "emojis.media_id")
        .leftJoin("instances", "instances.id", "emojis.instance_id")
        .select((eb) => [
            "reactions.note_id",
            "reactions.text",
            "reactions.emoji_id",
            "emojis.shortcode",
            "emojis.category",
            "emojis.instance_id",
            "instances.domain",
            "media.url",
            "media.media_type",
            "media.sha256",
            "media.preview_sha256",
            "media.processed_at",
            countAll(eb),
            eb.fn.min("reactions.id").as("first_id"),
        ])
        .where("reactions.note_id", "in", noteIds)
        .groupBy([
            "reactions.note_id",
            "reactions.text",
            "reactions.emoji_id",
            "emojis.shortcode",
            "emojis.category",
            "emojis.instance_id",
            "instances.domain",
            "media.url",
            "media.media_type",
            "media.sha256",
            "media.preview_sha256",
            "media.processed_at",
        ])
        .orderBy("first_id")
        .execute();
    if (rows.length === 0) return new Map([...viewers.keys()].map((id) => [id, new Map()]));

    const signedIn = [...viewers.keys()].filter((id) => id !== null);
    const reacted = await reactedAmong(ctx, signedIn, noteIds);

    const rendered = new Map<string | null, Map<string, ReactionGroup[]>>();
    for (const [viewerId, blocked] of viewers) {
        const uncounted = blocked === null ? new Map() : await reactionsBy(ctx, noteIds, blocked);
        const own = viewerId === null ? undefined : reacted.get(viewerId);

        const groups = new Map<string, ReactionGroup[]>();
        for (const { first_id: _, ...row } of rows) {
            const key = emojiKey(row);
            const count = readCount(row) - (uncounted.get(key) ?? 0);
            if (count === 0) continue;

            const group = { ...row, count, me: own?.has(key) ?? false };
            groups.set(row.note_id, [...groups.get(row.note_id) ?? [], group]);
        }
        rendered.set(viewerId, groups);
    }

    return rendered;
};

/**
 * The reactions to each of `noteIds`, by status, as `viewerId` sees them without those of the
 * accounts it blocks, `blocked`, as {@link reactionsFor} finds them.
 */
export const reactionsOf = async (
    ctx: Context,
    noteIds: readonly string[],
    viewerId: string | null,
    blocked: Excluded | null,
): Promise<Map<string, ReactionGroup[]>> =>
    (await reactionsFor(ctx, noteIds, new Map([[viewerId, blocked]]))).get(viewerId) ?? new Map();

/** A reaction's emoji, and the custom emoji's picture, if it is one. */
export type ReactionWithEmoji = Omit<ReactionGroup, "note_id" | "count" | "me"> & {
    readonly id: string;
};

/**
 * The emojis of the reactions `ids`, by reaction. It reads the `emojis`, `instances` and `media`
 * tables directly rather than going through their modules, so that it takes one query.
 */
export const emojisOfReactions = async (
    ctx: Context,
    ids: readonly string[],
): Promise<Map<string, ReactionWithEmoji>> => {
    if (ids.length === 0) return new Map();

    const rows = await ctx.db.selectFrom("reactions")
        .leftJoin("emojis", "emojis.id", "reactions.emoji_id")
        .leftJoin("media", "media.id", "emojis.media_id")
        .leftJoin("instances", "instances.id", "emojis.instance_id")
        .select([
            "reactions.id",
            "reactions.text",
            "reactions.emoji_id",
            "emojis.shortcode",
            "emojis.category",
            "emojis.instance_id",
            "instances.domain",
            "media.url",
            "media.media_type",
            "media.sha256",
            "media.preview_sha256",
            "media.processed_at",
        ])
        .where("reactions.id", "in", ids)
        .execute();
    return new Map(rows.map((row) => [row.id, row]));
};
