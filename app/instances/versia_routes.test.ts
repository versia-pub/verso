import { assertEquals, assertNotEquals } from "@std/assert";
import { firstMigratedAt } from "../db/migrate.ts";
import { createApp } from "../http/app.ts";
import { Instance } from "../kernel/config.ts";
import { createTestContext } from "../kernel/testing.ts";
import { instanceKey, rotateInstanceKey } from "./keys.ts";
import { versiaInstanceRoutes } from "./versia_routes.ts";

const open = async (instance = Instance.parse({})) => {
    const test = await createTestContext();
    const app = createApp(test.ctx, versiaInstanceRoutes(instance), { checkResponses: true });

    const get = async (path: string) => {
        const response = await app.request(path);
        return {
            status: response.status,
            type: response.headers.get("content-type"),
            body: await response.json(),
        };
    };

    return { ...test, get };
};

Deno.test("an instance says which versions of Versia it speaks", async () => {
    await using test = await open();

    assertEquals(await test.get("/.well-known/versia"), {
        status: 200,
        type: "application/jrd+json",
        body: { versions: ["0.6.0"] },
    });
});

Deno.test("an instance describes itself to others, with its current key", async () => {
    await using test = await open();
    const expected = async () => ({
        status: 200,
        type: "application/vnd.versia+json; charset=utf-8",
        body: {
            type: "InstanceMetadata",
            created_at: (await firstMigratedAt(test.ctx.db)).toISOString(),
            name: "social.example",
            software: { name: "Verso", version: "0.0.0" },
            compatibility: { versions: ["0.6.0"], extensions: [] },
            domain: "social.example",
            public_key: { algorithm: "ed25519", key: (await instanceKey(test.ctx)).publicKey },
        },
    });

    const before = await test.get("/.versia/v0.6/instance");
    assertEquals(before, await expected());
    // Set up by the migrations, not at the fake clock's time.
    assertNotEquals(before.body.created_at, test.clock.now().toISOString());

    test.clock.advance(1000);
    await rotateInstanceKey(test.ctx);
    const after = await test.get("/.versia/v0.6/instance");
    assertEquals(after, await expected());
    assertNotEquals(after.body.public_key, before.body.public_key);
});

Deno.test("an instance gives its configured name and description", async () => {
    await using test = await open(
        Instance.parse({ name: "Example Social", description: "A place to talk." }),
    );

    const { body } = await test.get("/.versia/v0.6/instance");

    assertEquals([body.name, body.description], ["Example Social", "A place to talk."]);
});
