/**
 * Remote users moving to another account, as Versia's migration extension has them: a Migration
 * entity, or a User whose `new` names the account it moved to. Either moves it only once the account
 * it moved to, fetched again, says it moved from it, at most once a week, as Mastodon moves accounts.
 * @see https://versia.pub/extensions/migration
 * @see https://github.com/mastodon/mastodon/blob/v4.7.0/app/lib/activitypub/activity/move.rb
 * @module
 */
import { parseReference, type Reference, v0_6 } from "@versia/protocol";
import type { EntityType } from "../federation/registry.ts";
import type { Budget, Context } from "../kernel/context.ts";
import { emit } from "../kernel/events.ts";
import { type AccountRow, findAccount, findRemoteAccountAt } from "./account_queries.ts";
import type { AccountMoved } from "./events.ts";

/** How long after moving an account can't move again. */
const cooldownMs = 7 * 24 * 60 * 60_000;

/** The migration extension of `user`, if it has a valid one. */
export const migrationOf = (user: v0_6.User): v0_6.MigrationExtension | undefined =>
    v0_6.MigrationExtension.safeParse(user.extensions?.[v0_6.migrationKey]).data;

/** The account `reference` points at, local or remote, if Verso has it. */
const accountAt = async (ctx: Context, reference: Reference) => {
    if (reference.host !== ctx.urls.domain) {
        const row = await findRemoteAccountAt(ctx, reference.host, reference.id);
        return row && await findAccount(ctx, row.id);
    }

    const row = await findAccount(ctx, reference.id);
    return row?.domain === null ? row : undefined;
};

/**
 * Stores the account the remote user `accountId`, as its instance `host` sent it, says it moved
 * from.
 */
export const savePrevious = async (
    ctx: Context,
    accountId: string,
    user: v0_6.User,
    host: string,
): Promise<void> => {
    const text = migrationOf(user)?.previous;
    const previous = text === undefined || text === null ? undefined : parseReference(text, host);

    await ctx.db.updateTable("accounts")
        .set({ previous_host: previous?.host ?? null, previous_id: previous?.id ?? null })
        .where("id", "=", accountId)
        .execute();
};

/**
 * When each move being received was prepared, so that it trusts only an account it moved to that
 * was fetched since, and not one the resolver left as it was.
 */
const prepared = new WeakMap<object, Date>();

/** Fetches the account `move` names as moved to again. */
const prepareMove = async (ctx: Context, move: object, destination: Reference, budget: Budget) => {
    prepared.set(move, ctx.clock.now());
    await ctx.federation.resolve(ctx, destination, "User", budget, 0);
};

/** Whether `to` says it moved from `from`, and may be moved to. */
const mayMoveTo = (from: AccountRow, to: AccountRow) =>
    to.id !== from.id && to.suspended_at === null && to.deleted_at === null &&
    to.moved_to_account_id === null &&
    to.previous_host === from.domain && to.previous_id === from.remote_id;

/**
 * Moves the remote account `author` to `destination` if it may, and says so. A move received again
 * changes nothing.
 */
const receiveMove = async (
    ctx: Context,
    move: object,
    author: Reference,
    destination: Reference,
) => {
    const since = prepared.get(move);
    const from = await accountAt(ctx, author);
    const to = await accountAt(ctx, destination);
    if (since === undefined || from === undefined || to === undefined) return;
    if (from.moved_to_account_id === to.id) return;

    const now = ctx.clock.now();
    if (from.moved_at !== null && now.getTime() - from.moved_at.getTime() < cooldownMs) return;
    if (to.fetched_at !== null && to.fetched_at < since) return;
    if (!mayMoveTo(from, to)) return;

    await ctx.db.updateTable("accounts")
        .set({ moved_to_account_id: to.id, moved_at: now })
        .where("id", "=", from.id)
        .execute();

    const moved: AccountMoved = { type: "accounts.moved", accountId: from.id, movedToId: to.id };
    await emit(ctx, moved);
};

/** The reference to the account a received user moved to, if it says it did. */
const newOf = (user: v0_6.User, host: string) => {
    const text = migrationOf(user)?.new;
    return text === undefined || text === null ? undefined : parseReference(text, host);
};

/** Fetches the account a received user says it moved to, before {@link receiveUserMove}. */
export const prepareUserMove = async (
    ctx: Context,
    user: v0_6.User,
    host: string,
    budget: Budget,
): Promise<void> => {
    const destination = newOf(user, host);
    if (destination === undefined) return;

    await prepareMove(ctx, user, destination, budget);
};

/**
 * Moves a received user to the account it says it moved to, as a Migration would. A user that
 * no longer says so stays moved: Versia has no way to undo a move.
 */
export const receiveUserMove = async (
    ctx: Context,
    user: v0_6.User,
    host: string,
): Promise<void> => {
    const destination = newOf(user, host);
    if (destination === undefined) return;

    await receiveMove(ctx, user, { host, id: user.id }, destination);
};

/** The parties of a Migration, if both are valid references. */
const partiesOf = (migration: v0_6.Migration, origin: string) => {
    const author = parseReference(migration.author, origin);
    const destination = parseReference(migration.destination, origin);
    return author && destination && { author, destination };
};

/**
 * That a user moved to another account. Only its author's instance may send it, and it moves the
 * author only if the account it moved to says it moved from it.
 * @see https://versia.pub/extensions/migration
 */
export const migrationType: EntityType<v0_6.Migration> = {
    type: "pub.versia:migration/Migration",
    extension: v0_6.migrationKey,
    schema: v0_6.Migration,
    authority: (migration, origin) => parseReference(migration.author, origin)?.host,
    prepare: async (ctx, migration, sender, budget) => {
        const parties = partiesOf(migration, sender.domain);
        if (parties) await prepareMove(ctx, migration, parties.destination, budget);
    },
    receive: async (ctx, migration, sender) => {
        const parties = partiesOf(migration, sender.domain);
        if (parties) await receiveMove(ctx, migration, parties.author, parties.destination);
    },
};
