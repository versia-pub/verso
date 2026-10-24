import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { columnTypes } from "../columns.ts";

/**
 * Files uploaded here: who uploaded them, what was uploaded and when it was processed, and the
 * preview, placeholder and focus point of pictures. Indexes are by each column a file's key can be
 * in, so finding whether a file is still used doesn't read every row.
 */
export const uploads: Migration = {
    up: async (db: Kysely<unknown>) => {
        const types = columnTypes(db);

        const columns = [
            db.schema.alterTable("media").addColumn(
                "account_id",
                "text",
                (column) => column.references("accounts.id").onDelete("cascade"),
            ),
            db.schema.alterTable("media").addColumn("upload_sha256", "text"),
            db.schema.alterTable("media").addColumn("processed_at", types.timestamp),
            db.schema.alterTable("media").addColumn("preview_sha256", "text"),
            db.schema.alterTable("media").addColumn("preview_width", "integer"),
            db.schema.alterTable("media").addColumn("preview_height", "integer"),
            db.schema.alterTable("media").addColumn("blurhash", "text"),
            db.schema.alterTable("media").addColumn("focus_x", "real"),
            db.schema.alterTable("media").addColumn("focus_y", "real"),
        ];
        // SQLite adds one column at a time.
        for (const column of columns) await column.execute();

        for (const column of ["account_id", "sha256", "upload_sha256", "preview_sha256"]) {
            await db.schema.createIndex(`media_by_${column}`).on("media").column(column).execute();
        }
    },
};
