import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The columns this reads and writes. Fields were `{ name, value }`, and gain their format and
 * HTML.
 */
type Tables = {
    accounts: { id: string; note: string; note_html: string; fields: Record<string, string>[] };
};

// A copy of how plain text became HTML when this was written, so later changes don't alter it.
const escapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => escapes[char]);

const textToHtml = (text: string) =>
    text.replace(/\r\n?/g, "\n")
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph !== "")
        .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
        .join("");

/**
 * Keeps bios and profile fields as HTML too, next to the text their owners wrote and what they
 * wrote it in. Everything so far was plain text.
 */
export const accountRichText: Migration = {
    up: async (db: Kysely<unknown>) => {
        // One at a time, since SQLite adds only one column per statement.
        await db.schema.alterTable("accounts")
            .addColumn("note_format", "text", (column) => column.notNull().defaultTo("text/plain"))
            .execute();
        await db.schema.alterTable("accounts")
            .addColumn("note_html", "text", (column) => column.notNull().defaultTo(sql`''`))
            .execute();

        const accounts = db.withTables<Tables>();
        const rows = await accounts.selectFrom("accounts").select(["id", "note", "fields"])
            .execute();

        for (const { id, note, fields } of rows) {
            await accounts.updateTable("accounts")
                .set({
                    note_html: textToHtml(note),
                    fields: fields.map(({ name, value }) => ({
                        name,
                        value,
                        format: "text/plain",
                        name_html: escapeHtml(name),
                        value_html: escapeHtml(value),
                    })),
                })
                .where("id", "=", id)
                .execute();
        }
    },
};
