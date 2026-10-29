/**
 * Searching statuses. Search is a read model: besides the index, its queries read the tables of the
 * statuses, accounts, likes and mentions they search, and use other modules' query helpers where
 * there are some, so that a search takes one query.
 * @module
 */
import { type ExpressionBuilder, sql, type SqlBool } from "kysely";
import type { Database } from "../db/database.ts";
import { type Excluded, notExcluded } from "../graph/excluded_queries.ts";
import { hasAttachments } from "../media/attachment_queries.ts";
import type { Context } from "../kernel/context.ts";
import { isSeenBy, type Onlooker } from "../notes/thread_queries.ts";
import { usesAny } from "../notes/timeline_queries.ts";
import { matching, noteIndex } from "./index_queries.ts";

/**
 * What a status must have to be found, or with `negated`, mustn't: words that start with each of
 * `values`, those words one after another as a phrase, or a hashtag, named by its one value; an
 * author, if there is one by the name the query gave; a property Mastodon searches; a language; or
 * a time it was created at or after `since`, and before `until`.
 */
export type NoteTerm =
    & { readonly negated: boolean }
    & (
        | { readonly kind: "words" | "phrase" | "hashtag"; readonly values: readonly string[] }
        | { readonly kind: "author"; readonly accountId: string | null }
        | { readonly kind: "property"; readonly property: string }
        | { readonly kind: "language"; readonly language: string }
        | { readonly kind: "created"; readonly since: Date | null; readonly until: Date | null }
    );

/** Matches nothing, for what no status has. */
const never = sql<SqlBool>`1 = 0`;

/**
 * Whether a status has `property`, as Mastodon's search names them. Verso's media are images, and
 * it has no polls or link previews, so a status never has the others.
 * @see https://github.com/mastodon/mastodon/blob/main/app/models/concerns/status/search_concern.rb
 */
const hasProperty = (property: string) => (eb: ExpressionBuilder<Database, "notes">) => {
    if (property === "media" || property === "image") return hasAttachments(eb);
    if (property === "sensitive") return eb("notes.sensitive", "=", true);
    if (property === "reply") return eb("notes.in_reply_to_id", "is not", null);
    return never;
};

/**
 * Whether a status has what `term` says, not counting whether it is negated. It is never unknown,
 * so that negating it finds the statuses without it.
 */
const has = (ctx: Context, term: NoteTerm) => (eb: ExpressionBuilder<Database, "notes">) => {
    switch (term.kind) {
        case "words":
        case "phrase":
            return matching(ctx, noteIndex, "notes.id", term.values, term.kind === "phrase");
        case "hashtag":
            return usesAny(term.values)(eb);
        case "author":
            return term.accountId === null ? never : eb("notes.account_id", "=", term.accountId);
        case "property":
            return hasProperty(term.property)(eb);
        case "language":
            return eb.and([
                eb("notes.language", "is not", null),
                eb("notes.language", "=", term.language),
            ]);
        case "created":
            return eb.and([
                ...term.since === null ? [] : [eb("notes.created_at", ">=", term.since)],
                ...term.until === null ? [] : [eb("notes.created_at", "<", term.until)],
            ]);
    }
};

/**
 * Which of the statuses Mastodon searches to search: those whose authors chose to be found, those
 * the viewer took part in, which Mastodon calls their library, or all of them.
 */
export type NoteScope = "public" | "library" | "all";

/** Whether a status is public, by an author who chose to be found. */
const findable = (eb: ExpressionBuilder<Database, "notes" >) =>
    eb.and([
        eb("notes.visibility", "=", "public"),
        eb.exists(
            eb.selectFrom("accounts").select("accounts.id")
                .whereRef("accounts.id", "=", "notes.account_id")
                .where("accounts.indexable", "=", true),
        ),
    ]);

/**
 * Whether `viewerId` wrote a status, was mentioned in it, liked it or boosted it. Each is looked up
 * by the viewer, through its index, so the statuses in their library are found without passing
 * every other.
 */
const inLibraryOf = (viewerId: string) => (eb: ExpressionBuilder<Database, "notes">) =>
    eb(
        "notes.id",
        "in",
        (eb) =>
            eb.selectFrom("notes as own").select("own.id").where("own.account_id", "=", viewerId)
                .union(
                    eb.selectFrom("note_mentions").select("note_mentions.note_id as id")
                        .where("note_mentions.account_id", "=", viewerId),
                )
                // Local users, who alone search, never dislike statuses.
                .union(
                    eb.selectFrom("likes").select("likes.note_id as id")
                        .where("likes.account_id", "=", viewerId),
                )
                .union(
                    eb.selectFrom("notes as shares").select("shares.reblog_of_id as id")
                        .where("shares.account_id", "=", viewerId)
                        .where("shares.reblog_of_id", "is not", null)
                        .$narrowType<{ id: string }>(),
                ),
    );

/** What statuses to find, besides their words. */
export type NoteMatch = {
    /** Who is searching. */
    readonly onlooker: Exclude<Onlooker, null>;
    /** The accounts the viewer blocks or mutes. */
    readonly hidden: Excluded;
    /** Which statuses to search, if the query says. */
    readonly scope: NoteScope | null;
    /** The author to find statuses of, if only one's. */
    readonly accountId: string | null;
    /** The id statuses must be newer than, if any. */
    readonly minId: string | null;
    /** The id statuses must be older than, if any. */
    readonly maxId: string | null;
    readonly limit: number;
    readonly offset: number;
};

/**
 * Statuses, newest first, with what each of `terms` says, of those Mastodon searches in `scope`:
 * public statuses whose authors are `indexable`, and those the viewer wrote, was mentioned in,
 * liked or boosted. Of those, only the ones the viewer may see, by authors they don't block or
 * mute, are found, and never boosts.
 *
 * Only what an index narrows down is searched: statuses with a word, phrase or hashtag, by an
 * author, or in the viewer's library. Anything else, such as `is:sensitive` alone, finds nothing,
 * rather than passing every status.
 * @see https://github.com/mastodon/mastodon/blob/main/app/services/statuses_search_service.rb
 */
export const noteIdsMatching = async (
    ctx: Context,
    terms: readonly NoteTerm[],
    match: NoteMatch,
): Promise<string[]> => {
    const viewerId = match.onlooker.id;
    const narrowed = match.scope === "library" || match.accountId !== null ||
        terms.some((term) =>
            !term.negated && (term.kind === "words" || term.kind === "phrase" ||
                term.kind === "hashtag" || term.kind === "author")
        );
    if (!narrowed) return [];

    let query = ctx.db.selectFrom("notes")
        .select("notes.id")
        // Boosts aren't statuses of their own to find, as on Mastodon.
        .where("notes.reblog_of_id", "is", null)
        .where((eb) =>
            eb.and(
                terms.map((term) => term.negated ? eb.not(has(ctx, term)(eb)) : has(ctx, term)(eb)),
            )
        )
        .where((eb) => {
            if (match.scope === "public") return findable(eb);
            if (match.scope === "library") return inLibraryOf(viewerId)(eb);
            return eb.or([findable(eb), inLibraryOf(viewerId)(eb)]);
        })
        .where(isSeenBy(ctx, match.onlooker, "notes.id"))
        .where(notExcluded(match.hidden, "notes.account_id"));
    if (match.accountId !== null) query = query.where("notes.account_id", "=", match.accountId);
    if (match.minId !== null) query = query.where("notes.id", ">", match.minId);
    if (match.maxId !== null) query = query.where("notes.id", "<", match.maxId);

    const rows = await query
        .orderBy("notes.id", "desc")
        .limit(match.limit)
        .offset(match.offset)
        .execute();

    return rows.map((row) => row.id);
};
