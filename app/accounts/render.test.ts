import { assertEquals, assertExists } from "@std/assert";
import { Account, CredentialAccount } from "@versia/client-api";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import { createTestContext } from "../kernel/testing.ts";
import { findAccount, renderAccount, renderCredentialAccount, textToHtml } from "./render.ts";
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

    const account = Account.parse(renderAccount(test.ctx, await find(test.ctx, id)));

    assertEquals(account.acct, "alice");
    assertEquals(account.url, "https://social.example/@alice");
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

    const account = Account.parse(renderAccount(test.ctx, await find(test.ctx, "r")));

    assertEquals(account.acct, "bob@b.example");
    assertEquals(account.url, null);
    assertEquals(account.uri, "https://b.example/.versia/v0.6/entities/User/a%2Fb");
    assertEquals(account.avatar, "https://social.example/accounts/r/avatar.png");
    assertEquals(account.last_status_at, "2026-02-01");
    assertEquals(account.roles, null);
});

Deno.test("the bio and field values are escaped into HTML, but not for their owner", async () => {
    await using test = await createTestContext();
    const id = await createLocalAccount(test.ctx, "alice");
    const fields = [{ name: "Site", value: "<a href=x>me</a> & co" }];
    await test.ctx.db.updateTable("accounts")
        .set({ note: "Hi <b>all</b>\nsecond line\r\n\r\nnew 'paragraph'", fields })
        .execute();
    const row = await find(test.ctx, id);

    const account = renderAccount(test.ctx, row);
    assertEquals(
        account.note,
        "<p>Hi &lt;b&gt;all&lt;/b&gt;<br>second line</p><p>new &#39;paragraph&#39;</p>",
    );
    assertEquals(account.fields, [
        { name: "Site", value: "&lt;a href=x&gt;me&lt;/a&gt; &amp; co", verified_at: null },
    ]);

    const own = renderCredentialAccount(test.ctx, row);
    assertEquals(own.source.note, row.note);
    assertEquals(own.source.fields, [{ ...fields[0], verified_at: null }]);
});

Deno.test("blank text is no HTML at all", () => {
    assertEquals(textToHtml(""), "");
    assertEquals(textToHtml(" \n\n \n"), "");
});

Deno.test("an owner sees their settings, and the role everyone has", async () => {
    await using test = await createTestContext();
    const id = await createLocalAccount(test.ctx, "alice");
    await test.ctx.db.updateTable("accounts")
        .set({ default_visibility: "unlisted", default_sensitive: true, default_language: "fr" })
        .execute();

    const own = CredentialAccount.parse(
        renderCredentialAccount(test.ctx, await find(test.ctx, id)),
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
