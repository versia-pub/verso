import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { idGenerator } from "../../kernel/ids.ts";
import { systemClock } from "../../kernel/clock.ts";
import { columnTypes } from "../columns.ts";

/**
 * Domain blocks get ids, for Mastodon's admin API, and a private comment and an `obfuscate` flag.
 * Each existing block's id is generated at its `created_at`, so ids sort as the blocks were made.
 * The table is rebuilt, since SQLite can't add a column that is not null without a default.
 */
export const domainBlockIds: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);
        const ids = idGenerator(systemClock);

        await db.schema.createTable("domain_blocks_new")
            .addColumn("id", "text", (column) => column.primaryKey())
            .addColumn("domain", "text", (column) => column.notNull().unique())
            .addColumn("reason", "text", (column) => column.notNull())
            .addColumn("private_comment", "text")
            .addColumn("obfuscate", "boolean", (column) => column.notNull().defaultTo(false))
            .addColumn("created_at", types.timestamp, (column) => column.notNull())
            .execute();

        const { rows } = await sql<{ domain: string; reason: string; created_at: Date | string }>`
            select domain, reason, created_at from domain_blocks`.execute(db);
        for (const row of rows) {
            const createdAt = new Date(row.created_at);
            await sql`insert into domain_blocks_new (id, domain, reason, created_at)
                values (${ids(createdAt)}, ${row.domain}, ${row.reason}, ${row.created_at})`
                .execute(db);
        }

        await db.schema.dropTable("domain_blocks").execute();
        await db.schema.alterTable("domain_blocks_new").renameTo("domain_blocks").execute();
    },
};
