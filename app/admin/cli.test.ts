import { assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ValidationError } from "@cliffy/command";
import { createLocalAccount, createRole, giveRole } from "../accounts/testing.ts";
import { instanceKey } from "../instances/keys.ts";
import { createInstance } from "../instances/testing.ts";
import type { Context } from "../kernel/context.ts";
import { createTestContext } from "../testing/context.ts";
import { adminCommand, AdminError } from "./cli.ts";

/** Runs `verso admin` with `args` on `ctx`, and returns what it printed. */
const admin = async (ctx: Context, ...args: string[]) => {
    const printed: string[] = [];
    const paths: string[] = [];

    await adminCommand({
        withContext: (path, work) => {
            paths.push(path);
            return work(ctx);
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
