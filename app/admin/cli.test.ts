import { assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ValidationError } from "@cliffy/command";
import {
    createLocalAccount,
    createRemoteAccount,
    createRole,
    giveRole,
} from "../accounts/testing.ts";
import { findAccount } from "../accounts/account_queries.ts";
import { instanceKey } from "../instances/keys.ts";
import { createInstance } from "../instances/testing.ts";
import { Config } from "../kernel/config.ts";
import type { Context } from "../kernel/context.ts";
import { createTestContext } from "../testing/context.ts";
import { createNote } from "../notes/testing.ts";
import { createCard } from "../previews/testing.ts";
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

/** Runs `verso admin` with `args` on `ctx`, and returns its output. */
const admin = async (ctx: Context, ...args: string[]) => {
    const printed: string[] = [];
    const paths: string[] = [];

    await adminCommand({
        withContext: (path, work) => {
            paths.push(path);
            return work(ctx, config);
        },
        print: (line) => printed.push(line),
    })
        .globalOption("-c, --config <path:string>", "The config file.", { default: "config.toml" })
        .noExit()
        .parse(args);

    return { printed, paths };
};

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
            domain: "evil.example",
            reason: "Spam",
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
