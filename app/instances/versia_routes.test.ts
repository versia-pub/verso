import denoConfig from "../../deno.json" with { type: "json" };
import { assertEquals, assertNotEquals } from "@std/assert";
import { v0_7 } from "@versia/protocol";
import {
    createLocalAccount,
    createRemoteAccount,
    createRole,
    giveRole,
} from "../accounts/testing.ts";
import { firstMigratedAt } from "../db/migrate.ts";
import { createTestApp } from "../testing/app.ts";
import { Instance } from "../kernel/config_sections.ts";
import { createTestContext } from "../testing/context.ts";
import { instanceKey, rotateInstanceKey } from "./keys.ts";
import { createInstance, keyPair, metadataServer } from "./testing.ts";
import { versiaInstanceRoutes } from "./versia_routes.ts";

const open = async (instance = Instance.parse({}), extensions: string[] = []) => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, versiaInstanceRoutes(instance, extensions), {
        checkResponses: true,
    });

    const get = async (path: string, init: RequestInit = {}) => {
        const response = await app.request(path, init);
        return {
            status: response.status,
            type: response.headers.get("content-type"),
            body: await response.json(),
        };
    };

    // The collections of staff are signed, so they are fetched as b.example.
    const pair = await keyPair();
    test.transport.servers.set("b.example", metadataServer("b.example", pair));

    /** GETs `path` as b.example. */
    const getSigned = async (path: string) => {
        const headers = await v0_7.sign(
            { method: "GET", host: test.ctx.urls.domain, target: path, body: new Uint8Array() },
            pair.privateKey,
            "b.example",
            test.clock.now(),
        );

        return await get(path, { headers });
    };

    return { ...test, get, getSigned };
};

Deno.test("an instance says which versions of Versia it speaks", async () => {
    await using test = await open();

    assertEquals(await test.get("/.well-known/versia"), {
        status: 200,
        type: "application/jrd+json",
        body: { versions: ["0.7.0"] },
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
            software: { name: "Verso", version: denoConfig.version },
            compatibility: { extensions: ["pub.versia:social@1"] },
            domain: "social.example",
            public_key: { algorithm: "ed25519", key: (await instanceKey(test.ctx)).publicKey },
        },
    });

    const before = await test.get("/.versia/v0.7/instance");
    assertEquals(before, await expected());
    // Created by the migrations, not at the fake clock's time.
    assertNotEquals(before.body.created_at, test.clock.now().toISOString());

    test.clock.advance(1000);
    await rotateInstanceKey(test.ctx);
    const after = await test.get("/.versia/v0.7/instance");
    assertEquals(after, await expected());
    assertNotEquals(after.body.public_key, before.body.public_key);
});

Deno.test("an instance gives its configured name and description", async () => {
    await using test = await open(
        Instance.parse({ name: "Example Social", description: "A place to talk." }),
    );

    const { body } = await test.get("/.versia/v0.7/instance");

    assertEquals([body.name, body.description], ["Example Social", "A place to talk."]);
});

Deno.test("an instance lists its extensions at version 1, sorted, with the social one", async () => {
    await using test = await open(Instance.parse({}), [
        "pub.versia:polls",
        "pub.versia:likes",
        "pub.versia:social",
        "pub.versia:likes",
    ]);

    const { body } = await test.get("/.versia/v0.7/instance");

    assertEquals(body.compatibility.extensions, [
        "pub.versia:likes@1",
        "pub.versia:polls@1",
        "pub.versia:social@1",
    ]);
    assertEquals("versions" in body.compatibility, false);
});

/** Local accounts made one second apart, oldest first, unless they are given the same time. */
const staffSetup = async (test: Awaited<ReturnType<typeof open>>) => {
    const { ctx, clock } = test;
    const admin = await createRole(ctx, "admin", ["roles", "reports"]);
    const moderator = await createRole(ctx, "moderator", ["reports"]);
    const plain = await createRole(ctx, "plain", []);

    const make = async (name: string, ...roles: string[]) => {
        await createLocalAccount(ctx, name);
        for (const role of roles) await giveRole(ctx, name, role);
        clock.advance(1000);
    };

    return { admin, moderator, plain, make };
};

Deno.test("the staff collections are only for signed requests", async () => {
    await using test = await open();

    for (const name of ["admins", "moderators"]) {
        const { status } = await test.get(`/.versia/v0.7/instance/collections/${name}`);

        assertEquals(status, 401, name);
    }
});

Deno.test("admins are the local users with a role that can manage roles", async () => {
    await using test = await open();
    const { admin, moderator, plain, make } = await staffSetup(test);
    await make("ann", admin);
    await make("mod", moderator);
    await make("nobody", plain);
    await make("none");

    const reply = await test.getSigned("/.versia/v0.7/instance/collections/admins");

    assertEquals(reply, {
        status: 200,
        type: "application/vnd.versia+json; charset=utf-8",
        body: { total: 1, items: ["social.example:ann"] },
    });
});

Deno.test("moderators are the local users with a role that can handle reports", async () => {
    await using test = await open();
    const { admin, moderator, plain, make } = await staffSetup(test);
    await make("ann", admin);
    await make("mod", moderator);
    await make("nobody", plain);

    const { body } = await test.getSigned("/.versia/v0.7/instance/collections/moderators");

    assertEquals(body, { total: 2, items: ["social.example:ann", "social.example:mod"] });
});

Deno.test("a role counts whoever gave it, and a user with several is listed once", async () => {
    await using test = await open();
    const { admin, moderator, make } = await staffSetup(test);
    await make("ann", admin, moderator);
    await make("ben");
    // Given by an identity provider, not by an admin.
    await giveRole(test.ctx, "ben", moderator, "idp.example");

    const { body } = await test.getSigned("/.versia/v0.7/instance/collections/moderators");

    assertEquals(body, { total: 2, items: ["social.example:ann", "social.example:ben"] });
});

Deno.test("staff who are suspended, deleted or from other instances aren't listed", async () => {
    await using test = await open();
    const { admin, make } = await staffSetup(test);
    await make("ann", admin);
    await make("suspended", admin);
    await make("deleted", admin);
    await createRemoteAccount(
        test.ctx,
        "remote",
        await createInstance(test.ctx, "other.example"),
    );
    await giveRole(test.ctx, "remote", admin);
    await test.ctx.db.updateTable("accounts").set({ suspended_at: test.clock.now() })
        .where("id", "=", "suspended").execute();
    await test.ctx.db.updateTable("accounts").set({ deleted_at: test.clock.now() })
        .where("id", "=", "deleted").execute();

    const { body } = await test.getSigned("/.versia/v0.7/instance/collections/admins");

    assertEquals(body, { total: 1, items: ["social.example:ann"] });
});

Deno.test("staff are listed oldest first, then by id, in pages with the true total", async () => {
    await using test = await open();
    const { admin, make } = await staffSetup(test);
    await make("d", admin);
    // The same time as the next one, so their ids order them.
    await createLocalAccount(test.ctx, "c2");
    await createLocalAccount(test.ctx, "c1");
    await giveRole(test.ctx, "c2", admin);
    await giveRole(test.ctx, "c1", admin);
    test.clock.advance(1000);
    await make("a", admin);
    const path = "/.versia/v0.7/instance/collections/admins";
    const ids = (items: string[]) => items.map((item) => item.split(":")[1]);

    const all = (await test.getSigned(path)).body;
    const page = (await test.getSigned(`${path}?offset=1&limit=2`)).body;
    const past = (await test.getSigned(`${path}?offset=10`)).body;
    const clamped = (await test.getSigned(`${path}?limit=0`)).body;

    assertEquals([all.total, ids(all.items)], [4, ["d", "c1", "c2", "a"]]);
    assertEquals([page.total, ids(page.items)], [4, ["c1", "c2"]]);
    assertEquals([past.total, past.items], [4, []]);
    assertEquals([clamped.total, ids(clamped.items)], [4, ["d"]]);
});

Deno.test("a collection of staff is empty when no role has the permission", async () => {
    await using test = await open();
    const { plain, make } = await staffSetup(test);
    await make("nobody", plain);

    const { body } = await test.getSigned("/.versia/v0.7/instance/collections/admins");

    assertEquals(body, { total: 0, items: [] });
});
