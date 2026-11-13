import { assert, assertEquals } from "@std/assert";
import type { AdminDomainBlock } from "@versia/client-api";
import { createLocalAccount, createRole, giveRole } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import type { Scope } from "../kernel/scopes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { adminDomainBlockRoutes } from "./admin_domain_block_routes.ts";
import { blockDomain, domainDigest } from "./domain_blocks.ts";

/**
 * An instance that blocks `config.example` and `b.config.example` in config, with local users alice
 * and mod, who has the Federation role.
 */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(
        test.ctx,
        adminDomainBlockRoutes(["config.example", "b.config.example"]),
        { checkResponses: true },
    );

    await createLocalAccount(test.ctx, "alice");
    await createLocalAccount(test.ctx, "mod");
    await createRole(test.ctx, "Federation", ["federation"]);
    await giveRole(test.ctx, "mod", "Federation");

    const call = async (
        method: string,
        path: string,
        options: { as?: string; scopes?: Scope[]; json?: unknown } = {},
    ) => {
        const token = await tokenFor(
            test.ctx,
            options.as ?? "mod",
            options.scopes ?? ["admin:read", "admin:write"],
        );
        const headers = new Headers({ authorization: `Bearer ${token}` });
        if (options.json !== undefined) headers.set("content-type", "application/json");
        const response = await app.request(path, {
            method,
            headers,
            body: options.json === undefined ? undefined : JSON.stringify(options.json),
        });

        return {
            status: response.status,
            link: response.headers.get("link"),
            body: await response.json(),
        };
    };

    /** Blocks `domain` through the API, which must succeed. */
    const create = async (domain: string, notes: Record<string, unknown> = {}) => {
        const { status, body } = await call("POST", "/api/v1/admin/domain_blocks", {
            json: { domain, severity: "suspend", ...notes },
        });
        assertEquals(status, 200, JSON.stringify(body));

        return body as AdminDomainBlock;
    };

    const isBlocked = (domain: string) => test.ctx.federation.isBlocked(test.ctx, domain);

    return { ...test, call, create, isBlocked };
};

type Test = Awaited<ReturnType<typeof open>>;

/** The domains listed at `path`, and its `Link` header. */
const listed = async (test: Test, path: string) => {
    const { status, body, link } = await test.call("GET", path);
    assertEquals(status, 200);

    return { domains: (body as AdminDomainBlock[]).map((block) => block.domain), link };
};

Deno.test("only moderators with the federation permission and an admin scope see blocks", async () => {
    await using test = await open();
    const path = "/api/v1/admin/domain_blocks";

    assertEquals((await test.call("GET", path, { as: "alice" })).status, 403);
    assertEquals((await test.call("GET", path, { scopes: ["read", "write"] })).status, 403);
    assertEquals(
        (await test.call("POST", path, {
            scopes: ["admin:read:domain_blocks"],
            json: { domain: "evil.example", severity: "suspend" },
        })).status,
        403,
    );
    assertEquals(
        (await test.call("GET", path, { scopes: ["admin:read:domain_blocks"] })).status,
        200,
    );
    assertEquals(
        (await test.call("POST", path, {
            scopes: ["admin:write:domain_blocks"],
            json: { domain: "evil.example", severity: "suspend" },
        })).status,
        200,
    );
});

Deno.test("a block is created with its comments, and blocks the domain at once", async () => {
    await using test = await open();

    const block = await test.create("Evil.Example", {
        public_comment: "Spam",
        private_comment: "Seen in reports",
        obfuscate: true,
        reject_media: false,
    });

    assertEquals(block, {
        id: block.id,
        domain: "evil.example",
        digest: await domainDigest("evil.example"),
        created_at: test.clock.now().toISOString(),
        severity: "suspend",
        reject_media: true,
        reject_reports: true,
        private_comment: "Seen in reports",
        public_comment: "Spam",
        obfuscate: true,
    });
    assertEquals(await test.isBlocked("a.evil.example"), true);
    assertEquals((await test.call("GET", `/api/v1/admin/domain_blocks/${block.id}`)).body, block);
});

Deno.test("a block needs severity suspend, and a domain name", async () => {
    await using test = await open();
    const create = (json: unknown) => test.call("POST", "/api/v1/admin/domain_blocks", { json });

    for (const severity of [undefined, "silence", "noop"]) {
        assertEquals((await create({ domain: "evil.example", severity })).status, 422, severity);
    }
    assertEquals((await create({ domain: "not a domain", severity: "suspend" })).status, 422);
    assertEquals(await test.isBlocked("evil.example"), false);
});

Deno.test("a domain already blocked isn't blocked again, by the API or the config file", async () => {
    await using test = await open();
    const first = await test.create("evil.example", { public_comment: "Spam" });
    const create = (domain: string) =>
        test.call("POST", "/api/v1/admin/domain_blocks", {
            json: { domain, severity: "suspend", public_comment: "Again" },
        });

    const twice = await create("evil.example");
    assertEquals(twice.status, 422);
    assertEquals(twice.body, {
        error: "You have already imposed stricter limits on evil.example.",
        existing_domain_block: first,
    });

    const configured = await create("config.example");
    assertEquals(configured.status, 422);
    assertEquals(configured.body.existing_domain_block.id, "config:config.example");

    // Mastodon allows blocking a subdomain as strictly as its parent, and a parent after its
    // subdomain.
    assertEquals((await create("a.evil.example")).status, 200);
    await test.create("a.bad.example");
    assertEquals((await create("bad.example")).status, 200);
});

Deno.test("a block's comments and obfuscate change, and the rest stays", async () => {
    await using test = await open();
    const block = await test.create("evil.example", {
        public_comment: "Spam",
        private_comment: "Seen in reports",
    });
    const update = (json: unknown) =>
        test.call("PUT", `/api/v1/admin/domain_blocks/${block.id}`, { json });

    const changed = await update({ public_comment: "Harassment", obfuscate: true });
    assertEquals(changed.status, 200);
    assertEquals(changed.body, {
        ...block,
        public_comment: "Harassment",
        obfuscate: true,
    });

    const cleared = await update({ private_comment: null, public_comment: null });
    assertEquals(cleared.body, { ...changed.body, private_comment: null, public_comment: null });

    assertEquals(
        (await test.call("GET", `/api/v1/admin/domain_blocks/${block.id}`)).body,
        cleared.body,
    );
    assertEquals((await update({ public_comment: "Spam" })).body.public_comment, "Spam");
    assertEquals((await update({ public_comment: "" })).body.public_comment, null);
    assertEquals((await update({ domain: "other.example" })).body, cleared.body);
    assertEquals((await update({ severity: "silence" })).status, 422);
    assertEquals((await update({ severity: "suspend" })).status, 200);
    assertEquals(
        (await test.call("PUT", "/api/v1/admin/domain_blocks/missing", { json: {} })).status,
        404,
    );
});

Deno.test("deleting a block unblocks the domain at once", async () => {
    await using test = await open();
    const block = await test.create("evil.example");
    await test.create("bad.example");

    assertEquals(await test.isBlocked("evil.example"), true);

    const deleted = await test.call("DELETE", `/api/v1/admin/domain_blocks/${block.id}`);

    assertEquals(deleted, { status: 200, link: null, body: {} });
    assertEquals(await test.isBlocked("evil.example"), false);
    assertEquals(await test.isBlocked("bad.example"), true);
    assertEquals(
        (await test.call("DELETE", `/api/v1/admin/domain_blocks/${block.id}`)).status,
        404,
    );
    assertEquals((await test.call("GET", `/api/v1/admin/domain_blocks/${block.id}`)).status, 404);
});

Deno.test("blocks from the config file are shown, but only the config file changes them", async () => {
    await using test = await open();
    const id = "config:config.example";

    const shown = await test.call("GET", `/api/v1/admin/domain_blocks/${id}`);
    assertEquals(shown.body, {
        id,
        domain: "config.example",
        digest: await domainDigest("config.example"),
        created_at: new Date(0).toISOString(),
        severity: "suspend",
        reject_media: true,
        reject_reports: true,
        private_comment: null,
        public_comment: null,
        obfuscate: false,
    });

    const path = `/api/v1/admin/domain_blocks/${id}`;
    assertEquals((await test.call("PUT", path, { json: { obfuscate: true } })).status, 403);
    assertEquals((await test.call("DELETE", path)).status, 403);
    assertEquals(
        (await test.call("GET", "/api/v1/admin/domain_blocks/config:other.example")).status,
        404,
    );
});

Deno.test("blocks are listed the latest first, then the config file's by domain, in pages", async () => {
    await using test = await open();
    for (const domain of ["a.example", "b.example", "c.example"]) {
        test.clock.advance(1000);
        await test.create(domain);
    }

    const path = "/api/v1/admin/domain_blocks";

    const all = await listed(test, path);
    assertEquals(all.domains, [
        "c.example",
        "b.example",
        "a.example",
        "b.config.example",
        "config.example",
    ]);
    assert(!all.link?.includes('rel="next"'));

    const first = await listed(test, `${path}?limit=2`);
    assertEquals(first.domains, ["c.example", "b.example"]);
    const next = first.link?.match(/<([^>]+)>; rel="next"/)?.[1];
    assert(next);
    const second = await listed(test, new URL(next).pathname + new URL(next).search);
    assertEquals(second.domains, ["a.example", "b.config.example"]);

    // A page boundary inside the config file's blocks.
    const third = await listed(test, `${path}?max_id=config:b.config.example`);
    assertEquals(third.domains, ["config.example"]);
    assertEquals(
        (await listed(test, `${path}?min_id=config:config.example&limit=2`)).domains,
        ["a.example", "b.config.example"],
    );
    assertEquals(
        (await listed(test, `${path}?since_id=config:config.example&limit=2`)).domains,
        ["c.example", "b.example"],
    );

    const [, , a] = (await test.call("GET", path)).body as AdminDomainBlock[];
    assertEquals((await listed(test, `${path}?since_id=${a.id}`)).domains, [
        "c.example",
        "b.example",
    ]);
});

Deno.test("a block made elsewhere is listed with its notes", async () => {
    await using test = await open();
    await blockDomain(test.ctx, "evil.example", { reason: "Spam" });

    const [block] = (await test.call("GET", "/api/v1/admin/domain_blocks?limit=1")).body;

    assertEquals(block.domain, "evil.example");
    assertEquals(block.public_comment, "Spam");
    assertEquals(block.private_comment, null);
    assertEquals(block.obfuscate, false);
});
