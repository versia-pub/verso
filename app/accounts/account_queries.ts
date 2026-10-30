/**
 * Accounts, local and remote: finding, adding and changing them.
 * @module
 */
import {
    type ExpressionBuilder,
    type Insertable,
    type Selectable,
    sql,
    type Updateable,
} from "kysely";
import { batchesOf } from "../db/batches.ts";
import { countAll, readCount } from "../db/count.ts";
import type { Database } from "../db/database.ts";
import type { Context } from "../kernel/context.ts";
import type { AccountsTable } from "./tables.ts";

/**
 * An account, with the domain of its instance (`null` for the local instance), and its own
 * pictures, if it has them: the URLs of a remote account's, the keys of a local account's and their
 * previews once processed, and their descriptions.
 */
export type AccountRow = Selectable<AccountsTable> & {
    readonly domain: string | null;
    readonly avatar_url: string | null;
    readonly avatar_sha256: string | null;
    readonly avatar_preview_sha256: string | null;
    readonly avatar_description: string | null;
    readonly header_url: string | null;
    readonly header_sha256: string | null;
    readonly header_preview_sha256: string | null;
    readonly header_description: string | null;
};

/**
 * Whether an account named `username`, ignoring case, is on the instance `instanceId` (or local if
 * it is `null`), written the way the unique index on them is, so lookups use it.
 */
const named =
    (instanceId: string | null, username: string) =>
    (eb: ExpressionBuilder<Database, "accounts">) =>
        eb.and([
            eb(eb.fn("coalesce", ["accounts.instance_id", eb.val("")]), "=", instanceId ?? ""),
            eb(eb.fn("lower", ["accounts.username"]), "=", username.toLowerCase()),
        ]);

/**
 * Accounts with their instance's domain and their pictures' URLs, which everything that displays an
 * account needs. It joins the instances and media tables rather than going through those modules,
 * so that a page of accounts takes one query.
 */
const accountRows = (ctx: Pick<Context, "db">) =>
    ctx.db.selectFrom("accounts")
        .leftJoin("instances", "instances.id", "accounts.instance_id")
        .leftJoin("media as avatar", "avatar.id", "accounts.avatar_id")
        .leftJoin("media as header", "header.id", "accounts.header_id")
        .selectAll("accounts")
        .select((eb) => [
            "instances.domain",
            "avatar.url as avatar_url",
            // A local picture's key, once processed; until then it is the upload's.
            eb.case().when("avatar.processed_at", "is not", null).then(eb.ref("avatar.sha256"))
                .else(null).end().as("avatar_sha256"),
            "avatar.preview_sha256 as avatar_preview_sha256",
            "avatar.description as avatar_description",
            "header.url as header_url",
            eb.case().when("header.processed_at", "is not", null).then(eb.ref("header.sha256"))
                .else(null).end().as("header_sha256"),
            "header.preview_sha256 as header_preview_sha256",
            "header.description as header_description",
        ]);

/** The account `id`, with its instance's domain, or `undefined` if there is none. */
export const findAccount = (ctx: Context, id: string): Promise<AccountRow | undefined> =>
    accountRows(ctx).where("accounts.id", "=", id).executeTakeFirst();

/** An account's id, with its picture ids. */
export type AccountPictures = Pick<AccountRow, "id" | "avatar_id" | "header_id">;

/** The accounts in `ids` that exist, in no particular order, however many `ids` there are. */
export const findAccounts = async (
    ctx: Pick<Context, "db">,
    ids: readonly string[],
): Promise<AccountRow[]> => {
    const rows = [];
    for (const batch of batchesOf(ids)) {
        rows.push(...await accountRows(ctx).where("accounts.id", "in", batch).execute());
    }

    return rows;
};

/** The local account named `username`, ignoring case, or `undefined` if there is none. */
export const findLocalAccount = (
    ctx: Context,
    username: string,
): Promise<AccountRow | undefined> =>
    accountRows(ctx).where(named(null, username)).executeTakeFirst();

/**
 * The account named `username`, ignoring case, on the instance `instanceId`, or `undefined` if
 * Verso doesn't have it.
 */
export const findRemoteAccountByName = (
    ctx: Context,
    username: string,
    instanceId: string,
): Promise<AccountRow | undefined> =>
    accountRows(ctx).where(named(instanceId, username)).executeTakeFirst();

/** Which of `ids` are accounts, in no particular order. */
export const existingAccountIds = async (
    ctx: Context,
    ids: readonly string[],
): Promise<string[]> => {
    if (ids.length === 0) return [];

    const rows = await ctx.db.selectFrom("accounts").select("id").where("id", "in", ids).execute();

    return rows.map((row) => row.id);
};

/** The username of an account, which must exist. */
export const getUsername = async (ctx: Context, accountId: string): Promise<string> => {
    const { username } = await ctx.db.selectFrom("accounts")
        .select("username")
        .where("id", "=", accountId)
        .executeTakeFirstOrThrow();

    return username;
};

/** The instances in `instances` that host any of the accounts `ids`, in no particular order. */
export const instancesHosting = async (ctx: Context, ids: readonly string[]): Promise<string[]> => {
    if (ids.length === 0) return [];

    const rows = await ctx.db.selectFrom("accounts").select("instance_id").distinct()
        .where("id", "in", ids)
        .execute();

    // Local accounts have no instance.
    return rows.flatMap((row) => row.instance_id ?? []);
};

/** How many statuses this instance's accounts have posted, as each account counts them. */
export const countLocalStatuses = async (ctx: Context): Promise<number> =>
    readCount(
        await ctx.db.selectFrom("accounts")
            .select((eb) =>
                eb.fn.sum<number | string | bigint | null>("statuses_count").as("count")
            )
            .where("instance_id", "is", null)
            .executeTakeFirstOrThrow(),
    );

/** How many local accounts were created from `since` and before `until`. */
export const countLocalAccountsCreated = async (
    ctx: Context,
    since: Date,
    until: Date,
): Promise<number> =>
    readCount(
        await ctx.db.selectFrom("accounts")
            .select(countAll)
            .where("instance_id", "is", null)
            .where("created_at", ">=", since)
            .where("created_at", "<", until)
            .executeTakeFirstOrThrow(),
    );

/** How many accounts this instance has. */
export const countLocalAccounts = async (ctx: Context): Promise<number> =>
    readCount(
        await ctx.db.selectFrom("accounts")
            .select(countAll)
            .where("instance_id", "is", null)
            .executeTakeFirstOrThrow(),
    );

/**
 * The usernames of local accounts that start with `start`, ignoring case, in lowercase. In `like`,
 * `_` matches any character, so a few extra usernames may be found.
 */
export const localUsernamesStartingWith = async (
    ctx: Context,
    start: string,
): Promise<Set<string>> => {
    const rows = await ctx.db.selectFrom("accounts")
        .select("username")
        .where("instance_id", "is", null)
        .where(sql<string>`lower(username)`, "like", `${start.toLowerCase()}%`)
        .execute();

    return new Set(rows.map((row) => row.username.toLowerCase()));
};

/** Creates a local account. Returns whether it did, which it doesn't if the username is taken. */
export const insertLocalAccount = async (
    ctx: Context,
    account: { readonly id: string; readonly username: string; readonly displayName: string },
): Promise<boolean> => {
    const inserted = await ctx.db.insertInto("accounts")
        .values({
            id: account.id,
            username: account.username,
            instance_id: null,
            remote_id: null,
            created_at: ctx.clock.now(),
            display_name: account.displayName,
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning("id")
        .executeTakeFirst();

    return inserted !== undefined;
};

/** What a remote account says about itself, as columns. */
export type RemoteProfile = Required<
    Pick<
        Insertable<AccountsTable>,
        | "username"
        | "display_name"
        | "note"
        | "note_format"
        | "note_html"
        | "fields"
        | "locked"
        | "indexable"
    >
>;

/**
 * Frees `username` on the instance `instanceId` by renaming the account that has it to `~` followed
 * by its remote id (which no username can be), and marking it to be fetched again, which gives it
 * its new name. Usernames are unique per instance, so an account saved with that username has taken
 * it from whichever account Verso last saw before it changed, or else is that account.
 */
export const releaseRemoteUsername = async (
    ctx: Context,
    instanceId: string,
    username: string,
): Promise<void> => {
    await ctx.db.updateTable("accounts")
        .set((eb) => ({
            username: eb(eb.val("~"), "||", eb.ref("remote_id")),
            fetched_at: new Date(0),
        }))
        .where(named(instanceId, username))
        .execute();
};

/**
 * Adds a remote account or, if it is known by its id on its instance, replaces what it says about
 * itself. Either way, it is marked as fetched now. Returns its local id and its pictures.
 */
export const upsertRemoteAccount = async (
    ctx: Context,
    account: {
        readonly instanceId: string;
        readonly remoteId: string;
        readonly createdAt: Date;
        readonly profile: RemoteProfile;
    },
): Promise<AccountPictures> => {
    const changes = { ...account.profile, fetched_at: ctx.clock.now() };

    return await ctx.db.insertInto("accounts")
        .values({
            id: ctx.ids(),
            instance_id: account.instanceId,
            remote_id: account.remoteId,
            created_at: account.createdAt,
            ...changes,
        })
        .onConflict((conflict) =>
            conflict.columns(["instance_id", "remote_id"]).doUpdateSet(changes)
        )
        .returning(["id", "avatar_id", "header_id"])
        .executeTakeFirstOrThrow();
};

/** A remote account, by its id on its instance, with its pictures. */
export const findRemoteAccount = (
    ctx: Context,
    instanceId: string,
    remoteId: string,
): Promise<AccountPictures | undefined> =>
    ctx.db.selectFrom("accounts")
        .select(["id", "avatar_id", "header_id"])
        .where("instance_id", "=", instanceId)
        .where("remote_id", "=", remoteId)
        .executeTakeFirst();

/** A remote account, by its instance's domain and its id there, with when it was fetched. */
export const findRemoteAccountAt = (
    ctx: Context,
    domain: string,
    remoteId: string,
): Promise<{ id: string; fetched_at: Date | null } | undefined> =>
    ctx.db.selectFrom("accounts")
        .innerJoin("instances", "instances.id", "accounts.instance_id")
        .select(["accounts.id", "accounts.fetched_at"])
        .where("instances.domain", "=", domain)
        .where("accounts.remote_id", "=", remoteId)
        .executeTakeFirst();

/** Points an account at its pictures in `media`. */
export const setAccountPictures = async (
    ctx: Context,
    id: string,
    pictures: { readonly avatar_id: string | null; readonly header_id: string | null },
): Promise<void> => {
    await ctx.db.updateTable("accounts").set(pictures).where("id", "=", id).execute();
};

/** The id of the account that has the media `mediaId` as its avatar or header, if any. */
export const findAccountByPicture = async (
    ctx: Context,
    mediaId: string,
): Promise<string | undefined> =>
    (await ctx.db.selectFrom("accounts").select("id")
        .where((eb) => eb.or([eb("avatar_id", "=", mediaId), eb("header_id", "=", mediaId)]))
        .executeTakeFirst())?.id;

/** Deletes an account. */
export const deleteAccount = async (ctx: Context, id: string): Promise<void> => {
    await ctx.db.deleteFrom("accounts").where("id", "=", id).execute();
};

/** Columns of an account to update. */
export type AccountChanges = Updateable<AccountsTable>;

/** Updates a local account. Columns that are omitted or set to `undefined` stay as they are. */
export const updateLocalAccount = async (
    ctx: Context,
    id: string,
    changes: AccountChanges,
): Promise<void> => {
    // Kysely omits the columns set to `undefined`, and an update must set something.
    if (Object.values(changes).every((value) => value === undefined)) return;

    await ctx.db.updateTable("accounts")
        .set(changes)
        .where("id", "=", id)
        .where("instance_id", "is", null)
        .execute();
};
