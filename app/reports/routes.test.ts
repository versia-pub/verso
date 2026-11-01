import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { block } from "../graph/blocks.ts";
import { createInstance } from "../instances/testing.ts";
import { createNote } from "../notes/testing.ts";
import { removeNote } from "../notes/removal.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { reportsForAdmin, resolve } from "./reports.ts";
import { reportRoutes } from "./routes.ts";

const rules = [{ text: "Be kind", hint: "" }, { text: "No spam", hint: "" }];

/** alice, bob and carol, local users, and dave, a remote one. */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, reportRoutes({ rules }), { checkResponses: true });
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);
    await createRemoteAccount(test.ctx, "dave", await createInstance(test.ctx, "remote.example"));

    /** Has alice report `body`. */
    const report = async (body: Record<string, unknown>) => {
        const response = await app.request("/api/v1/reports", {
            method: "POST",
            headers: {
                authorization: `Bearer ${await tokenFor(test.ctx, "alice")}`,
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });

        return { status: response.status, body: await response.json() };
    };

    return { ...test, report };
};

Deno.test("a report of an account and its statuses is kept for moderators", async () => {
    await using test = await open();
    const [first, second] = [await createNote(test.ctx, "bob"), await createNote(test.ctx, "bob")];

    const filed = await test.report({
        account_id: "bob",
        status_ids: [second.id, first.id, second.id],
        comment: "Spam",
        category: "spam",
        forward: true,
    });

    assertEquals(filed.status, 200);
    assertEquals({ ...filed.body, target_account: filed.body.target_account.id }, {
        id: filed.body.id,
        action_taken: false,
        action_taken_at: null,
        category: "spam",
        comment: "Spam",
        // Not sent to other instances yet.
        forwarded: false,
        created_at: test.clock.now().toISOString(),
        status_ids: [second.id, first.id],
        rule_ids: null,
        target_account: "bob",
    });
    assertEquals(await reportsForAdmin(test.ctx, false), [{
        id: filed.body.id,
        created_at: test.clock.now().toISOString(),
        reporter: "alice",
        target: "bob",
        category: "spam",
        comment: "Spam",
        status_ids: [second.id, first.id],
        rule_ids: null,
        forwarded: false,
        resolved_at: null,
    }]);
});

Deno.test("a report is of an account that exists, and statuses of its that the reporter sees", async () => {
    await using test = await open();
    const hidden = await createNote(test.ctx, "bob", { visibility: "private" });
    const carols = await createNote(test.ctx, "carol");
    const deleted = await createNote(test.ctx, "bob");
    await removeNote(test.ctx, deleted.id);

    for (
        const body of [
            { account_id: "nobody" },
            { account_id: "bob", status_ids: [hidden.id] },
            { account_id: "bob", status_ids: [carols.id] },
            { account_id: "bob", status_ids: [deleted.id] },
        ]
    ) {
        assertEquals((await test.report(body)).status, 404, JSON.stringify(body));
    }
    assertEquals(await reportsForAdmin(test.ctx, true), []);
});

Deno.test("an account the reporter blocks, or a remote one, can be reported", async () => {
    await using test = await open();
    await block(test.ctx, "alice", "bob");
    const note = await createNote(test.ctx, "bob");

    assertEquals((await test.report({ account_id: "bob", status_ids: [note.id] })).status, 200);
    assertEquals(
        (await test.report({ account_id: "dave" })).body.target_account.acct,
        "dave@remote.example",
    );
});

Deno.test("a report naming rules is a violation, which must name rules that exist", async () => {
    await using test = await open();

    const named = await test.report({ account_id: "bob", category: "spam", rule_ids: ["2", "1"] });
    assertEquals([named.body.category, named.body.rule_ids], ["violation", ["2", "1"]]);
    const other = await test.report({ account_id: "bob" });
    assertEquals([other.body.category, other.body.rule_ids], ["other", null]);

    for (
        const body of [
            { category: "violation" },
            { rule_ids: ["3"] },
            { rule_ids: ["0"] },
            { rule_ids: ["01"] },
            { rule_ids: ["1", "1"] },
        ]
    ) {
        const refused = await test.report({ account_id: "bob", ...body });
        assertEquals([refused.status, refused.body.details], [422, {
            rule_ids: ["does not reference valid rules"],
        }], JSON.stringify(body));
    }
});

Deno.test("a report's comment is at most 1,000 characters", async () => {
    await using test = await open();

    assertEquals((await test.report({ account_id: "bob", comment: "é".repeat(1000) })).status, 200);
    assertEquals((await test.report({ account_id: "bob", comment: "é".repeat(1001) })).status, 422);
});

Deno.test("moderators list the reports no one has dealt with, and resolve them", async () => {
    await using test = await open();
    const first = (await test.report({ account_id: "bob" })).body.id;
    const second = (await test.report({ account_id: "dave" })).body.id;
    await test.ctx.db.deleteFrom("accounts").where("id", "=", "alice").execute();

    test.clock.advance(1000);
    assertEquals(await resolve(test.ctx, first), true);
    const resolvedAt = test.clock.now().toISOString();
    test.clock.advance(1000);
    assertEquals(await resolve(test.ctx, first), true);
    assertEquals(await resolve(test.ctx, "nothing"), false);

    const all = await reportsForAdmin(test.ctx, true);
    assertEquals(
        all.map((report) => [report.id, report.reporter, report.target, report.resolved_at]),
        [[first, null, "bob", resolvedAt], [second, null, "dave@remote.example", null]],
    );
    assertEquals((await reportsForAdmin(test.ctx, false)).map((report) => report.id), [second]);
});
