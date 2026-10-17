import { assertEquals, assertExists } from "@std/assert";
import { Account, CredentialAccount } from "@versia/client-api";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import { createTestContext } from "../testing/context.ts";
import { findAccount } from "./accounts.ts";
import { renderAccount, renderCredentialAccount } from "./render.ts";
import type { RoleRow } from "./roles.ts";
import type { ProfileField } from "./tables.ts";
import { createLocalAccount } from "./testing.ts";

const find = async (ctx: Context, id: string) => {
    const row = await findAccount(ctx, id);
    assertExists(row);
    return row;
};

Deno.test("a local account links to itself on this instance", async () => {
    await using test = await createTestContext();
    const id = await createLocalAccount(test.ctx, "alice");
    await test.ctx.db.updateTable("accounts")
        .set({ created_at: new Date("2026-01-31T15:04:05Z") })
        .execute();

    const account = Account.parse(renderAccount(test.ctx, await find(test.ctx, id), []));

    assertEquals(account.acct, "alice");
    assertEquals(account.url, null);
    assertEquals(account.uri, "https://social.example/.versia/v0.6/entities/User/alice");
    assertEquals(account.avatar, "https://social.example/accounts/alice/avatar.png");
    assertEquals(account.header_static, "https://social.example/accounts/alice/header.png");
    assertEquals(account.created_at, "2026-01-31T00:00:00.000Z");
    assertEquals(account.last_status_at, null);
    assertEquals(account.roles, []);
});

Deno.test("a remote account links to its own instance", async () => {
    await using test = await createTestContext();
    const instance = await createInstance(test.ctx, "b.example");
    await test.ctx.db.insertInto("accounts")
        .values({
            id: "r",
            username: "bob",
            instance_id: instance,
            remote_id: "a/b",
            created_at: test.ctx.clock.now(),
            last_status_at: new Date("2026-02-01T23:59:00Z"),
        })
        .execute();

    const account = Account.parse(renderAccount(test.ctx, await find(test.ctx, "r"), []));

    assertEquals(account.acct, "bob@b.example");
    assertEquals(account.url, null);
    assertEquals(account.uri, "https://b.example/.versia/v0.6/entities/User/a%2Fb");
    assertEquals(account.avatar, "https://social.example/accounts/r/avatar.png");
    assertEquals(account.last_status_at, "2026-02-01");
    assertEquals(account.roles, null);
});

Deno.test("others see the bio and fields as HTML, and their owner as written", async () => {
    await using test = await createTestContext();
    const id = await createLocalAccount(test.ctx, "alice");
    const field: ProfileField = {
        name: "Site",
        value: "*me*",
        format: "text/markdown",
        name_html: "<b>Site</b>",
        value_html: "<em>me</em>",
    };
    await test.ctx.db.updateTable("accounts")
        .set({
            note: "**Hi**",
            note_format: "text/markdown",
            note_html: "<p><strong>Hi</strong></p>",
            fields: [field],
        })
        .execute();
    const row = await find(test.ctx, id);

    const account = renderAccount(test.ctx, row, []);
    assertEquals(account.note, "<p><strong>Hi</strong></p>");
    assertEquals(account.fields, [{ name: "Site", value: "<em>me</em>", verified_at: null }]);

    const own = renderCredentialAccount(test.ctx, row, [], []);
    assertEquals(own.source.note, "**Hi**");
    assertEquals(own.source.fields, [{ name: "Site", value: "*me*", verified_at: null }]);
});

Deno.test("an owner sees their settings, and the role everyone has", async () => {
    await using test = await createTestContext();
    const id = await createLocalAccount(test.ctx, "alice");
    await test.ctx.db.updateTable("accounts")
        .set({ default_visibility: "unlisted", default_sensitive: true, default_language: "fr" })
        .execute();

    const own = CredentialAccount.parse(
        renderCredentialAccount(test.ctx, await find(test.ctx, id), [], ["owner:account"]),
    );

    assertEquals(own.source.privacy, "unlisted");
    assertEquals(own.source.sensitive, true);
    assertEquals(own.source.language, "fr");
    assertEquals(own.source.quote_policy, "public");
    assertEquals(own.role.permissions, "0");
    assertEquals(own.role.id, "-99");
});

Deno.test("an account that doesn't exist isn't found", async () => {
    await using test = await createTestContext();

    assertEquals(await findAccount(test.ctx, "missing"), undefined);
});

const role = (id: string, priority: number, visible: boolean): RoleRow => ({
    id,
    name: `The ${id}s`,
    description: "",
    permissions: [],
    priority,
    visible,
    color: visible ? "#ff3838" : "",
    icon: null,
    created_at: new Date(0),
});

Deno.test("others see an account's visible roles, highest first", async () => {
    await using test = await createTestContext();
    const id = await createLocalAccount(test.ctx, "alice");
    const roles = [role("admin", 100, true), role("hidden", 50, false), role("mod", 10, true)];

    const account = renderAccount(test.ctx, await find(test.ctx, id), roles);

    assertEquals(account.roles, [
        { id: "admin", name: "The admins", color: "#ff3838" },
        { id: "mod", name: "The mods", color: "#ff3838" },
    ]);
});

Deno.test("an owner sees their highest role, with everything they may do", async () => {
    await using test = await createTestContext();
    const id = await createLocalAccount(test.ctx, "alice");
    const roles = [role("hidden", 100, false), role("mod", 10, true)];

    const own = CredentialAccount.parse(
        renderCredentialAccount(test.ctx, await find(test.ctx, id), roles, ["roles"]),
    );

    assertEquals(own.role, {
        id: "hidden",
        name: "The hiddens",
        color: "",
        permissions: "131072",
        highlighted: false,
        collection_limit: 0,
    });
    assertEquals(
        renderCredentialAccount(test.ctx, await find(test.ctx, id), [roles[1]], []).role
            .highlighted,
        true,
    );
});
