import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import type { Config } from "../kernel/config.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { blockDomain } from "./domain_blocks.ts";
import { moderationRoutes } from "./routes.ts";

type Shown = Config["instance"]["show_blocks"];

/** An instance that blocks `config.example` in config, and `spam.example` by an admin. */
const open = async (blocks: Shown, reasons: Shown = "none") => {
    const test = await createTestContext();
    const routes = moderationRoutes(
        { show_blocks: blocks, show_block_reasons: reasons },
        ["config.example"],
    );
    const app = createTestApp(test.ctx, routes, { checkResponses: true });
    await blockDomain(test.ctx, "spam.example", "Spam");

    const fetch = async (token?: string) => {
        const response = await app.request("/api/v1/instance/domain_blocks", {
            headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    };

    return { ...test, fetch };
};

/** The SHA-256 of `domain`, in hex. */
const digest = async (domain: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(domain)))
        .toHex();

Deno.test("blocked instances are hidden by default", async () => {
    await using test = await open("none");
    await createLocalAccount(test.ctx, "alice");

    assertEquals((await test.fetch()).status, 404);
    assertEquals((await test.fetch(await tokenFor(test.ctx, "alice"))).status, 404);
});

Deno.test("blocked instances are listed, by config and by admins, without reasons", async () => {
    await using test = await open("all");

    const { status, body } = await test.fetch();

    assertEquals(status, 200);
    assertEquals(body, [
        {
            domain: "config.example",
            digest: await digest("config.example"),
            severity: "suspend",
            comment: null,
        },
        {
            domain: "spam.example",
            digest: await digest("spam.example"),
            severity: "suspend",
            comment: null,
        },
    ]);
});

Deno.test("blocks can be shown only to users, with reasons only to users", async () => {
    await using test = await open("users", "users");
    await createLocalAccount(test.ctx, "alice");

    const signedIn = await test.fetch(await tokenFor(test.ctx, "alice"));

    assertEquals(signedIn.status, 200);
    assertEquals(signedIn.body.map((block: { comment: string | null }) => block.comment), [
        null,
        "Spam",
    ]);
    assertEquals((await test.fetch()).status, 404);
    assertEquals((await test.fetch(await tokenFor(test.ctx, null))).status, 404);
});

Deno.test("reasons can be shown to everyone who sees the blocks", async () => {
    await using test = await open("all", "all");

    const { body } = await test.fetch();

    assertEquals(body[1].comment, "Spam");
});
