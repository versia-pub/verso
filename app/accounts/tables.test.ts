import { assertEquals } from "@std/assert";
import type { Generated } from "kysely";
import { migrate } from "../db/migrate.ts";
import { migrations } from "../db/migrations/mod.ts";
import { testDatabase } from "../db/testing.ts";

/** The columns this test uses. Fields are `{ name, value }` before 0012, and gain more after. */
type Tables = {
    accounts: {
        id: string;
        username: string;
        instance_id: string | null;
        remote_id: string | null;
        created_at: Date;
        note: string;
        note_format: Generated<string>;
        note_html: Generated<string>;
        fields: object[];
    };
};

Deno.test("bios and fields written before they had HTML are given it", async () => {
    await using db = await testDatabase<Tables>();
    const before = Object.fromEntries(
        Object.entries(migrations).filter(([name]) => name < "0012"),
    );
    await migrate(db, before);

    await db.insertInto("accounts")
        .values([
            {
                id: "a",
                username: "alice",
                instance_id: null,
                remote_id: null,
                created_at: new Date(),
                note: "Hi & <bye>\n\nagain",
                fields: [{ name: "<Site>", value: "a & b" }],
            },
            {
                id: "b",
                username: "bob",
                instance_id: null,
                remote_id: null,
                created_at: new Date(),
                note: "",
                fields: [],
            },
        ])
        .execute();

    await migrate(db);

    assertEquals(
        await db.selectFrom("accounts")
            .select(["id", "note", "note_format", "note_html", "fields"])
            .orderBy("id")
            .execute(),
        [
            {
                id: "a",
                note: "Hi & <bye>\n\nagain",
                note_format: "text/plain",
                note_html: "<p>Hi &amp; &lt;bye&gt;</p><p>again</p>",
                fields: [{
                    name: "<Site>",
                    value: "a & b",
                    format: "text/plain",
                    name_html: "&lt;Site&gt;",
                    value_html: "a &amp; b",
                }],
            },
            { id: "b", note: "", note_format: "text/plain", note_html: "", fields: [] },
        ],
    );
});
