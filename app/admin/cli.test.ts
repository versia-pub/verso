import {
    assert,
    assertEquals,
    assertNotEquals,
    assertRejects,
    assertStringIncludes,
} from "@std/assert";
import { ValidationError } from "@cliffy/command";
import { DatabaseSync } from "node:sqlite";
import {
    createLocalAccount,
    createRemoteAccount,
    createRole,
    giveRole,
} from "../accounts/testing.ts";
import { findAccount } from "../accounts/account_queries.ts";
import { instanceKey } from "../instances/keys.ts";
import { isParked } from "../instances/reachability.ts";
import { postponeGroup } from "../jobs/job_pause_queries.ts";
import { claim, enqueue, giveUp } from "../jobs/job_queries.ts";
import { createInstance } from "../instances/testing.ts";
import { insertAttachments } from "../media/attachment_queries.ts";
import { dayMs } from "../kernel/clock.ts";
import { Config } from "../kernel/config.ts";
import type { Context } from "../kernel/context.ts";
import { createTestContext } from "../testing/context.ts";
import { createNote } from "../notes/testing.ts";
import { createCard } from "../previews/testing.ts";
import { listBlockedDomains } from "../moderation/domain_block_queries.ts";
import { fileReport } from "../reports/reports.ts";
import { refreshTrends } from "../trends/refresh.ts";
import { adminCommand, AdminError } from "./cli.ts";

/** The config the commands are given, which blocks config.example. */
const config = Config.parse({
    domain: "social.example",
    database: { sqlite: ":memory:" },
    media: { storage: { filesystem: "media" } },
    federation: { blocked_domains: ["config.example"] },
});

/** Runs `verso admin` with `args` on `ctx` and `given`, and returns its output. */
const adminWith = async (ctx: Context, given: Config, ...args: string[]) => {
    const printed: string[] = [];
    const paths: string[] = [];

    await adminCommand({
        withContext: (path, work) => {
            paths.push(path);
            return work(ctx, given);
        },
        print: (line) => printed.push(line),
    })
        .globalOption("-c, --config <path:string>", "The config file.", { default: "config.toml" })
        .noExit()
        .parse(args);

    return { printed, paths };
};

/** Runs `verso admin` with `args` on `ctx`, and returns its output. */
const admin = (ctx: Context, ...args: string[]) => adminWith(ctx, config, ...args);

Deno.test("rotating the key prints the new public key, and the old key is gone", async () => {
    await using test = await createTestContext();
    const before = await instanceKey(test.ctx);
    test.clock.advance(1000);

    const { printed, paths } = await admin(
        test.ctx,
        "keys",
        "rotate",
        "--config",
        "/etc/verso.toml",
    );
    const { public_key } = JSON.parse(printed.join(""));

    const keys = await test.ctx.db.selectFrom("instance_keys").select("public_key").execute();
    assertNotEquals(public_key, before.publicKey);
    assertEquals(keys, [{ public_key }]);
    assertEquals((await instanceKey(test.ctx)).publicKey, public_key);
    assertEquals(paths, ["/etc/verso.toml"]);
});

Deno.test("unknown commands and options, and missing commands, are refused", async () => {
    await using test = await createTestContext();

    for (const args of [["keys", "turn"], ["constructor"], ["keys", "rotate", "--now"]]) {
        const error = await assertRejects(() => admin(test.ctx, ...args), ValidationError);
        assertStringIncludes(error.message, args.at(-1) ?? "", args.join(" "));
    }

    for (const args of [[], ["keys"]]) {
        const error = await assertRejects(() => admin(test.ctx, ...args), ValidationError);
        assertEquals(error.message, "Missing command", args.join(" "));
    }
});

Deno.test("roles are created with their permissions, and listed highest priority first", async () => {
    await using test = await createTestContext();

    const created = await admin(
        test.ctx,
        ...["roles", "create", "Admin", "--permissions", "roles,owner:account,roles"],
        ...["--priority", "100"],
    );
    await admin(test.ctx, "roles", "create", " Accounts ");
    const listed = await admin(test.ctx, "roles", "list");

    const role = JSON.parse(created.printed.join(""));
    assertEquals(
        [role.name, role.permissions, role.priority],
        ["Admin", ["roles", "owner:account"], 100],
    );
    assertEquals(
        JSON.parse(listed.printed.join("")).map((role: { name: string; priority: number }) => [
            role.name,
            role.priority,
        ]),
        [["Admin", 100], ["Accounts", 0]],
    );
});

Deno.test("roles need a free name, known permissions and a whole priority", async () => {
    await using test = await createTestContext();
    await admin(test.ctx, "roles", "create", "Admin");

    await assertRejects(
        () => admin(test.ctx, "roles", "create", "admin"),
        AdminError,
        "There is already a role named admin",
    );

    for (
        const [args, message] of [
            [[], "Missing argument"],
            [[" "], "A role needs a name"],
            [["x".repeat(129)], "Must be at most 128 characters"],
            [["A", "--permissions", "fly"], "fly"],
            [["A", "--priority", "high"], "high"],
            [["A", "--colour", "red"], "colour"],
        ] as const
    ) {
        await assertRejects(
            () => admin(test.ctx, "roles", "create", ...args),
            ValidationError,
            message,
        );
    }
});

/** Who has which role, and from whom. */
const assignments = async (ctx: Context) =>
    (await ctx.db.selectFrom("account_roles").select(["account_id", "role_id", "issuer"]).execute())
        .map((row) => `${row.account_id}: ${row.role_id} from ${row.issuer ?? "an admin"}`)
        .sort();

Deno.test("an admin gives a role once, by names in any case", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createRole(test.ctx, "Admin", ["roles"]);
    await giveRole(test.ctx, "alice", "Admin", "https://id.example");

    const first = await admin(test.ctx, "users", "grant-role", "ALICE", "admin");
    const again = await admin(test.ctx, "users", "grant-role", "alice", "Admin");

    assertEquals(JSON.parse(first.printed.join("")), {
        username: "alice",
        role: "Admin",
        changed: true,
    });
    assertEquals(JSON.parse(again.printed.join("")).changed, false);
    assertEquals(await assignments(test.ctx), [
        "alice: Admin from an admin",
        "alice: Admin from https://id.example",
    ]);
});

Deno.test("an admin takes away only the roles an admin gave", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createLocalAccount(test.ctx, "bob");
    await createRole(test.ctx, "Admin", ["roles"]);
    await giveRole(test.ctx, "alice", "Admin");
    await giveRole(test.ctx, "alice", "Admin", "https://id.example");
    await giveRole(test.ctx, "bob", "Admin");
    await createRole(test.ctx, "Mod", []);
    await giveRole(test.ctx, "alice", "Mod");

    const first = await admin(test.ctx, "users", "revoke-role", "alice", "Admin");
    const again = await admin(test.ctx, "users", "revoke-role", "alice", "Admin");

    assertEquals(JSON.parse(first.printed.join("")).changed, true);
    assertEquals(JSON.parse(again.printed.join("")).changed, false);
    assertEquals(await assignments(test.ctx), [
        "alice: Admin from https://id.example",
        "alice: Mod from an admin",
        "bob: Admin from an admin",
    ]);
});

Deno.test("roles are only given to local accounts and roles that exist", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createRole(test.ctx, "Admin", []);
    await test.ctx.db.insertInto("accounts")
        .values({
            id: "remote-bob",
            username: "bob",
            instance_id: await createInstance(test.ctx, "b.example"),
            remote_id: "bob",
            created_at: test.ctx.clock.now(),
        })
        .execute();

    for (const command of ["grant-role", "revoke-role"]) {
        for (
            const [username, role, message] of [
                ["carol", "Admin", "There is no local account named carol"],
                ["bob", "Admin", "There is no local account named bob"],
                ["alice", "Mod", "There is no role named Mod"],
            ]
        ) {
            await assertRejects(
                () => admin(test.ctx, "users", command, username, role),
                AdminError,
                message,
            );
        }

        await assertRejects(() => admin(test.ctx, "users", command, "alice"), ValidationError);
    }

    assertEquals(await assignments(test.ctx), []);
});

Deno.test("an admin blocks and unblocks a domain once, with a reason", async () => {
    await using test = await createTestContext();
    const run = async (...args: string[]) =>
        JSON.parse((await admin(test.ctx, "domains", ...args)).printed.join(""));

    assertEquals(await run("block", "Evil.Example", "--reason", "Spam"), {
        domain: "evil.example",
        changed: true,
        by_config: false,
    });
    assertEquals((await run("block", "evil.example")).changed, false);
    assertEquals(await run("list"), [
        { domain: "config.example", source: "config" },
        {
            id: (await listBlockedDomains(test.ctx))[0].id,
            domain: "evil.example",
            reason: "Spam",
            private_comment: null,
            obfuscate: false,
            created_at: test.clock.now().toISOString(),
            source: "admin",
        },
    ]);

    assertEquals(await run("unblock", "evil.example"), {
        domain: "evil.example",
        changed: true,
        by_config: false,
    });
    assertEquals((await run("unblock", "evil.example")).changed, false);
    assertEquals(await run("list"), [{ domain: "config.example", source: "config" }]);
});

Deno.test("a domain the config blocks says so, since only the config file unblocks it", async () => {
    await using test = await createTestContext();
    const run = async (...args: string[]) =>
        JSON.parse((await admin(test.ctx, "domains", ...args)).printed.join(""));

    assertEquals(await run("unblock", "a.config.example"), {
        domain: "a.config.example",
        changed: false,
        by_config: true,
    });
    assertEquals((await run("block", "config.example")).by_config, true);
});

Deno.test("a domain to block must be a domain name", async () => {
    await using test = await createTestContext();

    for (const bad of ["192.0.2.1", "evil.example:8443", "not a domain"]) {
        const error = await assertRejects(
            () => admin(test.ctx, "domains", "block", bad),
            ValidationError,
        );
        assertStringIncludes(error.message, "isn't a domain name", bad);
    }
});

Deno.test("any status is deleted by its id, and unknown ones refused", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    const note = await createNote(test.ctx, "alice");

    const deleted = await admin(test.ctx, "statuses", "delete", note.id);
    assertEquals(JSON.parse(deleted.printed.join("")), { id: note.id, deleted: true });

    const error = await assertRejects(
        () => admin(test.ctx, "statuses", "delete", note.id),
        AdminError,
    );
    assertEquals(error.message, `There is no status ${note.id}`);
});

Deno.test("remote statuses older than --days are pruned, and followed accounts' with --clean-followed", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "b.example");
    await createLocalAccount(test.ctx, "alice");
    await createRemoteAccount(test.ctx, "carol", "b.example");
    await createRemoteAccount(test.ctx, "dave", "b.example");
    await test.ctx.db.insertInto("follows")
        .values({
            id: test.ctx.ids(),
            follower_id: "alice",
            followee_id: "carol",
            accepted: true,
            created_at: test.clock.now(),
        })
        .execute();
    const remote = (accountId: string) => {
        const id = test.ctx.ids();
        return createNote(test.ctx, accountId, { id, instance_id: "b.example", remote_id: id });
    };
    await remote("carol");
    await remote("dave");
    test.clock.advance(10 * dayMs);
    await remote("dave");
    test.clock.advance(80 * dayMs + 1);

    const pruned = async (...args: string[]) =>
        JSON.parse((await admin(test.ctx, "statuses", "prune", ...args)).printed.join(""));
    assertEquals(await pruned(), { deleted: 1 });
    assertEquals(await pruned("--days", "90"), { deleted: 0 });
    assertEquals(await pruned("--clean-followed"), { deleted: 1 });
    assertEquals(await pruned("--days", "80"), { deleted: 1 });
    assertEquals(await test.ctx.db.selectFrom("notes").select("id").execute(), []);

    const error = await assertRejects(() => pruned("--days", "0"), AdminError);
    assertEquals(error.message, "--days must be at least 1");
});

Deno.test("remote accounts fetched more than --days ago that nothing refers to are pruned", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "b.example");
    await createLocalAccount(test.ctx, "alice");
    await createRemoteAccount(test.ctx, "carol", "b.example");
    await createRemoteAccount(test.ctx, "dave", "b.example");
    test.clock.advance(10 * dayMs);
    await createRemoteAccount(test.ctx, "erin", "b.example");
    await createNote(test.ctx, "alice", {}, ["carol"]);
    test.clock.advance(80 * dayMs + 1);

    const pruned = async (...args: string[]) =>
        JSON.parse((await admin(test.ctx, "accounts", "prune", ...args)).printed.join(""));
    assertEquals(await pruned(), { deleted: 1 });
    assertEquals(await pruned("--days", "80"), { deleted: 1 });
    assertEquals(
        (await test.ctx.db.selectFrom("accounts").select("id").orderBy("id").execute())
            .map((row) => row.id),
        ["alice", "carol"],
    );

    const error = await assertRejects(() => pruned("--days", "0"), AdminError);
    assertEquals(error.message, "--days must be at least 1");
});

Deno.test("remote attachments cached more than --days ago lose their files", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");
    const cached = (id: string, daysAgo = 0) =>
        test.ctx.db.insertInto("media").values({
            id,
            instance_id: "b.example",
            url: `https://b.example/${id}.png`,
            media_type: "image/png",
            sha256: "f".repeat(64),
            cached_type: "image/png",
            processed_at: new Date(test.clock.now().getTime() - daysAgo * dayMs),
            created_at: test.clock.now(),
        }).execute();
    await cached("old");
    test.clock.advance(10 * dayMs);
    await cached("recent");
    await insertAttachments(test.ctx, (await createNote(test.ctx, "carol")).id, ["old", "recent"]);
    test.clock.advance(7 * dayMs + 1);
    await cached("fresh", 3);
    await insertAttachments(test.ctx, (await createNote(test.ctx, "carol")).id, ["fresh"]);

    const pruned = async (...args: string[]) =>
        JSON.parse((await admin(test.ctx, "media", "prune", ...args)).printed.join(""));
    assertEquals(await pruned("--days", "8"), { cleared: 1 });
    assertEquals(await pruned(), { cleared: 1 });
    assertEquals(await pruned("--days", "1"), { cleared: 1 });
    assertEquals(
        await test.ctx.db.selectFrom("media").select(["id", "sha256"]).orderBy("id").execute(),
        [{ id: "fresh", sha256: null }, { id: "old", sha256: null }, {
            id: "recent",
            sha256: null,
        }],
    );

    const error = await assertRejects(() => pruned("--days", "0"), AdminError);
    assertEquals(error.message, "--days must be at least 1");
});

Deno.test("preview cards fetched more than --days ago lose their images, and unshown ones go", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    const shown = await createCard(test.ctx, [(await createNote(test.ctx, "alice")).id]);
    await createCard(test.ctx, []);
    test.clock.advance(10 * dayMs);
    await createCard(test.ctx, []);
    test.clock.advance(170 * dayMs + 1);

    const pruned = async (...args: string[]) =>
        JSON.parse((await admin(test.ctx, "preview-cards", "prune", ...args)).printed.join(""));
    assertEquals(await pruned(), { deleted: 1, cleared: 1 });
    assertEquals(await pruned("--days", "170"), { deleted: 1, cleared: 0 });
    assertEquals(
        await test.ctx.db.selectFrom("preview_cards").select(["id", "image_id"]).execute(),
        [{ id: shown, image_id: null }],
    );

    const error = await assertRejects(() => pruned("--days", "13"), AdminError);
    assertEquals(error.message, "--days must be at least 14");
});

Deno.test("accounts are suspended and unsuspended once, local or remote, and unknown ones refused", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");
    const json = async (...args: string[]) =>
        JSON.parse((await admin(test.ctx, "accounts", ...args)).printed.join(""));

    assertEquals(await json("suspend", "alice"), {
        account: "alice",
        suspended: true,
        changed: true,
    });
    assertEquals(await json("suspend", "@alice"), {
        account: "alice",
        suspended: true,
        changed: false,
    });
    assertEquals(await json("suspend", "carol@b.example"), {
        account: "carol@b.example",
        suspended: true,
        changed: true,
    });
    assertEquals((await findAccount(test.ctx, "carol"))?.suspended_at, test.clock.now());

    assertEquals(await json("unsuspend", "carol@b.example"), {
        account: "carol@b.example",
        suspended: false,
        changed: true,
    });
    assertEquals(await json("unsuspend", "carol@b.example"), {
        account: "carol@b.example",
        suspended: false,
        changed: false,
    });
    assertEquals((await findAccount(test.ctx, "carol"))?.suspended_at, null);
    assertNotEquals((await findAccount(test.ctx, "alice"))?.suspended_at, null);

    for (const acct of ["nobody", "nobody@b.example", "not an address"]) {
        const error = await assertRejects(() => json("suspend", acct), AdminError);
        assertEquals(error.message, `There is no account ${acct}`);
    }
});

Deno.test("local accounts are deleted, kept empty unless asked not to, and remote ones refused", async () => {
    await using test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "carol", "b.example");
    const json = async (...args: string[]) =>
        JSON.parse((await admin(test.ctx, "accounts", ...args)).printed.join(""));

    const deleted = { account: "alice", deleted: true, tombstone: true };
    assertEquals(await json("delete", "alice"), { ...deleted, changed: true });
    assertEquals(await json("delete", "alice"), { ...deleted, changed: false });
    assertEquals((await findAccount(test.ctx, "alice"))?.deleted_at, test.clock.now());

    assertEquals(await json("delete", "bob", "--no-tombstone"), {
        account: "bob",
        deleted: true,
        tombstone: false,
        changed: true,
    });
    assertEquals(await findAccount(test.ctx, "bob"), undefined);

    const error = await assertRejects(() => json("delete", "carol@b.example"), AdminError);
    assertEquals(
        error.message,
        "carol@b.example is a remote account, which can be suspended but not deleted",
    );
    assertEquals((await findAccount(test.ctx, "carol"))?.suspended_at, null);
});

Deno.test("accounts are silenced and unsilenced once", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    const json = async (...args: string[]) =>
        JSON.parse((await admin(test.ctx, "accounts", ...args)).printed.join(""));

    assertEquals(await json("silence", "alice"), {
        account: "alice",
        silenced: true,
        changed: true,
    });
    assertEquals(await json("silence", "alice"), {
        account: "alice",
        silenced: true,
        changed: false,
    });
    assertEquals((await findAccount(test.ctx, "alice"))?.silenced_at, test.clock.now());
    assertEquals((await findAccount(test.ctx, "alice"))?.suspended_at, null);

    assertEquals(await json("unsilence", "alice"), {
        account: "alice",
        silenced: false,
        changed: true,
    });
    assertEquals(await json("unsilence", "alice"), {
        account: "alice",
        silenced: false,
        changed: false,
    });
    assertEquals((await findAccount(test.ctx, "alice"))?.silenced_at, null);
});

Deno.test("reports are listed until they are resolved, and unknown ones refused", async () => {
    await using test = await createTestContext();
    for (const id of ["alice", "bob"]) await createLocalAccount(test.ctx, id);
    const report = await fileReport(test.ctx, "alice", {
        targetId: "bob",
        noteIds: [],
        comment: "Rude",
        ruleIds: [],
        forward: false,
    }, 0);

    const listed = await admin(test.ctx, "reports", "list");
    assertEquals(JSON.parse(listed.printed.join("")).map((each: { id: string }) => each.id), [
        report?.id,
    ]);

    const resolved = await admin(test.ctx, "reports", "resolve", report?.id ?? "");
    assertEquals(JSON.parse(resolved.printed.join("")), { id: report?.id, resolved: true });
    assertEquals((await admin(test.ctx, "reports", "list")).printed, ["[]"]);
    const all = await admin(test.ctx, "reports", "list", "--all");
    assertEquals(JSON.parse(all.printed.join("")).map((each: { id: string }) => each.id), [
        report?.id,
    ]);

    const error = await assertRejects(() => admin(test.ctx, "reports", "resolve", "x"), AdminError);
    assertEquals(error.message, "There is no report x");
});

Deno.test("announcements are made, changed, published, taken down and deleted", async () => {
    await using test = await createTestContext();
    const now = test.clock.now().toISOString();
    const json = (printed: string[]) => JSON.parse(printed.join(""));

    const made = json((await admin(test.ctx, "announcements", "create", "Hi")).printed);
    assertEquals(made, {
        id: made.id,
        text: "Hi",
        published: true,
        published_at: now,
        scheduled_at: null,
        starts_at: null,
        ends_at: null,
        all_day: false,
        created_at: now,
        updated_at: now,
    });
    const event = json(
        (await admin(
            test.ctx,
            "announcements",
            "create",
            "Party",
            "--starts-at",
            "2026-02-01",
            "--ends-at",
            "2026-02-02T12:00Z",
            "--all-day",
            "--scheduled-at",
            "2026-01-15",
        )).printed,
    );
    assertEquals([
        event.published,
        event.scheduled_at,
        event.starts_at,
        event.ends_at,
        event.all_day,
    ], [
        false,
        "2026-01-15T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
        "2026-02-02T12:00:00.000Z",
        true,
    ]);

    const changed = json(
        (await admin(
            test.ctx,
            "announcements",
            "update",
            event.id,
            "--text",
            "Gathering",
            "--all-day",
            "false",
            "--starts-at",
            "none",
            "--ends-at",
            "none",
        )).printed,
    );
    assertEquals([changed.text, changed.all_day, changed.starts_at, changed.ends_at], [
        "Gathering",
        false,
        null,
        null,
    ]);
    assertEquals(
        json((await admin(test.ctx, "announcements", "publish", event.id)).printed).published,
        true,
    );
    assertEquals(
        json((await admin(test.ctx, "announcements", "unpublish", made.id)).printed).published,
        false,
    );
    assertEquals(
        json((await admin(test.ctx, "announcements", "list")).printed).map((each: { id: string }) =>
            each.id
        ),
        [made.id, event.id],
    );
    assertEquals(json((await admin(test.ctx, "announcements", "delete", made.id)).printed), {
        id: made.id,
        deleted: true,
    });

    for (
        const args of [["publish", "x"], ["unpublish", "x"], ["update", "x"], ["delete", made.id]]
    ) {
        const error = await assertRejects(
            () => admin(test.ctx, "announcements", ...args),
            AdminError,
        );
        assertStringIncludes(error.message, "There is no announcement");
    }
    const invalid = await assertRejects(
        () => admin(test.ctx, "announcements", "create", "Hi", "--starts-at", "2026-02-01"),
        AdminError,
    );
    assertEquals(invalid.message, "An event needs both when it starts and when it ends");
    const halfEvent = await assertRejects(
        () => admin(test.ctx, "announcements", "update", event.id, "--starts-at", "2026-02-01"),
        AdminError,
    );
    assertEquals(halfEvent.message, "An event needs both when it starts and when it ends");
    for (const time of ["tomorrow", "2026-13-40", "1700000000", "2026", "2026-11"]) {
        await assertRejects(
            () => admin(test.ctx, "announcements", "create", "Hi", "--scheduled-at", time),
            ValidationError,
        );
    }
});

Deno.test("trending hashtags and accounts are approved and rejected, and listed with their state", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "remote.example");
    await createRemoteAccount(test.ctx, "rem", "remote.example");
    const users = ["alice", "b", "c", "d", "e"];
    for (const id of users) await createLocalAccount(test.ctx, id);
    await test.ctx.db.updateTable("accounts").set({ discoverable: true }).execute();
    for (const id of users) await createNote(test.ctx, id, { likes_count: 5 }, [], ["cats"]);
    await createNote(test.ctx, "rem", { likes_count: 5 });
    await refreshTrends(test.ctx);

    const listed = async () =>
        JSON.parse((await admin(test.ctx, "trends", "list")).printed.join(""));
    const states = async () => {
        const { tags, accounts } = await listed();
        return {
            tags: tags.map((tag: { name: string; state: string }) => [tag.name, tag.state]),
            accounts: accounts.map((each: { acct: string; state: string }) => [
                each.acct,
                each.state,
            ]),
        };
    };
    assertEquals((await states()).tags, [["cats", "pending"]]);
    assertEquals((await states()).accounts.length, 6);
    assertEquals((await states()).accounts[0][1], "pending");

    const approved = await admin(test.ctx, "trends", "approve-tag", "#Cats");
    assertEquals(JSON.parse(approved.printed.join("")), { tag: "cats", trendable: true });
    assertEquals((await states()).tags, [["cats", "approved"]]);
    await admin(test.ctx, "trends", "reject-tag", "cats");
    assertEquals((await states()).tags, [["cats", "rejected"]]);

    await admin(test.ctx, "trends", "approve-account", "alice");
    await admin(test.ctx, "trends", "reject-account", "@rem@remote.example");
    const { accounts } = await states();
    assertEquals(accounts.find(([acct]: string[]) => acct === "alice")[1], "approved");
    assertEquals(accounts.find(([acct]: string[]) => acct === "rem@remote.example")[1], "rejected");
    assertEquals(accounts.find(([acct]: string[]) => acct === "b")[1], "pending");
});

Deno.test("what trends is approved by default when the config says so", async () => {
    await using test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await test.ctx.db.updateTable("accounts").set({ discoverable: true }).execute();
    await createNote(test.ctx, "alice", { likes_count: 5 });
    await refreshTrends(test.ctx);

    const printed: string[] = [];
    await adminCommand({
        withContext: (_path, work) =>
            work(test.ctx, Config.parse({ ...config, instance: { trendable_by_default: true } })),
        print: (line) => printed.push(line),
    })
        .globalOption("-c, --config <path:string>", "The config file.", { default: "config.toml" })
        .noExit()
        .parse(["trends", "list"]);

    assertEquals(JSON.parse(printed.join("")).accounts[0].state, "approved");
});

Deno.test("trends can't be decided for hashtags and accounts there aren't", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "remote.example");
    await createRemoteAccount(test.ctx, "rem", "remote.example");

    const tag = await assertRejects(
        () => admin(test.ctx, "trends", "approve-tag", "nothing"),
        AdminError,
    );
    assertEquals(tag.message, "No status has used the hashtag nothing");

    for (
        const account of [
            "nobody",
            "nobody@remote.example",
            "nobody@unknown.example",
            "a@b@c",
            "rem@remote.example@x",
        ]
    ) {
        const error = await assertRejects(
            () => admin(test.ctx, "trends", "reject-account", account),
            AdminError,
        );
        assertEquals(error.message, `There is no account named ${account}`);
    }
});

Deno.test("trending links and their websites are approved and rejected, and listed with their state", async () => {
    await using test = await createTestContext();
    const users = ["alice", "b", "c", "d", "e"];
    for (const id of users) await createLocalAccount(test.ctx, id);
    const notes = [];
    for (const id of users) notes.push((await createNote(test.ctx, id)).id);
    await createCard(test.ctx, notes, { url: "https://news.example/story", title: "A story" });
    await refreshTrends(test.ctx);

    const listed = async () =>
        JSON.parse((await admin(test.ctx, "trends", "list")).printed.join(""));
    const link = async () => (await listed()).links;
    assertEquals(await link(), [{
        url: "https://news.example/story",
        title: "A story",
        score: 16,
        state: "pending",
    }]);

    const domain = await admin(test.ctx, "trends", "approve-domain", "News.Example");
    assertEquals(JSON.parse(domain.printed.join("")), { domain: "news.example", trendable: true });
    assertEquals((await link())[0].state, "approved");
    assertEquals((await listed()).domains, [{ domain: "news.example", trendable: true }]);

    await admin(test.ctx, "trends", "reject-link", "https://news.example/story");
    assertEquals((await link())[0].state, "rejected");
    const approved = await admin(test.ctx, "trends", "approve-link", "https://news.example/story");
    assertEquals(
        JSON.parse(approved.printed.join("")),
        { url: "https://news.example/story", trendable: true },
    );
    await admin(test.ctx, "trends", "reject-domain", "news.example");
    assertEquals((await link())[0].state, "approved");

    const missing = await assertRejects(
        () => admin(test.ctx, "trends", "approve-link", "https://news.example/other"),
        AdminError,
    );
    assertEquals(missing.message, "Verso has no preview card at https://news.example/other");
    const invalid = await assertRejects(
        () => admin(test.ctx, "trends", "approve-domain", "not a domain"),
        AdminError,
    );
    assertEquals(invalid.message, "not a domain is not a domain name");
});

Deno.test("dead letters are listed, retried and purged, and those that can't run again refused", async () => {
    await using test = await createTestContext();
    const dead = async (queue: string, n: number) => {
        const id = await enqueue(test.ctx, { queue, payload: { n }, maxAttempts: 1 });
        assert(id);
        const [job] = await claim(test.ctx, { queue, worker: "w1", limit: 1, leaseMs: 60_000 });
        await giveUp(test.ctx, job, `failure ${n}`);
        test.clock.advance(1000);
        return id;
    };
    const one = await dead("notify", 1);
    const two = await dead("notify", 2);
    const delivery = await dead("versia-deliver", 3);
    await dead("unknown", 4);
    const waiting = await enqueue(test.ctx, { queue: "notify", payload: { n: 5 } });
    assert(waiting);
    const run = async (...args: string[]) =>
        JSON.parse((await admin(test.ctx, "jobs", ...args)).printed.join(""));

    assertEquals(await run("list"), [
        { queue: "notify", waiting: 1, oldest_due: test.clock.now().toISOString(), dead: 2 },
        { queue: "unknown", waiting: 0, oldest_due: null, dead: 1 },
        { queue: "versia-deliver", waiting: 0, oldest_due: null, dead: 1 },
    ]);
    const listed = await run("dead", "--queue", "notify", "--limit", "1");
    assertEquals([listed.length, listed[0].id, listed[0].last_error], [1, two, "failure 2"]);
    assertEquals((await run("dead")).length, 4);

    const refused = async (message: string, ...args: string[]) => {
        const error = await assertRejects(() => run(...args), AdminError);
        assertEquals(error.message, message);
    };
    await refused("--limit must be at least 1", "dead", "--limit", "0");
    await refused("unknown isn't a queue Verso runs", "retry", "--queue", "unknown");
    await refused(
        "versia-deliver's dead letters keep only a summary of their payload, so they can't be " +
            "retried",
        "retry",
        one,
        delivery,
    );
    await refused(`Not dead letters: ${waiting}`, "retry", one, waiting);
    for (const args of [["retry"], ["purge"], ["retry", one, "--queue", "notify"]]) {
        await assertRejects(() => run(...args), ValidationError);
    }

    assertEquals(await run("retry", one), { retried: 1 });
    assertEquals(await run("retry", "--queue", "notify"), { retried: 1 });
    assertEquals(await run("purge", delivery), { deleted: 1 });
    assertEquals(await run("purge", "--queue", "unknown"), { deleted: 1 });
    assertEquals(await run("dead"), []);
});

Deno.test("an instance's waiting deliveries are sent now once it is unparked", async () => {
    await using test = await createTestContext();
    await createInstance(test.ctx, "b.example");
    const later = new Date(test.clock.now().getTime() + 60 * 60_000);
    await test.ctx.db.updateTable("instances").set({ failures: 7, parked_until: later })
        .where("domain", "=", "b.example").execute();
    await postponeGroup(test.ctx, "versia-deliver", "b.example", later);
    await enqueue(test.ctx, { queue: "versia-deliver", payload: {}, group: "b.example" });
    const unparked = async (domain: string) =>
        JSON.parse((await admin(test.ctx, "domains", "unpark", domain)).printed.join(""));

    assertEquals(await unparked("B.Example"), { domain: "b.example", was_failing: true });
    assertEquals(await isParked(test.ctx, "b.example"), false);
    const [job] = await test.ctx.db.selectFrom("jobs").select("run_at").execute();
    assertEquals(job.run_at, test.clock.now());

    // An instance that only asked to wait isn't failing, but its deliveries wait no more either.
    await postponeGroup(test.ctx, "versia-deliver", "b.example", later);
    assertEquals(await unparked("b.example"), { domain: "b.example", was_failing: false });
    assertEquals(
        (await test.ctx.db.selectFrom("jobs").select("run_at").executeTakeFirst())?.run_at,
        test.clock.now(),
    );

    const error = await assertRejects(() => unparked("c.example"), AdminError);
    assertEquals(error.message, "c.example isn't an instance Verso knows");
});

Deno.test("the SQLite database is copied to a new file, and PostgreSQL's refused", async () => {
    await using test = await createTestContext();
    const dir = await Deno.makeTempDir();
    const source = `${dir}/verso.sqlite`;
    const path = `${dir}/backup.sqlite`;
    const on = (database: object) =>
        Config.parse({
            domain: "social.example",
            database,
            media: { storage: { filesystem: "media" } },
        });

    try {
        {
            using database = new DatabaseSync(source);
            database.exec("CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('kept')");
        }

        const { printed } = await adminWith(test.ctx, on({ sqlite: source }), "backup", path);
        assertEquals(JSON.parse(printed.join("")), { path, bytes: (await Deno.stat(path)).size });

        using copy = new DatabaseSync(path, { readOnly: true });
        assertEquals(copy.prepare("SELECT text FROM notes").all(), [{ text: "kept" }]);

        const exists = await assertRejects(
            () => adminWith(test.ctx, on({ sqlite: source }), "backup", path),
            AdminError,
        );
        assertEquals(exists.message, `${path} already exists`);

        // A wrong path to the database isn't made into an empty one, nor backed up.
        await assertRejects(() =>
            adminWith(test.ctx, on({ sqlite: `${dir}/missing.sqlite` }), "backup", `${path}2`)
        );
        assertEquals(
            await Array.fromAsync(Deno.readDir(dir), (entry) => entry.name).then((names) =>
                names.sort()
            ),
            [
                "backup.sqlite",
                "verso.sqlite",
            ],
        );

        const postgres = await assertRejects(
            () => adminWith(test.ctx, on({ postgres: "postgres://verso" }), "backup", `${path}2`),
            AdminError,
        );
        assertStringIncludes(postgres.message, "pg_dump");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});
