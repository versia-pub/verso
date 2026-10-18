import { type Dialect, Kysely, PostgresDialect } from "kysely";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import type {
    AccountRolesTable,
    AccountsTable,
    IdentitiesTable,
    RolesTable,
} from "../accounts/tables.ts";
import type { AccessTokensTable, AppsTable, OAuthFlowsTable } from "../auth/tables.ts";
import type { RateLimitsTable } from "../http/tables.ts";
import type { InstanceKeysTable, InstancesTable } from "../instances/tables.ts";
import type { JobsTable } from "../jobs/tables.ts";
import type { MediaTable } from "../media/tables.ts";
import type { DomainBlocksTable } from "../moderation/tables.ts";
import type { Config } from "../kernel/config.ts";
import { jsonValues } from "./json_values.ts";
import { sqliteDialect } from "./sqlite.ts";

/** Every table, as migrations add them. */
export type Database = {
    access_tokens: AccessTokensTable;
    account_roles: AccountRolesTable;
    accounts: AccountsTable;
    apps: AppsTable;
    domain_blocks: DomainBlocksTable;
    identities: IdentitiesTable;
    instance_keys: InstanceKeysTable;
    instances: InstancesTable;
    jobs: JobsTable;
    media: MediaTable;
    oauth_flows: OAuthFlowsTable;
    rate_limits: RateLimitsTable;
    roles: RolesTable;
};

/** Kysely on any of the dialects, set up the same way. Tests use it to open PGlite. */
export const connect = <DB = Database>(dialect: Dialect): Kysely<DB> =>
    new Kysely({ dialect, plugins: [jsonValues] });

/**
 * Opens a SQLite file so `verso serve` and `verso work` can share it: in WAL mode, readers don't
 * wait for a writer, and a writer waits up to five seconds for another instead of failing at once.
 */
const openSqlite = (path: string) => {
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA busy_timeout = 5000");
    return database;
};

/** Opens the configured database. Postgres connects lazily, on the first query. */
export const openDatabase = (config: Config["database"]): Kysely<Database> =>
    connect(
        "postgres" in config
            ? new PostgresDialect({
                pool: new pg.Pool({ connectionString: config.postgres }),
            })
            : sqliteDialect(openSqlite(config.sqlite)),
    );
