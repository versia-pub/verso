import { type Dialect, Kysely, PostgresDialect } from "kysely";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import type { AccountsTable, IdentitiesTable } from "../accounts/tables.ts";
import type { AccessTokensTable, AppsTable, OAuthFlowsTable } from "../auth/tables.ts";
import type { JobsTable } from "../jobs/tables.ts";
import type { Config } from "../kernel/config.ts";
import { jsonValues } from "./json_values.ts";
import { sqliteDialect } from "./sqlite.ts";

/** Every table, as migrations add them. */
export type Database = {
    access_tokens: AccessTokensTable;
    accounts: AccountsTable;
    apps: AppsTable;
    identities: IdentitiesTable;
    jobs: JobsTable;
    oauth_flows: OAuthFlowsTable;
};

/** Kysely on any of the dialects, set up the same way. Tests use it to open PGlite. */
export const connect = <DB = Database>(dialect: Dialect): Kysely<DB> =>
    new Kysely({ dialect, plugins: [jsonValues] });

/** Opens the configured database. Postgres connects lazily, on the first query. */
export const openDatabase = (config: Config["database"]): Kysely<Database> =>
    connect(
        "postgres" in config
            ? new PostgresDialect({
                pool: new pg.Pool({ connectionString: config.postgres }),
            })
            : sqliteDialect(new DatabaseSync(config.sqlite)),
    );
