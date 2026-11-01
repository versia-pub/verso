import { assertEquals } from "@std/assert";
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import { DeliverJob, deliverQueue } from "../federation/deliver.ts";
import type { Sender } from "../federation/registry.ts";
import { follow } from "../graph/follows.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import { createNote } from "../notes/testing.ts";
import { registry } from "../registry.ts";
import { createTestContext } from "../testing/context.ts";
import { reportType } from "./federation.ts";
import { fileReport, type NewReport, reportsForAdmin } from "./reports.ts";

/**
 * alice and bob, local users; carol, whose replies are reported, on b.example; and dave and erin,
 * whom she replies to, on c.example and b.example.
 */
const open = async () => {
    const test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    for (const [id, domain] of [["carol", "b.example"], ["dave", "c.example"]]) {
        await createRemoteAccount(test.ctx, id, await createInstance(test.ctx, domain));
    }
    await createRemoteAccount(test.ctx, "erin", "b.example");
    await createInstance(test.ctx, "d.example");

    const notes = [
        await createNote(test.ctx, "carol", {
            instance_id: "b.example",
            remote_id: "n1",
            in_reply_to_account_id: "dave",
        }),
        await createNote(test.ctx, "carol", {
            instance_id: "b.example",
            remote_id: "n2",
            in_reply_to_account_id: "erin",
        }),
    ];

    /** Has alice report carol's replies, with `options`. */
    const report = (options: Partial<NewReport>) =>
        fileReport(test.ctx, "alice", {
            targetId: "carol",
            noteIds: notes.map((note) => note.id),
            comment: "Spam",
            category: "spam",
            ruleIds: [],
            forward: true,
            ...options,
        }, 0);

    return { ...test, notes, report };
};

/** The reports queued to be sent, with the instance each is for. */
const sent = async (ctx: Context) =>
    (await ctx.db.selectFrom("jobs").select("payload").where("queue", "=", deliverQueue)
        .orderBy("id").execute())
        .map((job) => DeliverJob.parse(job.payload))
        .map((job): [string, Record<string, unknown>] => [job.domain, JSON.parse(job.body)])
        .filter(([, entity]) => entity.type === "pub.versia:reports/Report");

Deno.test("Verso says it supports reports", () => {
    assertEquals(registry.extensions.includes("pub.versia:reports"), true);
});

Deno.test("a report to forward is sent to the account's instance, without saying who filed it", async () => {
    await using test = await open();

    const report = await test.report({});

    assertEquals(report?.forwarded, true);
    assertEquals(await sent(test.ctx), [["b.example", {
        type: "pub.versia:reports/Report",
        created_at: test.clock.now().toISOString(),
        reported: ["b.example:carol", "b.example:n1", "b.example:n2"],
        tags: ["spam"],
        comment: "Spam",
    }]]);
});

Deno.test("a report is only forwarded if asked, and of a remote account", async () => {
    await using test = await open();

    assertEquals((await test.report({ forward: false }))?.forwarded, false);
    const local = await test.report({ targetId: "bob", noteIds: [] });
    assertEquals(local?.forwarded, false);
    assertEquals(await sent(test.ctx), []);
});

Deno.test("a report is forwarded to the domains asked for, of the account and those it replies to", async () => {
    await using test = await open();

    // Each instance once, from any form of its domain, and only those the report has to do with.
    const report = await test.report({
        forwardToDomains: [" C.Example ", "b.example", "b.example", "d.example", "not a domain"],
        comment: "",
        category: "other",
    });

    assertEquals(report?.forwarded, true);
    const entity = {
        type: "pub.versia:reports/Report",
        created_at: test.clock.now().toISOString(),
        reported: ["b.example:carol", "b.example:n1", "b.example:n2"],
        tags: ["other"],
    };
    assertEquals(await sent(test.ctx), [["b.example", entity], ["c.example", entity]]);
});

Deno.test("a report forwarded only to those the account replies to isn't marked forwarded", async () => {
    await using test = await open();

    const report = await test.report({ forwardToDomains: ["c.example"] });

    assertEquals(report?.forwarded, false);
    assertEquals((await sent(test.ctx)).map(([domain]) => domain), ["c.example"]);
});

Deno.test("a report forwarded to no domains is sent nowhere", async () => {
    await using test = await open();

    assertEquals((await test.report({ forwardToDomains: [] }))?.forwarded, false);
    assertEquals(await sent(test.ctx), []);
});

/** b.example, as the sender of a report. */
const sender: Sender = { domain: "b.example", instanceId: "b.example", fetched: false };

/** A report from b.example of `reported`, anonymous unless it has an `author`. */
const received = (reported: string[], options: Record<string, unknown> = {}) => ({
    type: "pub.versia:reports/Report" as const,
    created_at: "2026-01-01T00:00:00.000Z",
    reported,
    tags: ["harassment", "spam"],
    comment: "Rude",
    ...options,
});

Deno.test("only the author's instance may send a report, or for an anonymous one, any", () => {
    const report = received([]);

    assertEquals(reportType.authority(report, "b.example"), "b.example");
    assertEquals(reportType.authority({ ...report, author: "x" }, "b.example"), "b.example");
    assertEquals(
        reportType.authority({ ...report, author: "c.example:x" }, "b.example"),
        "c.example",
    );
});

Deno.test("a received report of a local account is kept, with the statuses its instance may see", async () => {
    await using test = await open();
    const domain = test.ctx.urls.domain;
    const shown = await createNote(test.ctx, "bob");
    const hidden = await createNote(test.ctx, "bob", { visibility: "private" });
    const followed = await createNote(test.ctx, "alice", { visibility: "private" });
    await follow(test.ctx, "erin", "alice");

    await reportType.receive(
        test.ctx,
        received([
            `${domain}:${hidden.id}`,
            `${domain}:bob`,
            `${domain}:${shown.id}`,
            `${domain}:alice`,
            `${domain}:${followed.id}`,
            `${domain}:nobody`,
        ], { comment: "x".repeat(4999) + "🙂🙂" }),
        sender,
    );

    const reports = await reportsForAdmin(test.ctx, false);
    const common = {
        created_at: test.clock.now().toISOString(),
        reporter: null,
        instance: "b.example",
        category: "spam" as const,
        comment: "x".repeat(4999) + "🙂",
        rule_ids: null,
        forwarded: false,
        resolved_at: null,
    };
    assertEquals(
        reports.map(({ id: _, ...report }) => report).sort((a, b) =>
            (a.target ?? "").localeCompare(b.target ?? "")
        ),
        [
            { ...common, target: "alice", status_ids: [followed.id] },
            { ...common, target: "bob", status_ids: [shown.id] },
        ],
    );
});

Deno.test("a received report of a remote account is kept only for replies to local users", async () => {
    await using test = await open();
    const reply = await createNote(test.ctx, "carol", {
        instance_id: "b.example",
        remote_id: "n3",
        in_reply_to_account_id: "alice",
        // b.example's own, so it needn't be shown to be visible to it.
        visibility: "private",
    });

    // carol's statuses that reply to remote users aren't this instance's to judge.
    await reportType.receive(test.ctx, received(["carol", "n1", "n2"], { tags: [] }), sender);
    assertEquals(await reportsForAdmin(test.ctx, false), []);

    await reportType.receive(test.ctx, received(["carol", "n1", "n3"], { tags: [] }), sender);
    const [report] = await reportsForAdmin(test.ctx, false);
    assertEquals(
        [report?.target, report?.category, report?.status_ids],
        ["carol@b.example", "other", [test.notes[0].id, reply.id]],
    );

    await reportType.receive(test.ctx, received(["carol", "n3"], { tags: ["legal"] }), sender);
    const categories = (await reportsForAdmin(test.ctx, false)).map((each) => each.category);
    assertEquals(categories, ["other", "legal"]);
});

Deno.test("a received report names the accounts it is of, and is stored once", async () => {
    await using test = await open();
    const note = await createNote(test.ctx, "bob");
    const domain = test.ctx.urls.domain;

    // Statuses alone don't say an account is reported, as on Mastodon.
    await reportType.receive(test.ctx, received([`${domain}:${note.id}`]), sender);
    assertEquals(await reportsForAdmin(test.ctx, false), []);

    const report = received([`${domain}:bob`, `${domain}:${note.id}`], { comment: null });
    await reportType.receive(test.ctx, report, sender);
    await reportType.receive(test.ctx, report, sender);
    const reports = await reportsForAdmin(test.ctx, false);
    assertEquals(reports.map((each) => [each.target, each.comment]), [["bob", ""]]);

    // The same report sent again later is another one.
    await reportType.receive(
        test.ctx,
        { ...report, created_at: "2026-01-02T00:00:00.000Z" },
        sender,
    );
    assertEquals((await reportsForAdmin(test.ctx, false)).length, 2);
});
