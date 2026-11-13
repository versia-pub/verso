import { assert, assertEquals } from "@std/assert";
import type { AdminAccount } from "@versia/client-api";
import {
    createLocalAccount,
    createRemoteAccount,
    createRole,
    giveRole,
} from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { createInstance } from "../instances/testing.ts";
import type { Scope } from "../kernel/scopes.ts";
import { fileReport } from "../reports/reports.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { accountDeletionHandler, accountDeletionQueue } from "./account_deletions.ts";
import { adminAccountRoutes } from "./admin_account_routes.ts";
import { silence } from "./silences.ts";
import { suspend } from "./suspensions.ts";

/**
 * Local users alice and bob, dave on remote.example, mod and peer, with the Moderator role, and
 * admin, with the higher Admin role, which may also deal with reports.
 */
const open = async () => {
    const test = await createTestContext();
    const permissions = { anonymous: [], default: ["owner:report" as const] };
    const app = createTestApp(test.ctx, adminAccountRoutes({ permissions }), {
        checkResponses: true,
        permissions,
    });

    for (const id of ["admin", "alice", "bob", "mod", "peer"]) {
        test.clock.advance(1000);
        await createLocalAccount(test.ctx, id);
    }
    await createRemoteAccount(test.ctx, "dave", await createInstance(test.ctx, "remote.example"));

    await createRole(test.ctx, "Moderator", ["accounts"]);
    await createRole(test.ctx, "Admin", ["accounts", "reports"]);
    await test.ctx.db.updateTable("roles").set({ priority: 10 }).where("id", "=", "Moderator")
        .execute();
    await test.ctx.db.updateTable("roles").set({ priority: 20 }).where("id", "=", "Admin")
        .execute();

    await giveRole(test.ctx, "mod", "Moderator");
    await giveRole(test.ctx, "peer", "Moderator");
    await giveRole(test.ctx, "admin", "Admin");

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

    /** Has `by` report `target`. */
    const report = async (by: string, target: string) => {
        const row = await fileReport(test.ctx, by, {
            targetId: target,
            noteIds: [],
            comment: "",
            ruleIds: [],
            forward: false,
        }, 0);
        assert(row);

        return row.id;
    };

    /** The account `id` as its row says. */
    const row = async (id: string) =>
        await test.ctx.db.selectFrom("accounts")
            .select(["silenced_at", "suspended_at", "deleted_at"])
            .where("id", "=", id)
            .executeTakeFirstOrThrow();

    return { ...test, call, report, row };
};

type Test = Awaited<ReturnType<typeof open>>;

/** The ids of the accounts listed at `path`. */
const listed = async (test: Test, path: string) => {
    const { status, body } = await test.call("GET", path);
    assertEquals(status, 200);

    return (body as AdminAccount[]).map((account) => account.id);
};

Deno.test("only moderators with the accounts permission and an admin scope see accounts", async () => {
    await using test = await open();

    assertEquals((await test.call("GET", "/api/v2/admin/accounts", { as: "alice" })).status, 403);
    assertEquals(
        (await test.call("GET", "/api/v1/admin/accounts", { scopes: ["read", "write"] })).status,
        403,
    );
    assertEquals(
        (await test.call("POST", "/api/v1/admin/accounts/dave/action", {
            scopes: ["admin:read:accounts"],
            json: { type: "silence" },
        })).status,
        403,
    );
    assertEquals(
        (await test.call("GET", "/api/v1/admin/accounts/alice", {
            scopes: ["admin:read:accounts"],
        })).status,
        200,
    );
});

Deno.test("v1 lists local accounts that aren't suspended by default, the latest first", async () => {
    await using test = await open();
    await suspend(test.ctx, "bob");

    assertEquals(await listed(test, "/api/v1/admin/accounts"), ["peer", "mod", "alice", "admin"]);
    assertEquals(await listed(test, "/api/v1/admin/accounts?remote=true"), ["dave"]);
    assertEquals(await listed(test, "/api/v1/admin/accounts?suspended=true"), ["bob"]);
});

Deno.test("v1 filters by status, the last flag winning, and by staff", async () => {
    await using test = await open();
    await silence(test.ctx, "alice");
    await suspend(test.ctx, "bob");
    await silence(test.ctx, "bob");

    assertEquals(await listed(test, "/api/v1/admin/accounts?silenced=true"), ["bob", "alice"]);
    assertEquals(
        await listed(test, "/api/v1/admin/accounts?silenced=true&suspended=true"),
        ["bob"],
    );
    assertEquals(await listed(test, "/api/v1/admin/accounts?active=true&pending=true"), []);
    assertEquals(await listed(test, "/api/v1/admin/accounts?staff=true"), ["admin"]);
});

Deno.test("v1 finds remote accounts by domain only with remote", async () => {
    await using test = await open();

    assertEquals(await listed(test, "/api/v1/admin/accounts?by_domain=remote.example"), []);
    assertEquals(
        await listed(test, "/api/v1/admin/accounts?remote=true&by_domain=remote.example"),
        ["dave"],
    );
    assertEquals(
        await listed(test, "/api/v1/admin/accounts?remote=true&by_domain=other.example"),
        [],
    );
});

Deno.test("v2 lists every account by default, and filters by origin and status", async () => {
    await using test = await open();
    await suspend(test.ctx, "bob");
    await silence(test.ctx, "dave");

    assertEquals(
        await listed(test, "/api/v2/admin/accounts"),
        ["peer", "mod", "dave", "bob", "alice", "admin"],
    );
    assertEquals(await listed(test, "/api/v2/admin/accounts?origin=remote"), ["dave"]);
    assertEquals(
        await listed(test, "/api/v2/admin/accounts?origin=local&status=active"),
        ["peer", "mod", "alice", "admin"],
    );
    assertEquals(await listed(test, "/api/v2/admin/accounts?status=suspended"), ["bob"]);
    assertEquals(await listed(test, "/api/v2/admin/accounts?status=silenced"), ["dave"]);
    assertEquals(await listed(test, "/api/v2/admin/accounts?status=pending"), []);
    assertEquals(await listed(test, "/api/v2/admin/accounts?status=sensitized"), []);
});

Deno.test("v2 filters by role and by staff", async () => {
    await using test = await open();

    assertEquals(
        await listed(test, "/api/v2/admin/accounts?role_ids[]=Moderator"),
        ["peer", "mod"],
    );
    assertEquals(
        await listed(test, "/api/v2/admin/accounts?role_ids[]=Moderator&role_ids[]=Admin"),
        ["peer", "mod", "admin"],
    );
    assertEquals(await listed(test, "/api/v2/admin/accounts?permissions=staff"), ["admin"]);
});

Deno.test("names match from their start, ignoring case, with wildcards as themselves", async () => {
    await using test = await open();
    await createLocalAccount(test.ctx, "al_x");
    await test.ctx.db.updateTable("accounts").set({ display_name: "Alice Liddell" })
        .where("id", "=", "alice").execute();

    assertEquals(await listed(test, "/api/v2/admin/accounts?username=AL"), ["alice", "al_x"]);
    assertEquals(await listed(test, "/api/v2/admin/accounts?username=@al_"), ["al_x"]);
    assertEquals(await listed(test, "/api/v2/admin/accounts?username=lic"), []);
    assertEquals(await listed(test, "/api/v2/admin/accounts?username=a%25"), []);
    assertEquals(await listed(test, "/api/v2/admin/accounts?display_name=alice%20l"), ["alice"]);
    assertEquals(await listed(test, "/api/v1/admin/accounts?username=%20%40ali"), ["alice"]);
});

Deno.test("filters Verso can't apply list no accounts", async () => {
    await using test = await open();

    assertEquals(await listed(test, "/api/v1/admin/accounts?email=a"), []);
    assertEquals(await listed(test, "/api/v1/admin/accounts?ip=127.0.0.1"), []);
    assertEquals(await listed(test, "/api/v2/admin/accounts?invited_by=alice"), []);
    assertEquals(await listed(test, "/api/v2/admin/accounts?email=a"), []);
    assertEquals(await listed(test, "/api/v2/admin/accounts?ip=127.0.0.1"), []);
});

Deno.test("accounts are listed a page at a time", async () => {
    await using test = await open();

    const first = await test.call("GET", "/api/v2/admin/accounts?limit=2");

    assertEquals((first.body as AdminAccount[]).map((account) => account.id), ["peer", "mod"]);
    assert(first.link?.includes("max_id=mod"));
    assertEquals(
        await listed(test, "/api/v2/admin/accounts?limit=2&max_id=mod"),
        ["dave", "bob"],
    );
});

Deno.test("an account shows its role, if it is local, and whether it is moderated", async () => {
    await using test = await open();
    await silence(test.ctx, "dave");

    const local = await test.call("GET", "/api/v1/admin/accounts/admin");
    const remote = await test.call("GET", "/api/v1/admin/accounts/dave");

    assertEquals(local.status, 200);
    assertEquals(local.body.role.name, "Admin");
    assertEquals(local.body.domain, null);
    assertEquals(remote.body.role, null);
    assertEquals(remote.body.domain, "remote.example");
    assertEquals(remote.body.silenced, true);
    assertEquals(remote.body.suspended, false);
    assertEquals((await test.call("GET", "/api/v1/admin/accounts/nobody")).status, 404);
});

Deno.test("a moderator silences and suspends remote accounts and users below them", async () => {
    await using test = await open();

    const silenced = await test.call("POST", "/api/v1/admin/accounts/dave/action", {
        json: { type: "silence" },
    });
    const suspended = await test.call("POST", "/api/v1/admin/accounts/alice/action", {
        json: { type: "suspend" },
    });
    const byAdmin = await test.call("POST", "/api/v1/admin/accounts/mod/action", {
        as: "admin",
        json: { type: "silence" },
    });

    assertEquals([silenced.status, silenced.body], [200, {}]);
    assertEquals(suspended.status, 200);
    assertEquals(byAdmin.status, 200);
    assert((await test.row("dave")).silenced_at !== null);
    assertEquals((await test.row("dave")).suspended_at, null);
    assert((await test.row("alice")).suspended_at !== null);
    assertEquals((await test.row("alice")).silenced_at, null);
    assert((await test.row("mod")).silenced_at !== null);
});

Deno.test("a moderator can't act on themselves or on equal or higher roles", async () => {
    await using test = await open();

    for (const target of ["mod", "peer", "admin"]) {
        const response = await test.call("POST", `/api/v1/admin/accounts/${target}/action`, {
            json: { type: "suspend" },
        });

        assertEquals(response.status, 403);
        assertEquals((await test.row(target)).suspended_at, null);
    }
});

Deno.test("an action needs a type Verso has, and a report that exists", async () => {
    await using test = await open();

    for (const type of ["none", "sensitive", "disable"]) {
        const response = await test.call("POST", "/api/v1/admin/accounts/alice/action", {
            json: { type },
        });
        assertEquals(response.status, 422);
    }

    assertEquals(
        (await test.call("POST", "/api/v1/admin/accounts/alice/action", {
            json: { type: "silence", report_id: "missing" },
        })).status,
        404,
    );
    assertEquals(
        (await test.call("POST", "/api/v1/admin/accounts/nobody/action", {
            json: { type: "silence" },
        })).status,
        404,
    );
    assertEquals((await test.row("alice")).silenced_at, null);
});

Deno.test("an action resolves every report about the account, with the reports permission", async () => {
    await using test = await open();
    const [first, second] = [await test.report("bob", "alice"), await test.report("peer", "alice")];
    const other = await test.report("alice", "bob");

    const refused = await test.call("POST", "/api/v1/admin/accounts/alice/action", {
        json: { type: "silence", report_id: first },
    });

    assertEquals(refused.status, 403);
    assertEquals((await test.row("alice")).silenced_at, null);

    const done = await test.call("POST", "/api/v1/admin/accounts/alice/action", {
        as: "admin",
        json: { type: "silence", report_id: first },
    });

    assertEquals(done.status, 200);

    const reports = await test.ctx.db.selectFrom("reports")
        .select(["id", "resolved_at", "resolved_by_account_id"])
        .orderBy("id")
        .execute();
    const byId = new Map(reports.map((report) => [report.id, report]));

    assertEquals(byId.get(first)?.resolved_by_account_id, "admin");
    assertEquals(byId.get(second)?.resolved_by_account_id, "admin");
    assert(byId.get(second)?.resolved_at);
    assertEquals(byId.get(other)?.resolved_at, null);
});

Deno.test("a moderator without the reports permission acts on accounts with no open reports", async () => {
    await using test = await open();
    const id = await test.report("bob", "alice");

    await test.call("POST", `/api/v1/admin/accounts/alice/action`, {
        as: "admin",
        json: { type: "silence" },
    });

    const response = await test.call("POST", "/api/v1/admin/accounts/alice/action", {
        json: { type: "suspend", report_id: id },
    });

    assertEquals(response.status, 200);
    assert((await test.row("alice")).suspended_at !== null);
});

Deno.test("unsilencing and unsuspending lift them, whoever the account is", async () => {
    await using test = await open();
    await silence(test.ctx, "admin");
    await suspend(test.ctx, "dave");

    const unsilenced = await test.call("POST", "/api/v1/admin/accounts/admin/unsilence");
    const unsuspended = await test.call("POST", "/api/v1/admin/accounts/dave/unsuspend");

    assertEquals(unsilenced.status, 200);
    assertEquals(unsilenced.body.silenced, false);
    assertEquals(unsuspended.status, 200);
    assertEquals(unsuspended.body.suspended, false);
    assertEquals((await test.row("dave")).suspended_at, null);
    assertEquals((await test.call("POST", "/api/v1/admin/accounts/nobody/unsilence")).status, 404);
    assertEquals((await test.call("POST", "/api/v1/admin/accounts/nobody/unsuspend")).status, 404);
});

Deno.test("a deleted account can't be unsuspended", async () => {
    await using test = await open();
    await suspend(test.ctx, "alice");
    await test.ctx.db.updateTable("accounts").set({ deleted_at: test.clock.now() })
        .where("id", "=", "alice").execute();

    const response = await test.call("POST", "/api/v1/admin/accounts/alice/unsuspend");

    assertEquals(response.status, 403);
    assert((await test.row("alice")).suspended_at !== null);
});

Deno.test("deleting a suspended user below the moderator queues it, which keeps a tombstone", async () => {
    await using test = await open();
    await suspend(test.ctx, "alice");

    const response = await test.call("DELETE", "/api/v1/admin/accounts/alice");

    assertEquals([response.status, response.body], [200, {}]);
    assertEquals((await test.row("alice")).deleted_at, null);

    const jobs = await test.ctx.db.selectFrom("jobs").selectAll()
        .where("queue", "=", accountDeletionQueue).execute();
    assertEquals(jobs.map((job) => job.payload), [{ accountId: "alice" }]);

    await accountDeletionHandler(test.ctx, jobs[0]);

    assert((await test.row("alice")).deleted_at !== null);
});

Deno.test("only suspended local users below the moderator can be deleted", async () => {
    await using test = await open();
    await suspend(test.ctx, "dave");
    await suspend(test.ctx, "peer");
    await suspend(test.ctx, "admin");

    for (const target of ["bob", "dave", "peer", "admin"]) {
        assertEquals((await test.call("DELETE", `/api/v1/admin/accounts/${target}`)).status, 403);
    }

    assertEquals((await test.call("DELETE", "/api/v1/admin/accounts/nobody")).status, 404);
    assertEquals(
        await test.ctx.db.selectFrom("jobs").selectAll()
            .where("queue", "=", accountDeletionQueue).execute(),
        [],
    );
});

Deno.test("listing staff without any staff roles finds none", async () => {
    await using test = await open();
    await test.ctx.db.updateTable("roles").set({ permissions: ["accounts"] })
        .where("id", "=", "Admin").execute();

    assertEquals(await listed(test, "/api/v2/admin/accounts?permissions=staff"), []);
    assertEquals(await listed(test, "/api/v1/admin/accounts?staff=true"), []);
});

Deno.test("each account's deletion is queued once", async () => {
    await using test = await open();
    await suspend(test.ctx, "alice");
    await suspend(test.ctx, "bob");

    for (const target of ["alice", "alice", "bob"]) {
        assertEquals((await test.call("DELETE", `/api/v1/admin/accounts/${target}`)).status, 200);
    }

    const jobs = await test.ctx.db.selectFrom("jobs").select("payload")
        .where("queue", "=", accountDeletionQueue).execute();

    assertEquals(
        jobs.map((job) => (job.payload as { accountId: string }).accountId).toSorted(),
        ["alice", "bob"],
    );
});
