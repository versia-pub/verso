import type { Selectable } from "kysely";
import { countAll, readCount } from "../db/count.ts";
import { type PageBounds, readPage } from "../db/paging.ts";
import type { AccountIdQuery } from "../graph/follow_queries.ts";
import type { Context } from "../kernel/context.ts";
import type { ListsTable, RepliesPolicy } from "./tables.ts";

export type ListRow = Selectable<ListsTable>;

/** What a list's owner may change. Omitted fields stay as they are. */
export type ListChanges = {
    readonly title?: string;
    readonly replies_policy?: RepliesPolicy;
    readonly exclusive?: boolean;
};

/** Adds a list for `accountId`, and returns it. */
export const insertList = async (
    ctx: Context,
    accountId: string,
    list: Required<ListChanges>,
): Promise<ListRow> =>
    await ctx.db.insertInto("lists")
        .values({ id: ctx.ids(), account_id: accountId, ...list, created_at: ctx.clock.now() })
        .returningAll()
        .executeTakeFirstOrThrow();

/** Changes `accountId`'s list `listId`, and returns it, if they have it. */
export const updateList = async (
    ctx: Context,
    accountId: string,
    listId: string,
    changes: ListChanges,
): Promise<ListRow | undefined> => {
    // Kysely omits the columns set to `undefined`, and an update must set something.
    if (Object.values(changes).every((value) => value === undefined)) {
        return await findList(ctx, accountId, listId);
    }

    return await ctx.db.updateTable("lists")
        .set(changes)
        .where("id", "=", listId)
        .where("account_id", "=", accountId)
        .returningAll()
        .executeTakeFirst();
};

/** Removes `accountId`'s list `listId`. Returns whether they had it. */
export const deleteList = async (
    ctx: Context,
    accountId: string,
    listId: string,
): Promise<boolean> => {
    const { numDeletedRows } = await ctx.db.deleteFrom("lists")
        .where("id", "=", listId)
        .where("account_id", "=", accountId)
        .executeTakeFirst();

    return numDeletedRows > 0n;
};

/** `accountId`'s list `listId`, if they have it. */
export const findList = async (
    ctx: Context,
    accountId: string,
    listId: string,
): Promise<ListRow | undefined> =>
    await ctx.db.selectFrom("lists").selectAll()
        .where("id", "=", listId)
        .where("account_id", "=", accountId)
        .executeTakeFirst();

/** `accountId`'s lists, oldest first. */
export const listsOf = async (ctx: Context, accountId: string): Promise<ListRow[]> =>
    await ctx.db.selectFrom("lists").selectAll()
        .where("account_id", "=", accountId)
        .orderBy("id")
        .execute();

/** How many lists `accountId` has. */
export const countLists = async (ctx: Context, accountId: string): Promise<number> =>
    readCount(
        await ctx.db.selectFrom("lists").select(countAll)
            .where("account_id", "=", accountId)
            .executeTakeFirstOrThrow(),
    );

/** `accountId`'s lists that `memberId` is in, oldest first. */
export const listsWith = async (
    ctx: Context,
    accountId: string,
    memberId: string,
): Promise<ListRow[]> =>
    await ctx.db.selectFrom("lists").selectAll("lists")
        .innerJoin("list_accounts", "list_accounts.list_id", "lists.id")
        .where("lists.account_id", "=", accountId)
        .where("list_accounts.account_id", "=", memberId)
        .orderBy("lists.id")
        .execute();

/** Of the lists `listIds`, those `memberId` is in. */
export const listsWithAmong = async (
    ctx: Context,
    listIds: readonly string[],
    memberId: string,
): Promise<ListRow[]> =>
    listIds.length === 0 ? [] : await ctx.db.selectFrom("lists").selectAll("lists")
        .innerJoin("list_accounts", "list_accounts.list_id", "lists.id")
        .where("lists.id", "in", listIds)
        .where("list_accounts.account_id", "=", memberId)
        .execute();

/** Adds an account to a list, through the owner's follow of it, `followId`, if it isn't theirs. */
export const insertListAccount = async (
    ctx: Context,
    listId: string,
    member: { readonly accountId: string; readonly followId: string | null },
): Promise<void> => {
    await ctx.db.insertInto("list_accounts")
        .values({
            id: ctx.ids(),
            list_id: listId,
            account_id: member.accountId,
            follow_id: member.followId,
            created_at: ctx.clock.now(),
        })
        .execute();
};

/** Which of `accountIds` are in the list `listId`. */
export const listAccountsAmong = async (
    ctx: Context,
    listId: string,
    accountIds: readonly string[],
): Promise<Set<string>> => {
    if (accountIds.length === 0) return new Set();

    const rows = await ctx.db.selectFrom("list_accounts").select("account_id")
        .where("list_id", "=", listId)
        .where("account_id", "in", accountIds)
        .execute();
    return new Set(rows.map((row) => row.account_id));
};

/** Removes `accountIds` from the list `listId`. */
export const deleteListAccounts = async (
    ctx: Context,
    listId: string,
    accountIds: readonly string[],
): Promise<void> => {
    if (accountIds.length === 0) return;

    await ctx.db.deleteFrom("list_accounts")
        .where("list_id", "=", listId)
        .where("account_id", "in", accountIds)
        .execute();
};

/**
 * A page of the accounts in the list `listId`, latest added first, each as the membership's id,
 * which pages are counted by, and the account's id. Without `page`, all of them.
 */
export const listAccountPage = async (
    ctx: Context,
    listId: string,
    page: PageBounds | null,
): Promise<{ id: string; account_id: string }[]> => {
    const query = ctx.db.selectFrom("list_accounts")
        .select(["id", "account_id"])
        .where("list_id", "=", listId);

    return page === null
        ? await query.orderBy("id", "desc").execute()
        : await readPage(query, "list_accounts.id", page);
};

/**
 * The accounts in the list `listId` of `ownerId` whose statuses the owner sees there, as a
 * subquery: those they follow, and were accepted by, and the owner, as on Mastodon. The others are
 * in it while the owner's request to follow them waits.
 */
export const listMembersSubquery = (
    ctx: Context,
    ownerId: string,
    listId: string,
): AccountIdQuery =>
    ctx.db.selectFrom("list_accounts")
        .leftJoin("follows", "follows.id", "list_accounts.follow_id")
        .select("list_accounts.account_id")
        .where("list_accounts.list_id", "=", listId)
        .where((eb) =>
            eb.or([eb("follows.accepted", "=", true), eb("list_accounts.account_id", "=", ownerId)])
        );

/** The accounts in `accountId`'s exclusive lists, as a subquery, to leave out of its home. */
export const exclusiveMembersSubquery = (ctx: Context, accountId: string): AccountIdQuery =>
    ctx.db.selectFrom("list_accounts")
        .innerJoin("lists", "lists.id", "list_accounts.list_id")
        .select("list_accounts.account_id")
        .where("lists.account_id", "=", accountId)
        .where("lists.exclusive", "=", true);
