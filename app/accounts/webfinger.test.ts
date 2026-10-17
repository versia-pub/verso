import { assertEquals } from "@std/assert";
import { createApp } from "../http/app.ts";
import { createInstance } from "../instances/testing.ts";
import { createTestContext } from "../kernel/testing.ts";
import { createLocalAccount } from "./testing.ts";
import { webfingerRoutes } from "./webfinger.ts";

const open = async () => {
    const test = await createTestContext();
    const app = createApp(test.ctx, webfingerRoutes, { checkResponses: true });
    await createLocalAccount(test.ctx, "alice");

    const finger = async (resource?: string) => {
        const query = resource === undefined ? "" : `?${new URLSearchParams({ resource })}`;
        const response = await app.request(`/.well-known/webfinger${query}`);
        return {
            status: response.status,
            type: response.headers.get("content-type"),
            body: await response.json(),
        };
    };

    return { ...test, finger };
};

Deno.test("a local account is found by its address, in any case", async () => {
    await using test = await open();

    assertEquals(await test.finger("acct:ALICE@Social.Example"), {
        status: 200,
        type: "application/jrd+json",
        body: {
            subject: "acct:alice@social.example",
            aliases: ["https://social.example/.versia/v0.6/entities/User/alice"],
            links: [
                {
                    rel: "self",
                    type: "application/vnd.versia+json",
                    href: "https://social.example/.versia/v0.6/entities/User/alice",
                },
                {
                    rel: "http://webfinger.net/rel/avatar",
                    type: "image/png",
                    href: "https://social.example/accounts/alice/avatar.png",
                },
            ],
        },
    });
});

Deno.test("only acct: addresses are looked up", async () => {
    await using test = await open();
    // Schemes are case-insensitive.
    assertEquals((await test.finger("ACCT:alice@social.example")).status, 200);

    for (
        const resource of [
            undefined,
            "",
            "alice@social.example",
            "acct:alice",
            "acct:@alice@social.example",
            "acct:alice@social.example@b.example",
            "https://social.example/@alice",
        ]
    ) {
        assertEquals(await test.finger(resource), {
            status: 400,
            type: "application/json",
            body: { error: "Bad request", error_description: "The resource must be an acct: URI" },
        }, resource);
    }
});

Deno.test("accounts that aren't this instance's aren't found", async () => {
    await using test = await open();
    await test.ctx.db.insertInto("accounts")
        .values({
            id: "remote",
            username: "carol",
            instance_id: await createInstance(test.ctx, "b.example"),
            remote_id: "carol",
            created_at: test.ctx.clock.now(),
        })
        .execute();

    for (
        const resource of [
            "acct:bob@social.example",
            "acct:alice@b.example",
            "acct:carol@b.example",
            "acct:carol@social.example",
        ]
    ) {
        assertEquals(await test.finger(resource), {
            status: 404,
            type: "application/json",
            body: { error: "Record not found" },
        }, resource);
    }
});
