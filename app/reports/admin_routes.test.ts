import { assert, assertEquals } from "@std/assert";
import type { AdminReport } from "@versia/client-api";
import {
    createLocalAccount,
    createRemoteAccount,
    createRole,
    giveRole,
} from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { createInstance } from "../instances/testing.ts";
import type { Scope } from "../kernel/scopes.ts";
import { deleteLocalAccount } from "../moderation/account_deletions.ts";
import { silence } from "../moderation/silences.ts";
import { suspend } from "../moderation/suspensions.ts";
import { removeNote } from "../notes/removal.ts";
import { createNote } from "../notes/testing.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { adminReportRoutes } from "./admin_routes.ts";
import { insertReport } from "./report_queries.ts";
import { fileReport } from "./reports.ts";

const rules = [
    { text: "Be kind", hint: "", translations: {} },
    { text: "No spam", hint: "Ads too", translations: {} },
];

/** alice and bob, local users, dave, a remote one, and mod, who has the `reports` permission. */
const open = async () => {
    const test = await createTestContext();
    const permissions = { anonymous: [], default: ["owner:report" as const, "feeds" as const] };
    const app = createTestApp(test.ctx, adminReportRoutes({ instance: { rules }, permissions }), {
        checkResponses: true,
        permissions,
    });
    for (const id of ["alice", "bob", "mod"]) await createLocalAccount(test.ctx, id);
    await createRemoteAccount(test.ctx, "dave", await createInstance(test.ctx, "remote.example"));
    await createRole(test.ctx, "Moderator", ["reports"]);
    await giveRole(test.ctx, "mod", "Moderator");

    const call = async (
        method: string,
        path: string,
        options: { as?: string; scopes?: Scope[] } = {},
    ) => {
        const token = await tokenFor(
            test.ctx,
            options.as ?? "mod",
            options.scopes ?? ["admin:read", "admin:write"],
        );
        const response = await app.request(path, {
            method,
            headers: { authorization: `Bearer ${token}` },
        });

        return {
            status: response.status,
            link: response.headers.get("link"),
            body: await response.json(),
        };
    };

    /** Has `by` report `target`, a second after the last report. */
    const report = async (by: string, target: string, noteIds: string[] = []) => {
        test.clock.advance(1000);
        const row = await fileReport(test.ctx, by, {
            targetId: target,
            noteIds,
            comment: "",
            ruleIds: [],
            forward: false,
        }, rules.length);
        assert(row);
        return row.id;
    };

    return { ...test, call, report };
};

/** The ids of the reports listed at `query`. */
const listed = async (test: Awaited<ReturnType<typeof open>>, query = "") => {
    const { status, body } = await test.call("GET", `/api/v1/admin/reports${query}`);
    assertEquals(status, 200);
    return (body as AdminReport[]).map((report) => report.id);
};

Deno.test("only moderators with the reports permission and an admin scope see reports", async () => {
    await using test = await open();
    const id = await test.report("alice", "bob");

    assertEquals((await test.call("GET", "/api/v1/admin/reports", { as: "alice" })).status, 403);
    assertEquals(
        (await test.call("POST", `/api/v1/admin/reports/${id}/resolve`, { as: "alice" })).status,
        403,
    );
    assertEquals(
        (await test.call("GET", "/api/v1/admin/reports", { scopes: ["read", "write"] })).status,
        403,
    );
    assertEquals(
        (await test.call("POST", `/api/v1/admin/reports/${id}/resolve`, {
            scopes: ["admin:read:reports"],
        })).status,
        403,
    );
    assertEquals(
        (await test.call("GET", `/api/v1/admin/reports/${id}`, {
            scopes: ["admin:read:reports"],
        })).status,
        200,
    );
});

Deno.test("a report shows who filed it, of whom, its statuses and rules", async () => {
    await using test = await open();
    const [first, gone] = [await createNote(test.ctx, "bob"), await createNote(test.ctx, "bob")];
    test.clock.advance(1000);
    const row = await fileReport(test.ctx, "alice", {
        targetId: "bob",
        noteIds: [first.id, gone.id],
        comment: "Ads",
        category: "violation",
        ruleIds: ["2"],
        forward: false,
    }, rules.length);
    assert(row);
    await removeNote(test.ctx, gone.id);
    await silence(test.ctx, "bob");

    const { status, body } = await test.call("GET", `/api/v1/admin/reports/${row.id}`);
    assertEquals(status, 200);
    const report = body as AdminReport;
    assertEquals(report.action_taken, false);
    assertEquals(report.action_taken_at, null);
    assertEquals(report.category, "violation");
    assertEquals(report.comment, "Ads");
    assertEquals(report.updated_at, report.created_at);
    assertEquals(report.assigned_account, null);
    assertEquals(report.action_taken_by_account, null);
    assertEquals(report.statuses.map((status) => status.id), [first.id]);
    assertEquals(report.rules, [{ id: "2", ...rules[1] }]);
    assertEquals(report.account?.id, "alice");
    assertEquals(report.account?.account.id, "alice");
    assertEquals(report.account?.role?.id, "-99");
    assertEquals([report.account?.confirmed, report.account?.approved], [true, true]);
    assertEquals(report.account?.disabled, false);
    assertEquals(report.target_account.id, "bob");
    assertEquals(report.target_account.silenced, true);
    assertEquals(report.target_account.suspended, false);
});

Deno.test("a moderator's role carries what all their roles and every user may do", async () => {
    await using test = await open();
    await createRole(test.ctx, "Helper", []);
    await test.ctx.db.updateTable("roles").set({ priority: 10 }).where("id", "=", "Moderator")
        .execute();
    await giveRole(test.ctx, "mod", "Helper");
    const id = await test.report("mod", "alice");

    const { body } = await test.call("GET", `/api/v1/admin/reports/${id}`);
    const reporter = (body as AdminReport).account;
    assertEquals(reporter?.role?.id, "Moderator");
    // `reports` from the role, and `feeds` from what every user may do.
    assertEquals(reporter?.role?.permissions, String(0x10 | 0x100000));
});

Deno.test("a report from another instance has no reporter, and of a remote account no user", async () => {
    await using test = await open();
    await suspend(test.ctx, "dave");
    await insertReport(test.ctx, {
        id: "remote",
        account_id: null,
        instance_id: null,
        digest: null,
        target_account_id: "dave",
        category: "other",
        comment: "",
        note_ids: [],
        rule_ids: null,
        forwarded: false,
        created_at: test.clock.now(),
        resolved_at: null,
        resolved_by_account_id: null,
        updated_at: null,
    });

    const { body } = await test.call("GET", "/api/v1/admin/reports/remote");
    const report = body as AdminReport;
    assertEquals(report.account, null);
    assertEquals(report.rules, []);
    assertEquals(report.target_account.domain, "remote.example");
    assertEquals(report.target_account.role, null);
    assertEquals(report.target_account.suspended, true);
    assertEquals(
        [
            report.target_account.confirmed,
            report.target_account.approved,
            report.target_account.disabled,
        ],
        [null, null, null],
    );
});

Deno.test("reports list the unresolved by default, the latest first, and filter as asked", async () => {
    await using test = await open();
    const [ofBob, ofAlice] = [
        await createNote(test.ctx, "bob"),
        await createNote(test.ctx, "alice"),
    ];
    const a = await test.report("alice", "bob", [ofBob.id]);
    const b = await test.report("bob", "alice", [ofAlice.id]);
    const c = await test.report("alice", "dave");
    await test.call("POST", `/api/v1/admin/reports/${b}/resolve`);

    const all = await test.call("GET", "/api/v1/admin/reports?resolved=true&unresolved=true");
    assertEquals(
        (all.body as AdminReport[]).map((report) => report.statuses.map((status) => status.id)),
        [[], [ofAlice.id], [ofBob.id]],
    );

    assertEquals(await listed(test), [c, a]);
    assertEquals(await listed(test, "?unresolved=true"), [c, a]);
    assertEquals(await listed(test, "?resolved=true"), [b]);
    assertEquals(await listed(test, "?resolved=true&unresolved=true"), [c, b, a]);
    assertEquals(await listed(test, "?account_id=alice"), [c, a]);
    assertEquals(await listed(test, "?target_account_id=bob"), [a]);
    assertEquals(await listed(test, "?resolved=true&unresolved=true&account_id=bob"), [b]);
});

Deno.test("reports are listed in pages", async () => {
    await using test = await open();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await test.report("alice", "bob"));

    const first = await test.call("GET", "/api/v1/admin/reports?limit=2");
    assertEquals((first.body as AdminReport[]).map((report) => report.id), [ids[2], ids[1]]);
    assert(first.link?.includes(`max_id=${ids[1]}`));
    assertEquals(await listed(test, `?max_id=${ids[1]}`), [ids[0]]);
    assertEquals(await listed(test, `?min_id=${ids[0]}&limit=1`), [ids[1]]);
});

Deno.test("resolving a report records who resolved it and when, each time", async () => {
    await using test = await open();
    const id = await test.report("alice", "bob");
    const filed = test.clock.now().toISOString();

    test.clock.advance(1000);
    const resolved = await test.call("POST", `/api/v1/admin/reports/${id}/resolve`);
    assertEquals(resolved.status, 200);
    const report = resolved.body as AdminReport;
    const at = test.clock.now().toISOString();
    assertEquals(
        [report.action_taken, report.action_taken_at, report.updated_at, report.created_at],
        [true, at, at, filed],
    );
    assertEquals(report.action_taken_by_account?.id, "mod");

    test.clock.advance(1000);
    const again = (await test.call("POST", `/api/v1/admin/reports/${id}/resolve`)).body;
    assertEquals((again as AdminReport).action_taken_at, test.clock.now().toISOString());
});

Deno.test("reopening a report clears its resolution, and changes nothing if it is open", async () => {
    await using test = await open();
    const id = await test.report("alice", "bob");
    const filed = test.clock.now().toISOString();

    test.clock.advance(1000);
    const open1 = (await test.call("POST", `/api/v1/admin/reports/${id}/reopen`)).body;
    assertEquals((open1 as AdminReport).updated_at, filed);

    await test.call("POST", `/api/v1/admin/reports/${id}/resolve`);
    test.clock.advance(1000);
    const reopened = await test.call("POST", `/api/v1/admin/reports/${id}/reopen`);
    assertEquals(reopened.status, 200);
    const report = reopened.body as AdminReport;
    assertEquals(
        [report.action_taken, report.action_taken_at, report.action_taken_by_account],
        [false, null, null],
    );
    assertEquals(report.updated_at, test.clock.now().toISOString());
    assertEquals(await listed(test), [id]);
});

Deno.test("an unknown report is not found", async () => {
    await using test = await open();

    for (
        const [method, path] of [
            ["GET", "/api/v1/admin/reports/nope"],
            ["POST", "/api/v1/admin/reports/nope/resolve"],
            ["POST", "/api/v1/admin/reports/nope/reopen"],
        ]
    ) {
        assertEquals((await test.call(method, path)).status, 404);
    }
});

Deno.test("a moderator's resolutions stay when their account is removed", async () => {
    await using test = await open();
    const id = await test.report("alice", "bob");
    await test.call("POST", `/api/v1/admin/reports/${id}/resolve`);

    await deleteLocalAccount(test.ctx, "mod", { tombstone: false });

    const row = await test.ctx.db.selectFrom("reports").selectAll().where("id", "=", id)
        .executeTakeFirstOrThrow();
    assert(row.resolved_at !== null);
    assertEquals(row.resolved_by_account_id, null);
});
