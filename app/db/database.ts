import { Kysely, PostgresDialect } from "kysely";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import type { Config } from "../kernel/config.ts";
import { sqliteDialect } from "./sqlite.ts";

/** Every table, as migrations add them. */
export type Database = Record<never, never>;

/** Opens the configured database. Postgres connects lazily, on the first query. */
export const openDatabase = (config: Config["database"]): Kysely<Database> =>
  new Kysely({
    dialect: "postgres" in config
      ? new PostgresDialect({
        pool: new pg.Pool({ connectionString: config.postgres }),
      })
      : sqliteDialect(new DatabaseSync(config.sqlite)),
  });
