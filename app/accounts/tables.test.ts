import { assertEquals, assertRejects } from "@std/assert";
import type { Generated } from "kysely";
import { migrate } from "../db/migrate.ts";
import { migrations } from "../db/migrations/mod.ts";
import { testDatabase } from "../db/testing.ts";
import type { Context } from "../kernel/context.ts";
import { createTestContext } from "../kernel/testing.ts";
import { createLocalAccount } from "./testing.ts";

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

const createRole = async (ctx: Context, id: string, name: string) => {
    await ctx.db.insertInto("roles")
        .values({ id, name, permissions: ["roles"], created_at: ctx.clock.now() })
        .execute();
};

const assign = async (ctx: Context, roleId: string, issuer: string | null) => {
    await ctx.db.insertInto("account_roles")
        .values({ account_id: "alice", role_id: roleId, issuer, created_at: ctx.clock.now() })
        .execute();
};

Deno.test("roles keep their permissions, and their names are unique ignoring case", async () => {
    await using test = await createTestContext();
    await createRole(test.ctx, "r", "Admin");

    assertEquals(
        await test.ctx.db.selectFrom("roles")
            .select(["name", "description", "permissions", "priority", "visible", "color", "icon"])
            .execute(),
        [{
            name: "Admin",
            description: "",
            permissions: ["roles"],
            priority: 0,
            visible: false,
            color: "",
            icon: null,
        }],
    );
    await assertRejects(() => createRole(test.ctx, "s", "admin"));
});

Deno.test("an admin and each issuer give a role to an account once", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createRole(test.ctx, "r", "Admin");

    await assign(test.ctx, "r", null);
    await assign(test.ctx, "r", "https://id.example");
    await assign(test.ctx, "r", "https://id.partner.example");

    await assertRejects(() => assign(test.ctx, "r", null));
    await assertRejects(() => assign(test.ctx, "r", "https://id.example"));
    await assertRejects(() => assign(test.ctx, "missing", null));
});

Deno.test("deleting a role or an account takes its assignments with it", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createRole(test.ctx, "r", "Admin");
    await createRole(test.ctx, "s", "Moderator");
    await assign(test.ctx, "r", null);
    await assign(test.ctx, "s", null);
    const assignments = () => test.ctx.db.selectFrom("account_roles").select("role_id").execute();

    await test.ctx.db.deleteFrom("roles").where("id", "=", "r").execute();
    assertEquals(await assignments(), [{ role_id: "s" }]);

    await test.ctx.db.deleteFrom("accounts").execute();
    assertEquals(await assignments(), []);
});
