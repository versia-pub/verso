import { type Kysely, sql } from "kysely";
import { type Migration, Migrator } from "kysely/migration";
import { usesSqlite } from "./columns.ts";
import { migrations as all } from "./migrations/mod.ts";

export type MigrateResult =
    | { readonly ok: true; readonly applied: string[] }
    | { readonly ok: false; readonly error: unknown };

/**
 * Brings the database up to date. Migrations only go forward and run in name order. All the pending
 * ones run in one transaction, so if one fails, none are applied. Running it again with nothing new
 * to apply does nothing.
 *
 * SQLite changes most things about a table by rebuilding it, and dropping the old table runs the
 * `ON DELETE` actions of foreign keys that reference it, deleting their rows. So foreign keys are
 * off while migrating there, and a migration that rebuilds a table calls `checkForeignKeys`.
 */
export const migrate = async <DB>(
    db: Kysely<DB>,
    migrations: Record<string, Migration> = all,
): Promise<MigrateResult> => {
    const migrator = new Migrator({
        db,
        provider: { getMigrations: () => Promise.resolve(migrations) },
    });

    const sqlite = usesSqlite(db);
    const { rows: [before] } = sqlite
        ? await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(db)
        : { rows: [] };

    if (before?.foreign_keys) await sql`PRAGMA foreign_keys = OFF`.execute(db);

    const { error, results = [] } = await migrator.migrateToLatest()
        .finally(async () => {
            if (before?.foreign_keys) await sql`PRAGMA foreign_keys = ON`.execute(db);
        });

    return error === undefined
        ? { ok: true, applied: results.map((result) => result.migrationName) }
        : { ok: false, error };
};

/** When the database was set up: when its first migration ran. */
export const firstMigratedAt = async <DB>(
    db: Kysely<DB>,
    migrations: Record<string, Migration> = all,
): Promise<Date> => {
    const migrator = new Migrator({
        db,
        provider: { getMigrations: () => Promise.resolve(migrations) },
    });
    const times = (await migrator.getMigrations())
        .flatMap((migration) => migration.executedAt ? [migration.executedAt.getTime()] : []);

    if (times.length === 0) throw new Error("The database isn't set up. Run `verso migrate`.");

    return new Date(Math.min(...times));
};
