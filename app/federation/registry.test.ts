import { assertEquals, assertThrows } from "@std/assert";
import { sign } from "@versia/protocol";
import { z } from "zod";
import { keyPair, metadataServer } from "../instances/testing.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { createRegistry, entityRoutes, type EntityType } from "./registry.ts";

/** What a type does with entities it is sent, for tests that only fetch them. */
const ignored = { authority: () => undefined, receive: () => Promise.resolve() };

const Thing = z.object({ type: z.literal("Thing"), id: z.string(), seen_by: z.string() });

/** A type whose entities are only found by b.example, and say who asked for them. */
const thing: EntityType<z.infer<typeof Thing>> = {
    type: "Thing",
    extension: "test.example:things",
    schema: Thing,
    ...ignored,
    find: (_ctx, id, requester) =>
        Promise.resolve(
            requester === "b.example" ? { type: "Thing", id, seen_by: requester } : undefined,
        ),
    collections: {
        parts: (_ctx, id, page) =>
            Promise.resolve(
                id === "missing" ? undefined : { author: id, total: page.offset ?? 0, items: [] },
            ),
    },
};

/** A type that can be received, but not fetched. */
const transient: EntityType = {
    type: "Ping",
    extension: "test.example:things",
    schema: z.unknown(),
    ...ignored,
};

const open = async () => {
    const test = await createTestContext();
    const pair = await keyPair();
    test.transport.servers.set("b.example", metadataServer("b.example", pair));
    const app = createTestApp(test.ctx, entityRoutes(createRegistry([thing, transient])), {
        checkResponses: true,
    });

    /** GETs `path` as b.example. */
    const get = async (path: string) => {
        const headers = await sign(
            {
                method: "GET",
                pathname: new URL(path, "https://x").pathname,
                body: new Uint8Array(),
            },
            pair.privateKey,
            "b.example",
            test.clock.now(),
        );
        const response = await app.request(path, { headers });
        return { status: response.status, body: await response.json() };
    };

    return { ...test, get };
};

Deno.test("a type's entities are fetched at its own path, as the requester may see them", async () => {
    await using test = await open();

    assertEquals(await test.get("/.versia/v0.6/entities/Thing/1"), {
        status: 200,
        body: { type: "Thing", id: "1", seen_by: "b.example" },
    });
    assertEquals((await test.get("/.versia/v0.6/entities/Ping/1")).status, 404);
});

Deno.test("a type's collections are paged, and unknown ones aren't found", async () => {
    await using test = await open();

    assertEquals(await test.get("/.versia/v0.6/entities/Thing/1/collections/parts?offset=3"), {
        status: 200,
        body: { author: "1", total: 3, items: [] },
    });
    for (
        const path of ["1/collections/other", "1/collections/toString", "missing/collections/parts"]
    ) {
        assertEquals((await test.get(`/.versia/v0.6/entities/Thing/${path}`)).status, 404, path);
    }
});

Deno.test("a registry lists the extensions its types come from, once each", () => {
    const user: EntityType = { type: "User", schema: z.unknown(), ...ignored };
    const like: EntityType = {
        type: "pub.versia:likes/Like",
        extension: "pub.versia:likes",
        schema: z.unknown(),
        ...ignored,
    };

    assertEquals(createRegistry([user, thing, like, transient]).extensions, [
        "pub.versia:likes",
        "test.example:things",
    ]);
});

Deno.test("a type can only be registered once", () => {
    assertThrows(() => createRegistry([thing, thing]), Error, "Thing is registered twice");
});
