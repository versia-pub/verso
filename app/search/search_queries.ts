import { sql } from "kysely";
import { usesSqlite } from "../db/columns.ts";
import type { Context } from "../kernel/context.ts";

/**
 * Keeps `words` as the words of `noteId`, replacing those it had. On SQLite, the status's row gives
 * the rowid its words are kept under.
 */
export const indexNote = async (
    ctx: Pick<Context, "db">,
    noteId: string,
    words: readonly string[],
): Promise<void> => {
    const text = words.join(" ");

    if (!usesSqlite(ctx.db)) {
        await sql`
            INSERT INTO note_search (note_id, document) VALUES (${noteId}, to_tsvector('simple', ${text}))
            ON CONFLICT (note_id) DO UPDATE SET document = excluded.document
        `.execute(ctx.db);
        return;
    }

    // Updated in place on a conflict, so that it returns its id either way.
    const { rows: [{ id }] } = await sql<{ id: number }>`
        INSERT INTO note_search (note_id) VALUES (${noteId})
        ON CONFLICT (note_id) DO UPDATE SET note_id = excluded.note_id
        RETURNING id
    `.execute(ctx.db);
    await sql`DELETE FROM note_search_text WHERE rowid = ${id}`.execute(ctx.db);
    await sql`INSERT INTO note_search_text (rowid, text) VALUES (${id}, ${text})`.execute(ctx.db);
};

/** Up to `limit` statuses that aren't indexed yet, other than boosts, which have no words. */
export const unindexedNoteIds = async (
    ctx: Pick<Context, "db">,
    limit: number,
): Promise<string[]> => {
    const rows = await ctx.db.selectFrom("notes")
        .leftJoin("note_search", "note_search.note_id", "notes.id")
        .select("notes.id")
        .where("note_search.note_id", "is", null)
        .where("notes.reblog_of_id", "is", null)
        .limit(limit)
        .execute();

    return rows.map((row) => row.id);
};

/**
 * Up to `limit` statuses, newest first, with words that start with each of `words`. No words find
 * nothing.
 */
export const noteIdsMatching = async (
    ctx: Pick<Context, "db">,
    words: readonly string[],
    limit: number,
): Promise<string[]> => {
    if (words.length === 0) return [];

    const query = usesSqlite(ctx.db)
        ? ctx.db.selectFrom("note_search")
            .where(
                sql<boolean>`id IN (SELECT rowid FROM note_search_text WHERE note_search_text MATCH ${
                    words.map((word) => `"${word}"*`).join(" ")
                })`,
            )
        : ctx.db.selectFrom("note_search")
            .where(
                sql<boolean>`document @@ to_tsquery('simple', ${
                    words.map((word) => `${word}:*`).join(" & ")
                })`,
            );
    const rows = await query.select("note_id").orderBy("note_id", "desc").limit(limit).execute();

    return rows.map((row) => row.note_id);
};
