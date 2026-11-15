import { assertEquals } from "@std/assert";
import { decode, encode } from "fast-png";
import { z } from "zod";
import { tokenFor } from "../auth/testing.ts";
import { createTestApp } from "../testing/app.ts";
import { memoryRateLimitStore } from "../http/rate_limits.ts";
import { defineRoute } from "../http/route.ts";
import { createInstance } from "../instances/testing.ts";
import { featureTag } from "../tags/featured_tags.ts";
import { queues } from "../jobs/queues.ts";
import { drain } from "../jobs/worker.ts";
import { Limits, MediaLimits, Permissions } from "../kernel/config_sections.ts";
import type { Scope } from "../kernel/scopes.ts";
import { createTestContext } from "../testing/context.ts";
import { accountRoutes } from "./routes.ts";
import { createLocalAccount, createRole, giveRole } from "./testing.ts";
import { webfingerRoutes } from "./webfinger.ts";

const ping = defineRoute({
    method: "GET",
    path: "/api/v1/ping",
    summary: "Answers anyone",
    responses: { 200: z.object({}) },
    handler: () => Promise.resolve({ status: 200, body: {} }),
});

const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, [
        ...accountRoutes(MediaLimits.parse({}), Limits.parse({})),
        ping,
    ], {
        checkResponses: true,
        rateLimits: {
            store: memoryRateLimitStore(test.clock),
            policy: { limit: 2, windowSeconds: 60 },
            instancePolicy: { limit: 2, windowSeconds: 60 },
        },
    });
    await createLocalAccount(test.ctx, "019a");

    return { ...test, app };
};

Deno.test("an account's default pictures are PNGs anyone may cache for a day", async () => {
    await using test = await open();

    for (const [picture, size] of [["avatar", [420, 420]], ["header", [1500, 500]]] as const) {
        const response = await test.app.request(`/accounts/019a/${picture}.png`);
        const image = decode(new Uint8Array(await response.arrayBuffer()), { checkCrc: true });

        assertEquals(response.status, 200, picture);
        assertEquals(response.headers.get("content-type"), "image/png", picture);
        assertEquals(response.headers.get("cache-control"), "public, max-age=86400", picture);
        assertEquals<readonly number[]>([image.width, image.height], size, picture);
    }
});

Deno.test("an id that can't be an account's is refused", async () => {
    await using test = await open();
    const response = await test.app.request("/accounts/a.b/avatar.png");
    await response.body?.cancel();

    assertEquals(response.status, 422);
    assertEquals(response.headers.get("cache-control"), "no-store");
});

Deno.test("pictures aren't rate limited, unlike the API", async () => {
    await using test = await open();
    const status = async (path: string) => {
        const response = await test.app.request(path);
        await response.body?.cancel();
        return response.status;
    };

    for (let i = 0; i < 3; i++) assertEquals(await status("/accounts/019a/avatar.png"), 200);
    for (let i = 0; i < 2; i++) assertEquals(await status("/api/v1/ping"), 200);
    assertEquals(await status("/api/v1/ping"), 429);
});

/** The API, without rate limits, with alice on the local instance and bob on a remote one. */
const openApi = async (limits = Limits.parse({}), media = MediaLimits.parse({})) => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, accountRoutes(media, limits), { checkResponses: true });

    await createLocalAccount(test.ctx, "alice");
    await createInstance(test.ctx, "b.example");
    await test.ctx.db.insertInto("accounts")
        .values({
            id: "bob",
            username: "bob",
            instance_id: "b.example",
            remote_id: "1",
            created_at: test.clock.now(),
        })
        .execute();

    const get = async (path: string, token?: string) => {
        const headers: HeadersInit = token ? { authorization: `Bearer ${token}` } : {};
        const response = await app.request(path, { headers });
        return { status: response.status, body: await response.json() };
    };

    /** Changes alice's profile, with a form that sets its own type if `body` is one. */
    const update = async (body: string | FormData, type = "application/json", token?: string) => {
        const response = await app.request("/api/v1/accounts/update_credentials", {
            method: "PATCH",
            body,
            headers: {
                ...typeof body === "string" && { "content-type": type },
                authorization: `Bearer ${token ?? await tokenFor(test.ctx, "alice")}`,
            },
        });
        return { status: response.status, body: await response.json() };
    };

    return { ...test, app, get, update };
};

Deno.test("a user sees their own account, with their settings", async () => {
    await using test = await openApi();
    const path = "/api/v1/accounts/verify_credentials";

    const own = await test.get(path, await tokenFor(test.ctx, "alice"));
    assertEquals(own.status, 200);
    assertEquals(own.body.username, "alice");
    assertEquals(own.body.source.privacy, "public");

    assertEquals(
        (await test.get(path, await tokenFor(test.ctx, "alice", ["profile"]))).status,
        200,
    );
    assertEquals((await test.get(path)).status, 401);
    assertEquals((await test.get(path, await tokenFor(test.ctx, null))).status, 422);
    assertEquals(
        (await test.get(path, await tokenFor(test.ctx, "alice", ["read:statuses"]))).status,
        403,
    );
});

Deno.test("a user's preferences are their defaults for posting, and Mastodon's for the rest", async () => {
    await using test = await openApi();
    const preferences = async () =>
        await test.get("/api/v1/preferences", await tokenFor(test.ctx, "alice"));
    const others = {
        "posting:default:quote_policy": "public",
        "posting:default:spoiler_field": false,
        "reading:expand:media": "default",
        "reading:expand:spoilers": false,
        "reading:autoplay:gifs": false,
    };

    assertEquals(await preferences(), {
        status: 200,
        body: {
            "posting:default:visibility": "public",
            "posting:default:sensitive": false,
            "posting:default:language": null,
            ...others,
        },
    });

    await test.update(JSON.stringify({
        source: { privacy: "private", sensitive: true, language: "fr" },
    }));
    assertEquals((await preferences()).body, {
        "posting:default:visibility": "private",
        "posting:default:sensitive": true,
        "posting:default:language": "fr",
        ...others,
    });
});

Deno.test("preferences need a user's token that may read accounts", async () => {
    await using test = await openApi();
    const path = "/api/v1/preferences";

    assertEquals(
        (await test.get(path, await tokenFor(test.ctx, "alice", ["read:accounts"]))).status,
        200,
    );
    assertEquals(
        (await test.get(path, await tokenFor(test.ctx, "alice", ["read:statuses"]))).status,
        403,
    );
    assertEquals((await test.get(path)).status, 401);
    assertEquals((await test.get(path, await tokenFor(test.ctx, null))).status, 422);
});

Deno.test("anyone sees an account by its id, without its settings", async () => {
    await using test = await openApi();

    const alice = await test.get("/api/v1/accounts/alice");
    assertEquals(alice.status, 200);
    assertEquals(alice.body.acct, "alice");
    assertEquals(alice.body.source, undefined);

    const bob = await test.get("/api/v1/accounts/bob");
    assertEquals([bob.status, bob.body.acct], [200, "bob@b.example"]);

    for (const id of ["missing", "a.b"]) {
        assertEquals(
            await test.get(`/api/v1/accounts/${id}`),
            { status: 404, body: { error: "Record not found" } },
            id,
        );
    }
});

Deno.test("anyone sees several accounts by their ids, in the order asked, without missing ones", async () => {
    await using test = await openApi();
    const accts = async (query: string) => {
        const reply = await test.get(`/api/v1/accounts?${query}`);
        return [
            reply.status,
            reply.status === 200 ? reply.body.map((a: { acct: string }) => a.acct) : reply.body,
        ];
    };

    assertEquals(await accts("id[]=bob&id[]=missing&id[]=alice&id[]=bob"), [200, [
        "bob@b.example",
        "alice",
    ]]);
    assertEquals(await accts("id=alice"), [200, ["alice"]]);
    assertEquals(await accts(""), [200, []]);

    // Mastodon's limit is 40 at once.
    const asking = (n: number) => Array.from({ length: n }, (_, i) => `id[]=${i}`).join("&");
    assertEquals((await accts(asking(40)))[0], 200);
    assertEquals((await accts(asking(41)))[0], 422);
});

Deno.test("an account is looked up by its username or address", async () => {
    await using test = await openApi();
    const lookup = (acct: string) =>
        test.get(`/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`);

    for (
        const acct of ["alice", "ALICE", "@alice", "alice@social.example", "alice@Social.Example"]
    ) {
        const found = await lookup(acct);
        assertEquals([found.status, found.body.id], [200, "alice"], acct);
    }

    for (
        const acct of [
            "",
            "carol",
            "bob",
            "alice@b.example",
            "alice@social.example@x",
        ]
    ) {
        assertEquals((await lookup(acct)).status, 404, acct);
    }

    const bob = await lookup("@bob@B.Example");
    assertEquals([bob.status, bob.body.acct], [200, "bob@b.example"]);
    assertEquals((await test.get("/api/v1/accounts/lookup")).status, 422);
    assertEquals(test.transport.sent, []);
});

Deno.test("only users make Verso look for accounts it doesn't know", async () => {
    await using test = await openApi();
    const path = "/api/v1/accounts/lookup?acct=carol@c.example";

    assertEquals((await test.get(path)).status, 404);
    assertEquals((await test.get(path, await tokenFor(test.ctx, null))).status, 404);
    assertEquals(test.transport.sent, []);

    // c.example can't be reached, which is the same as carol not existing.
    assertEquals((await test.get(path, await tokenFor(test.ctx, "alice"))).status, 404);
    assertEquals(test.transport.sent.map((request) => new URL(request.url).host), ["c.example"]);
});

Deno.test("a user changes their profile with JSON, and gets it back as HTML", async () => {
    await using test = await openApi();

    const { status, body } = await test.update(JSON.stringify({
        display_name: " Alice ",
        note: "Hi <you>\n\nthere",
        locked: true,
        fields_attributes: [{ name: "Site", value: "a & b" }, { name: " ", value: "" }],
        source: { privacy: "unlisted", language: "fr" },
    }));

    assertEquals(status, 200);
    assertEquals(body.display_name, "Alice");
    assertEquals(body.note, "<p>Hi &lt;you&gt;</p><p>there</p>");
    assertEquals(body.source.note, "Hi <you>\n\nthere");
    assertEquals(body.fields, [{ name: "Site", value: "a &amp; b", verified_at: null }]);
    assertEquals(body.source.fields, [{ name: "Site", value: "a & b", verified_at: null }]);
    assertEquals([body.locked, body.source.privacy, body.source.language], [
        true,
        "unlisted",
        "fr",
    ]);

    const again = await test.get("/api/v1/accounts/alice");
    assertEquals([again.body.display_name, again.body.locked], ["Alice", true]);
});

Deno.test("a user changes their profile with a form, and the rest stays", async () => {
    await using test = await openApi();
    await test.update(JSON.stringify({ note: "Kept", bot: true }));

    const form = [
        "locked=1",
        "bot=0",
        "fields_attributes[0][name]=Site",
        "fields_attributes[0][value]=x",
        "source[sensitive]=true",
    ].join("&");
    const { status, body } = await test.update(form, "application/x-www-form-urlencoded");

    assertEquals(status, 200);
    assertEquals([body.locked, body.bot, body.source.sensitive], [true, false, true]);
    assertEquals(body.source.fields, [{ name: "Site", value: "x", verified_at: null }]);
    assertEquals(body.source.note, "Kept");

    assertEquals((await test.update("{}")).body.source.note, "Kept");
});

Deno.test("a user names the domains that may credit them, cleaned up as Mastodon does", async () => {
    await using test = await openApi();
    const domains = async (body: string, type = "application/json") =>
        (await test.update(body, type)).body.source?.attribution_domains;

    assertEquals((await test.update("{}")).body.source.attribution_domains, []);
    assertEquals(
        await domains(JSON.stringify({
            attribution_domains: [
                " https://news.example ",
                "http://blog.example",
                "*.Shop.example",
                "news.example",
                "",
                "  ",
            ],
        })),
        ["news.example", "blog.example", "shop.example"],
    );
    assertEquals(await domains("{}"), ["news.example", "blog.example", "shop.example"]);
    assertEquals(
        await domains(
            "attribution_domains[]=a.example&attribution_domains[]=b.example",
            "application/x-www-form-urlencoded",
        ),
        ["a.example", "b.example"],
    );
    assertEquals(await domains("attribution_domains[]=", "application/x-www-form-urlencoded"), []);
});

Deno.test("domains that can't credit an account are refused, and nothing changes", async () => {
    await using test = await openApi();
    await test.update(JSON.stringify({ attribution_domains: ["kept.example"] }));
    const tooMany = Array.from({ length: 101 }, (_, index) => `d${index}.example`);

    for (const invalid of [["localhost"], ["a.example/path"], ["a.example:8080"], [1], tooMany]) {
        const response = await test.update(JSON.stringify({ attribution_domains: invalid }));
        assertEquals(response.status, 422, JSON.stringify(invalid).slice(0, 40));
    }

    const hundred = tooMany.slice(0, 100);
    const accepted = await test.update(JSON.stringify({ attribution_domains: hundred }));
    assertEquals(accepted.body.source.attribution_domains, hundred);
    assertEquals(
        (await test.update(JSON.stringify({ attribution_domains: [...hundred, "d0.example"] })))
            .status,
        200,
    );
    assertEquals(
        (await test.update(JSON.stringify({ attribution_domains: ["z.example", ...tooMany] })))
            .status,
        422,
    );
    assertEquals((await test.update("{}")).body.source.attribution_domains, hundred);
});

Deno.test("profile changes are held to the configured limits", async () => {
    await using test = await openApi(
        Limits.parse({
            display_name: 3,
            note: 4,
            fields: 2,
            field_name: 5,
            field_value: 6,
            media_description: 7,
        }),
    );
    const field = { name: "a", value: "b" };

    for (
        const changes of [
            { display_name: "x".repeat(4) },
            { note: "x".repeat(5) },
            { fields_attributes: [field, field, field] },
            { fields_attributes: [{ name: "x".repeat(6) }] },
            { fields_attributes: [{ name: "a", value: "x".repeat(7) }] },
            { locked: "yes" },
            { source: { privacy: "direct" } },
            { source: { language: "fra" } },
            { avatar_description: "x".repeat(8) },
            { header_description: "x".repeat(8) },
        ]
    ) {
        assertEquals(
            (await test.update(JSON.stringify(changes))).status,
            422,
            JSON.stringify(changes),
        );
    }

    const fits = await test.update(JSON.stringify({
        display_name: "🦊🦊🦊",
        note: "xxxx",
        fields_attributes: [field, { name: "x".repeat(5), value: "x".repeat(6) }],
    }));
    assertEquals([fits.status, fits.body.display_name, fits.body.fields.length], [
        200,
        "🦊🦊🦊",
        2,
    ]);
});

/** A `width`×`height` PNG, entirely grey. */
const png = (width: number, height: number) =>
    new Uint8Array(encode({
        width,
        height,
        data: new Uint8Array(width * height * 4).fill(200),
        channels: 4,
    }));

/** A `side`×`side` PNG of noise, which doesn't compress, from xorshift. */
const noise = (side: number) => {
    let state = 1;
    const data = new Uint8Array(side * side * 4).map(() => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state & 255;
    });

    return new Uint8Array(encode({ width: side, height: side, data, channels: 4 }));
};

/** A form with each of `fields`, files given as their bytes. */
const formOf = (fields: Record<string, string | Uint8Array<ArrayBuffer>>) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) {
        form.append(name, typeof value === "string" ? value : new File([value], `${name}.png`));
    }

    return form;
};

/** The size of the media `id` that alice's account has as `column`. */
const pictureSize = async (
    test: Awaited<ReturnType<typeof openApi>>,
    column: "avatar_id" | "header_id",
) => {
    const row = await test.ctx.db.selectFrom("accounts")
        .innerJoin("media", "media.id", `accounts.${column}`)
        .select(["media.width", "media.height"])
        .where("accounts.id", "=", "alice")
        .executeTakeFirst();

    return [row?.width, row?.height];
};

Deno.test("a user's new avatar and header are shown once processed, scaled down to fit", async () => {
    await using test = await openApi();
    const credentials = "/api/v1/accounts/verify_credentials";

    const changed = await test.update(formOf({
        avatar: png(800, 200),
        avatar_description: "A grey stripe",
        header: png(3000, 500),
        header_description: "A grey band",
    }));

    // The default pictures until then.
    assertEquals(changed.status, 200);
    assertEquals(
        [changed.body.avatar, changed.body.avatar_static],
        Array(2).fill("https://social.example/accounts/alice/avatar.png"),
    );
    assertEquals(changed.body.header, "https://social.example/accounts/alice/header.png");
    assertEquals(changed.body.avatar_description, "A grey stripe");

    await drain(test.ctx, queues);

    const { body } = await test.get(credentials, await tokenFor(test.ctx, "alice"));
    for (const url of [body.avatar, body.avatar_static, body.header, body.header_static]) {
        assertEquals(url.startsWith("https://social.example/media/"), true, url);
    }
    assertEquals(body.avatar === body.avatar_static, false);
    assertEquals(body.header === body.header_static, false);
    assertEquals([body.avatar_description, body.header_description], [
        "A grey stripe",
        "A grey band",
    ]);
    assertEquals(await pictureSize(test, "avatar_id"), [400, 100]);
    assertEquals(await pictureSize(test, "header_id"), [1500, 250]);
});

Deno.test("a picture that isn't an image is refused, and nothing changes", async () => {
    await using test = await openApi();
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]);

    for (const name of ["avatar", "header"]) {
        const refused = await test.update(formOf({ display_name: "Al", [name]: zip }));

        assertEquals([refused.status, refused.body.error_description], [
            422,
            `${name === "avatar" ? "Avatar" : "Header"} must be an image`,
        ]);
    }

    const { body } = await test.get("/api/v1/accounts/alice");
    assertEquals(body.display_name, "");
    assertEquals(await test.ctx.db.selectFrom("media").select("id").execute(), []);
});

Deno.test("an avatar that can't be processed leaves the default one shown", async () => {
    await using test = await openApi();
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode("oops")]);

    await test.update(formOf({ avatar: broken }));
    await drain(test.ctx, queues);

    const { body } = await test.get("/api/v1/accounts/alice");
    assertEquals(body.avatar, "https://social.example/accounts/alice/avatar.png");
});

Deno.test("a description alone describes the current picture, and an empty one clears it", async () => {
    await using test = await openApi();
    await test.update(formOf({
        avatar: png(4, 4),
        avatar_description: "",
        header: png(4, 4),
        header_description: "Old",
    }));
    await drain(test.ctx, queues);
    const [described] = await test.ctx.db.selectFrom("media").select("description")
        .where("description", "is", null).execute();
    assertEquals(described, { description: null });

    const { body } = await test.update(JSON.stringify({
        avatar_description: "New",
        header_description: "",
    }));

    assertEquals([body.avatar_description, body.header_description], ["New", ""]);
    assertEquals(body.avatar.startsWith("https://social.example/media/"), true);
});

Deno.test("a user removes their avatar or header, and their account shows the default", async () => {
    await using test = await openApi();
    await test.update(formOf({ avatar: png(4, 4), header: png(4, 4) }));
    await drain(test.ctx, queues);

    /** Deletes alice's picture `name`, with a token that has `scopes`. */
    const remove = async (name: string, scopes?: Scope[]) => {
        const response = await test.app.request(`/api/v1/profile/${name}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${await tokenFor(test.ctx, "alice", scopes)}` },
        });
        return { status: response.status, body: await response.json() };
    };

    assertEquals((await remove("avatar", ["read"])).status, 403);

    const removed = await remove("avatar");
    assertEquals(removed.status, 200);
    assertEquals(removed.body.avatar, "https://social.example/accounts/alice/avatar.png");
    assertEquals(removed.body.header.startsWith("https://social.example/media/"), true);

    const both = await remove("header");
    assertEquals(both.body.header, "https://social.example/accounts/alice/header.png");
    assertEquals(both.body.avatar, "https://social.example/accounts/alice/avatar.png");

    // Nothing to remove is still removed.
    assertEquals((await remove("header")).status, 200);
});

Deno.test("pictures are at most as large as uploads may be", async () => {
    await using test = await openApi(
        Limits.parse({}),
        MediaLimits.parse({ max_upload_bytes: 100 }),
    );

    const noisy = noise(10);

    for (const name of ["avatar", "header"]) {
        assertEquals((await test.update(formOf({ [name]: noisy }))).status, 422, name);
    }
    assertEquals((await test.update(formOf({ avatar: png(1, 1) }))).status, 200);
});

Deno.test("an avatar and a header as large as uploads may be are taken together", async () => {
    await using test = await openApi(
        Limits.parse({}),
        MediaLimits.parse({ max_upload_bytes: 100_000 }),
    );
    const noisy = noise(150);
    assertEquals(noisy.length > 80_000 && noisy.length <= 100_000, true, `${noisy.length}`);

    assertEquals((await test.update(formOf({ avatar: noisy, header: noisy }))).status, 200);
});

Deno.test("only a token that may write accounts changes a profile", async () => {
    await using test = await openApi();
    const readOnly = await tokenFor(test.ctx, "alice", ["read"]);

    assertEquals((await test.update("{}", "application/json", readOnly)).status, 403);
    assertEquals(
        (await test.update(
            "{}",
            "application/json",
            await tokenFor(test.ctx, "alice", ["write:accounts"]),
        )).status,
        200,
    );
});

Deno.test("accounts show their roles, and their owner the highest, and everything they may do", async () => {
    await using test = await openApi();
    await createRole(test.ctx, "Admin", ["roles"]);
    await createRole(test.ctx, "Mod", []);
    await test.ctx.db.updateTable("roles")
        .set({ visible: true, color: "#ff3838", priority: 100 })
        .where("id", "=", "Admin")
        .execute();
    await giveRole(test.ctx, "alice", "Admin");
    await giveRole(test.ctx, "alice", "Admin", "https://id.example");
    await giveRole(test.ctx, "alice", "Mod");
    const token = await tokenFor(test.ctx, "alice");
    const shown = [{ id: "Admin", name: "Admin", color: "#ff3838" }];

    const own = await test.get("/api/v1/accounts/verify_credentials", token);
    const updated = await test.update("{}", "application/json", token);

    assertEquals(own.body.roles, shown);
    assertEquals(own.body.role, {
        id: "Admin",
        name: "Admin",
        color: "#ff3838",
        permissions: "131072",
        highlighted: true,
        collection_limit: 0,
    });
    assertEquals(updated.body.role.id, "Admin");
    assertEquals(own.body.permissions.length, Permissions.parse({}).default.length + 1);
    assertEquals(own.body.permissions[0], "read:account");
    assertEquals(own.body.permissions.at(-1), "roles");
    assertEquals(updated.body.permissions, own.body.permissions);
    assertEquals((await test.get("/api/v1/accounts/alice")).body.permissions, undefined);
    assertEquals((await test.get("/api/v1/accounts/alice")).body.roles, shown);
    assertEquals((await test.get("/api/v1/accounts/lookup?acct=alice")).body.roles, shown);
});

Deno.test("viewing accounts and changing one's own follow what config permits", async () => {
    await using test = await createTestContext();
    const routes = [...accountRoutes(MediaLimits.parse({}), Limits.parse({})), ...webfingerRoutes];
    const app = createTestApp(test.ctx, routes, {
        checkResponses: true,
        // Only users may view accounts, and nobody may change their profile.
        permissions: { anonymous: [], default: ["read:account"] },
    });
    const alice = await createLocalAccount(test.ctx, "alice");
    const token = await tokenFor(test.ctx, alice);
    const status = async (path: string, init: RequestInit = {}) => {
        const response = await app.request(path, init);
        await response.body?.cancel();
        return response.status;
    };
    const asAlice = { headers: { authorization: `Bearer ${token}` } };

    const views = [
        `/api/v1/accounts/${alice}`,
        "/api/v1/accounts/lookup?acct=alice",
    ];
    for (const path of views) {
        assertEquals(await status(path), 403, path);
        assertEquals(await status(path, asAlice), 200, path);
    }

    // Remote instances find users with WebFinger, whatever clients may view.
    assertEquals(await status("/.well-known/webfinger?resource=acct:alice@social.example"), 200);

    const update = {
        method: "PATCH",
        headers: { ...asAlice.headers, "content-type": "application/json" },
        body: '{"display_name":"Alice"}',
    };
    assertEquals(await status("/api/v1/accounts/update_credentials", update), 403);
    assertEquals(await status("/api/v1/profile", update), 403);
    assertEquals(await status("/api/v1/profile", asAlice), 200);
});

/** Reads or changes alice's profile, with a token that has `scopes`, all of them if omitted. */
const profileOf = async (
    test: Awaited<ReturnType<typeof openApi>>,
    body?: string | FormData,
    scopes?: Scope[],
    type = "application/json",
) => {
    const response = await test.app.request("/api/v1/profile", {
        method: body === undefined ? "GET" : "PATCH",
        body,
        headers: {
            ...typeof body === "string" && { "content-type": type },
            authorization: `Bearer ${await tokenFor(test.ctx, "alice", scopes)}`,
        },
    });
    return { status: response.status, body: await response.json() };
};

Deno.test("a user sees their own profile as they wrote it, with no pictures until they have some", async () => {
    await using test = await openApi();
    await test.update(JSON.stringify({
        display_name: "Alice",
        note: "Hi <you>",
        fields_attributes: [{ name: "Site", value: "a & b" }],
        attribution_domains: ["blog.example"],
    }));
    await featureTag(test.ctx, "alice", "Cats");

    const { status, body } = await profileOf(test);

    assertEquals(status, 200);
    assertEquals(body, {
        id: "alice",
        display_name: "Alice",
        note: "Hi <you>",
        fields: [{ name: "Site", value: "a & b", verified_at: null }],
        formatted_note: "<p>Hi &lt;you&gt;</p>",
        formatted_fields: [{ name: "Site", value: "a &amp; b", verified_at: null }],
        avatar: null,
        avatar_static: null,
        avatar_description: "",
        header: null,
        header_static: null,
        header_description: "",
        locked: false,
        bot: false,
        discoverable: false,
        indexable: false,
        hide_collections: false,
        show_media: true,
        show_media_replies: true,
        show_featured: true,
        attribution_domains: ["blog.example"],
        pronouns: {},
        birthday: null,
        location: null,
        timezone: null,
        avatar_overlays: [],
        avatar_mask: null,
        background: null,
        audio: null,
        featured_tags: [{
            id: body.featured_tags[0].id,
            name: "Cats",
            url: "https://social.example/tags/cats",
            statuses_count: "0",
            last_status_at: null,
        }],
    });
});

Deno.test("only a token that may read accounts sees a profile", async () => {
    await using test = await openApi();

    for (const scopes of [["read"], ["profile"], ["read:accounts"]] as Scope[][]) {
        assertEquals((await profileOf(test, undefined, scopes)).status, 200, `${scopes}`);
    }
    assertEquals((await profileOf(test, undefined, ["read:statuses"])).status, 403);
    assertEquals((await test.get("/api/v1/profile")).status, 401);
    assertEquals((await test.get("/api/v1/profile", await tokenFor(test.ctx, null))).status, 422);
});

Deno.test("a user changes their profile, with the tabs it shows, and gets it back as they wrote it", async () => {
    await using test = await openApi();

    const { status, body } = await profileOf(
        test,
        JSON.stringify({
            display_name: " Alice ",
            note: "Hi\n\nthere",
            locked: true,
            discoverable: true,
            indexable: false,
            hide_collections: true,
            show_media: true,
            show_media_replies: false,
            show_featured: false,
            fields_attributes: [{ name: "Site", value: "x" }],
            avatar_description: "Me",
            // Not Mastodon's here: the defaults for new statuses are changed with the account's.
            source: { privacy: "private" },
        }),
    );

    assertEquals(status, 200);
    assertEquals(body.display_name, "Alice");
    assertEquals(body.note, "Hi\n\nthere");
    assertEquals(body.formatted_note, "<p>Hi</p><p>there</p>");
    assertEquals(body.fields, [{ name: "Site", value: "x", verified_at: null }]);
    assertEquals(
        [body.locked, body.discoverable, body.indexable, body.hide_collections],
        [true, true, false, true],
    );
    assertEquals(
        [body.show_media, body.show_media_replies, body.show_featured],
        [true, false, false],
    );

    const account = await test.get("/api/v1/accounts/alice");
    assertEquals(
        [account.body.show_media, account.body.show_media_replies, account.body.show_featured],
        [true, false, false],
    );

    const own = await test.get(
        "/api/v1/accounts/verify_credentials",
        await tokenFor(test.ctx, "alice"),
    );
    assertEquals(own.body.source.privacy, "public");

    // What is omitted stays.
    const kept = await profileOf(test, JSON.stringify({ show_media: false }));
    assertEquals([kept.body.show_media, kept.body.show_media_replies, kept.body.locked], [
        false,
        false,
        true,
    ]);
    assertEquals(kept.body.show_featured, false);
});

Deno.test("update_credentials leaves the tabs a profile shows as they are", async () => {
    await using test = await openApi();

    const { body } = await test.update(JSON.stringify({ show_media: false, show_featured: false }));

    assertEquals([body.show_media, body.show_media_replies, body.show_featured], [
        true,
        true,
        true,
    ]);
});

Deno.test("a user's pictures are in their profile once processed, and null once removed", async () => {
    await using test = await openApi();

    const added = await profileOf(
        test,
        formOf({
            avatar: png(4, 4),
            avatar_description: "Me",
            header: png(4, 4),
            show_media: "false",
        }),
    );
    assertEquals(added.status, 200);
    assertEquals(added.body.avatar_description, "Me");
    assertEquals(added.body.show_media, false);
    // Until processed, the account shows the default ones.
    assertEquals(added.body.avatar, "https://social.example/accounts/alice/avatar.png");

    await drain(test.ctx, queues);
    const shown = await profileOf(test);
    for (const name of ["avatar", "avatar_static", "header", "header_static"]) {
        assertEquals(shown.body[name].startsWith("https://social.example/media/"), true, name);
    }

    const remove = async (name: string) => {
        const response = await test.app.request(`/api/v1/profile/${name}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${await tokenFor(test.ctx, "alice")}` },
        });
        await response.body?.cancel();
    };

    // Each is null on its own.
    await remove("header");
    const headerless = (await profileOf(test)).body;
    assertEquals([headerless.header, headerless.header_static], [null, null]);
    assertEquals(headerless.avatar.startsWith("https://social.example/media/"), true);
    assertEquals(headerless.avatar_static.startsWith("https://social.example/media/"), true);

    await remove("avatar");
    const { body } = await profileOf(test);
    assertEquals([body.avatar, body.avatar_static, body.header, body.header_static], [
        null,
        null,
        null,
        null,
    ]);
});

Deno.test("a profile is held to the same limits as credentials, and only a token that may write changes it", async () => {
    await using test = await openApi(Limits.parse({ display_name: 5 }));

    assertEquals((await profileOf(test, JSON.stringify({ display_name: "Too long" }))).status, 422);
    assertEquals((await profileOf(test, JSON.stringify({ show_media: "maybe" }))).status, 422);
    assertEquals((await profileOf(test, "{}", ["read"])).status, 403);
    assertEquals((await profileOf(test, "{}", ["write:accounts"])).status, 200);
    assertEquals(
        (await profileOf(test, "show_media=0", ["write"], "application/x-www-form-urlencoded"))
            .body.show_media,
        false,
    );
});

Deno.test("a profile takes an avatar and a header as large as uploads may be, together", async () => {
    await using test = await openApi(
        Limits.parse({}),
        MediaLimits.parse({ max_upload_bytes: 100_000 }),
    );
    const noisy = noise(150);

    assertEquals((await profileOf(test, formOf({ avatar: noisy, header: noisy }))).status, 200);
});

Deno.test("a user sets their pronouns, birthday, location and timezone, and clears them", async () => {
    await using test = await openApi();

    const set = await test.update(JSON.stringify({
        pronouns: { EN: "she/her", "de-at": " sie ", fr: " " },
        birthday: "--02-29",
        location: "Paris",
        timezone: "america/new_york",
    }));

    assertEquals(set.status, 200);
    assertEquals(set.body.pronouns, { en: "she/her", "de-AT": "sie" });
    assertEquals([set.body.birthday, set.body.location, set.body.timezone], [
        "--02-29",
        "Paris",
        "America/New_York",
    ]);

    const form = new FormData();
    form.append("pronouns[en]", "they/them");
    const byForm = await test.update(form);
    assertEquals(byForm.body.pronouns, { en: "they/them" });
    assertEquals(byForm.body.birthday, "--02-29");

    const cleared = await test.update(JSON.stringify({
        pronouns: {},
        birthday: "",
        location: "",
        timezone: "",
    }));
    assertEquals(cleared.body.pronouns, {});
    assertEquals([cleared.body.birthday, cleared.body.location, cleared.body.timezone], [
        null,
        null,
        null,
    ]);
    assertEquals(cleared.body.avatar_overlays, []);
    assertEquals([cleared.body.avatar_mask, cleared.body.background, cleared.body.audio], [
        null,
        null,
        null,
    ]);
});

Deno.test("a birthday is a real date, with or without its year", async () => {
    await using test = await openApi();
    const birthday = async (value: string) =>
        (await test.update(JSON.stringify({ birthday: value }))).status;

    for (
        const refused of ["2024-02-30", "2023-02-29", "2024-13-01", "2024-00-10", "--04-31", "x"]
    ) {
        assertEquals(await birthday(refused), 422, refused);
    }
    for (const accepted of ["2024-02-29", "--02-29", "--12-31", "1999-01-01"]) {
        assertEquals(await birthday(accepted), 200, accepted);
    }
});

Deno.test("a timezone is stored in its canonical form, and an unknown one is refused", async () => {
    await using test = await openApi();

    const canonical = await test.update(JSON.stringify({ timezone: "europe/paris" }));
    assertEquals(canonical.body.timezone, "Europe/Paris");

    for (const unknown of ["Mars/Base", "nowhere", "  ", "+01:00", "-0500"]) {
        const refused = await test.update(JSON.stringify({ timezone: unknown }));
        assertEquals(refused.status, 422, unknown);
    }
    assertEquals((await test.update("{}")).body.timezone, "Europe/Paris");
});

Deno.test("pronouns need valid language tags, and are held to the limits, not counting blank ones", async () => {
    await using test = await openApi(Limits.parse({ fields: 2, field_name: 5 }));

    for (
        const pronouns of [
            { "not a tag": "x" },
            { "": "x" },
            { en: "x".repeat(6) },
            { en: "a", fr: "b", de: "c" },
            { en: 1 },
        ]
    ) {
        const refused = await test.update(JSON.stringify({ pronouns }));
        assertEquals(refused.status, 422, JSON.stringify(pronouns));
    }

    const accepted = await test.update(
        JSON.stringify({ pronouns: { en: "a", fr: "b", de: " " } }),
    );
    assertEquals(accepted.body.pronouns, { en: "a", fr: "b" });
});

Deno.test("a user sets two avatar overlays in a form, and they show in order once processed", async () => {
    await using test = await openApi();
    const form = new FormData();
    form.append("avatar_overlays[]", new File([png(4, 4)], "top.png"));
    form.append("avatar_overlays[]", new File([png(6, 6)], "bottom.png"));
    form.append("avatar_mask", new File([png(4, 4)], "mask.png"));
    form.append(
        "audio",
        new File([new Uint8Array([79, 103, 103, 83])], "a.ogg", {
            type: "audio/ogg",
        }),
    );

    const before = await test.update(form);
    assertEquals(before.status, 200);
    assertEquals([before.body.avatar_overlays, before.body.avatar_mask], [[], null]);

    await drain(test.ctx, queues);
    const { body } = await test.get("/api/v1/accounts/alice");
    const urls: string[] = body.avatar_overlays;

    assertEquals(urls.length, 2);
    assertEquals(new Set(urls).size, 2);
    for (const url of [...urls, body.avatar_mask, body.audio]) {
        assertEquals(url.startsWith("https://social.example/media/"), true, url);
    }
    assertEquals(body.background, null);

    const rows = await test.ctx.db.selectFrom("account_decorations")
        .innerJoin("media", "media.id", "account_decorations.media_id")
        .select(["account_decorations.kind", "account_decorations.position", "media.width"])
        .where("account_decorations.kind", "=", "avatar_overlay")
        .orderBy("account_decorations.position")
        .execute();
    assertEquals(rows.map((row) => [row.position, row.width]), [[0, 4], [1, 6]]);
});

Deno.test("at most four avatar overlays are accepted, and at least one", async () => {
    await using test = await openApi();
    const overlays = (count: number) => {
        const form = new FormData();
        for (let i = 0; i < count; i++) {
            form.append("avatar_overlays[]", new File([png(4, 4)], `${i}.png`));
        }

        return form;
    };

    assertEquals((await test.update(overlays(5))).status, 422);
    assertEquals((await test.update(overlays(4))).status, 200);
    assertEquals((await test.update(overlays(5))).status, 422);
    assertEquals((await test.update(overlays(1))).status, 200);
});

Deno.test("a decoration that isn't an image, or audio that isn't audio, is refused", async () => {
    await using test = await openApi();
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]);

    for (
        const [name, message] of [
            ["avatar_mask", "Avatar mask must be an image"],
            ["background", "Background must be an image"],
            ["audio", "Audio must be audio"],
        ]
    ) {
        const refused = await test.update(formOf({ [name]: zip }));
        assertEquals([refused.status, refused.body.error_description], [422, message], name);
    }
});

Deno.test("a user removes each decoration of their profile, and the others stay", async () => {
    await using test = await openApi();
    const form = formOf({ avatar_mask: png(4, 4), background: png(4, 4) });
    form.append("avatar_overlays[]", new File([png(4, 4)], "o.png"));
    form.append(
        "audio",
        new File([new Uint8Array([79, 103, 103, 83])], "a.ogg", {
            type: "audio/ogg",
        }),
    );
    await test.update(form);
    await drain(test.ctx, queues);

    /** Deletes alice's decoration `name`, with a token that has `scopes`. */
    const remove = async (name: string, scopes?: Scope[]) => {
        const response = await test.app.request(`/api/v1/profile/${name}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${await tokenFor(test.ctx, "alice", scopes)}` },
        });
        return { status: response.status, body: await response.json() };
    };
    /** Which decorations alice's account shows. */
    const shown = (body: Record<string, unknown>) =>
        ["avatar_overlays", "avatar_mask", "background", "audio"].filter((name) => {
            const value = body[name];
            return Array.isArray(value) ? value.length > 0 : value !== null;
        });

    assertEquals((await remove("audio", ["read"])).status, 403);
    assertEquals(shown((await test.get("/api/v1/accounts/alice")).body).length, 4);

    const names = ["avatar_overlays", "avatar_mask", "background", "audio"];
    for (const [index, name] of names.entries()) {
        const removed = await remove(name);

        assertEquals(removed.status, 200, name);
        assertEquals(shown(removed.body), names.slice(index + 1), name);
    }

    // Nothing to remove is still removed.
    assertEquals((await remove("audio")).status, 200);
});

Deno.test("a profile's pronouns, birthday, location, timezone and decorations are changed too", async () => {
    await using test = await openApi();

    const set = await profileOf(
        test,
        JSON.stringify({
            pronouns: { en: "she/her" },
            birthday: "2000-12-31",
            location: "Paris",
            timezone: "europe/paris",
        }),
    );

    assertEquals(set.status, 200);
    assertEquals(
        [set.body.pronouns, set.body.birthday, set.body.location, set.body.timezone],
        [{ en: "she/her" }, "2000-12-31", "Paris", "Europe/Paris"],
    );
    assertEquals(
        [set.body.avatar_overlays, set.body.avatar_mask, set.body.background, set.body.audio],
        [[], null, null, null],
    );

    assertEquals((await profileOf(test, JSON.stringify({ birthday: "2024-02-30" }))).status, 422);
    assertEquals((await profileOf(test, JSON.stringify({ timezone: "Mars/Base" }))).status, 422);
});
