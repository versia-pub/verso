/**
 * `verso admin backup`.
 * @module
 */
import { backup, DatabaseSync } from "node:sqlite";
import type { Config } from "../kernel/config.ts";
import { AdminError } from "./admin_io.ts";

/**
 * Copies the SQLite database to `path`, a file that doesn't exist yet, as it is at one moment, while
 * Verso keeps running: it copies every page in one step, reading as one transaction does, which in
 * WAL mode doesn't hold up Verso's writes. Returns the copy's size in bytes.
 * @see https://www.sqlite.org/backup.html
 */
export const backUpSqlite = async (database: Config["database"], path: string): Promise<number> => {
    if (!("sqlite" in database)) {
        throw new AdminError("Verso runs on PostgreSQL: back its database up with pg_dump");
    }
    if (await exists(path)) throw new AdminError(`${path} already exists`);

    using source = new DatabaseSync(database.sqlite, { readOnly: true });
    await backup(source, path, { rate: -1 });

    return (await Deno.stat(path)).size;
};

/** Whether there is a file at `path`. */
const exists = async (path: string) => {
    try {
        await Deno.lstat(path);
        return true;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
    }
};
