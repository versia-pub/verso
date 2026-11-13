import denoConfig from "../../deno.json" with { type: "json" };
import { assertEquals } from "@std/assert";
import { tokenFor } from "../auth/testing.ts";
import { createLocalAccount } from "../accounts/testing.ts";
import { Instance } from "../kernel/config_sections.ts";
import { postNote } from "../notes/notes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { nodeInfoRoutes } from "./nodeinfo.ts";

const week = 7 * 24 * 60 * 60 * 1000;

const open = async (instance = Instance.parse({})) => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, nodeInfoRoutes(instance), { checkResponses: true });

    const get = async (path: string) => {
        const response = await app.request(path);
        return {
            status: response.status,
            type: response.headers.get("content-type"),
            cache: response.headers.get("cache-control"),
            body: await response.json(),
        };
    };
    const usage = async () => (await get("/nodeinfo/2.0")).body.usage;

    return { ...test, get, usage };
};

Deno.test("NodeInfo discovery points to the 2.0 schema, which may be cached for three days", async () => {
    await using test = await open();

    assertEquals(await test.get("/.well-known/nodeinfo"), {
        status: 200,
        type: "application/json",
        cache: "public, max-age=259200",
        body: {
            links: [{
                rel: "http://nodeinfo.diaspora.software/ns/schema/2.0",
                href: "https://social.example/nodeinfo/2.0",
            }],
        },
    });
});

Deno.test("NodeInfo describes Verso, which may be cached for half an hour", async () => {
    await using test = await open(Instance.parse({ name: "Example Social", description: "Talk." }));

    assertEquals(await test.get("/nodeinfo/2.0"), {
        status: 200,
        type: "application/json",
        cache: "public, max-age=1800",
        body: {
            version: "2.0",
            software: { name: "verso", version: denoConfig.version },
            protocols: ["versia"],
            services: { outbound: [], inbound: [] },
            usage: {
                users: { total: 0, activeMonth: 0, activeHalfyear: 0 },
                localPosts: 0,
            },
            openRegistrations: false,
            metadata: { nodeName: "Example Social", nodeDescription: "Talk." },
        },
    });
});

Deno.test("NodeInfo names the instance by its domain until it has a name", async () => {
    await using test = await open();

    assertEquals((await test.get("/nodeinfo/2.0")).body.metadata, {
        nodeName: "social.example",
        nodeDescription: "",
    });
});

Deno.test("NodeInfo counts local accounts and statuses, and who logged in within 4 and 24 weeks", async () => {
    await using test = await open();
    for (const username of ["alice", "bob", "carol"]) {
        await createLocalAccount(test.ctx, username);
    }
    await tokenFor(test.ctx, "alice");
    test.clock.advance(20 * week);
    await tokenFor(test.ctx, "bob");
    await tokenFor(test.ctx, "bob");
    await tokenFor(test.ctx, null);
    for (const text of ["Hi", "Bye"]) {
        await postNote(test.ctx, "bob", { text, format: "text/plain", spoilerText: "" });
    }
    // Alice's login is now 24 weeks old, which is still in the half year, and Bob's 4 weeks old,
    // which is still in the month.
    test.clock.advance(4 * week);

    assertEquals(await test.usage(), {
        users: { total: 3, activeMonth: 1, activeHalfyear: 2 },
        localPosts: 2,
    });
});

Deno.test("NodeInfo's active users leave a window one millisecond after it ends", async () => {
    await using test = await open();
    await createLocalAccount(test.ctx, "alice");
    await tokenFor(test.ctx, "alice");

    test.clock.advance(4 * week + 1);

    assertEquals((await test.usage()).users, { total: 1, activeMonth: 0, activeHalfyear: 1 });
});

Deno.test("NodeInfo's half year ends after 24 weeks", async () => {
    await using test = await open();
    await createLocalAccount(test.ctx, "alice");
    await tokenFor(test.ctx, "alice");

    test.clock.advance(24 * week + 1);

    assertEquals((await test.usage()).users, { total: 1, activeMonth: 0, activeHalfyear: 0 });
});

Deno.test("NodeInfo's counts are kept for 30 minutes", async () => {
    await using test = await open();
    assertEquals((await test.usage()).localPosts, 0);
    await createLocalAccount(test.ctx, "alice");
    await postNote(test.ctx, "alice", { text: "Hi", format: "text/plain", spoilerText: "" });

    test.clock.advance(30 * 60_000 - 1);

    assertEquals((await test.usage()).localPosts, 0);

    test.clock.advance(1);

    assertEquals((await test.usage()).localPosts, 1);
});
