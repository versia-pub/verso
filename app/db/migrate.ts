import type { Kysely } from "kysely";
import { type Migration, Migrator } from "kysely/migration";
import { migrations as all } from "./migrations/mod.ts";

export type MigrateResult =
  | { readonly ok: true; readonly applied: string[] }
  | { readonly ok: false; readonly error: unknown };

/**
 * Brings the database up to date. Migrations only go forward and run in name order. All the
 * pending ones run in one transaction, so if one fails, none are applied. Running it again with
 * nothing new to apply does nothing.
 */
export const migrate = async <DB>(
  db: Kysely<DB>,
  migrations: Record<string, Migration> = all,
): Promise<MigrateResult> => {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  });
  const { error, results = [] } = await migrator.migrateToLatest();
  return error === undefined
    ? { ok: true, applied: results.map((result) => result.migrationName) }
    : { ok: false, error };
};
