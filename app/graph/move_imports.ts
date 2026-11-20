/**
 * What a local account gets from the remote account it moved from, which only its old instance
 * knows: the account's subscribers, whose Subscribes to the new account are accepted for 30 days
 * even if it is locked, and the accounts it subscribed to, which the new account follows. Each
 * collection is fetched by jobs, a few minutes of pages at a time.
 * @see https://versia.pub/extensions/migration
 * @module
 */
import { v0_7 } from "@versia/protocol";
import { z } from "zod";
import {
    findAccount,
    findRemoteAccountAt,
    isAccountSilenced,
} from "../accounts/account_queries.ts";
import { isAccountMoved } from "../accounts/events.ts";
import { fetchEntityCollection } from "../federation/collections.ts";
import { fetchBudget, isRemoteFailure, withDeadline } from "../federation/resolver.ts";
import { enqueue } from "../jobs/job_queries.ts";
import type { JobsTable } from "../jobs/tables.ts";
import { type Handler, PermanentFailure } from "../jobs/worker.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { blockingAny } from "./blocks.ts";
import { acceptFollow, follow } from "./follows.ts";

/** The queue that fetches the collections of accounts that moved to local ones. */
export const moveImportQueue = "move-imports";

const MoveImportJob = z.object({
    collection: z.enum(["subscribers", "subscriptions"]),
    accountId: z.string(),
    movedToId: z.string(),
    offset: z.number().int().min(0),
    walked: z.number().int().min(0),
});

type MoveImport = z.infer<typeof MoveImportJob>;

/**
 * How long one job fetches for, within the 5 minutes a job may take before another worker claims
 * it.
 */
const walkMs = 4 * 60_000;

/** How long past `walkMs` the last fetch may take, still within the 5 minutes. */
const fetchSlackMs = 30_000;

/** How long a subscriber is remembered: the longest an instance may try to deliver (30 days). */
const subscriberMs = 30 * 24 * 3_600_000;

/**
 * Mastodon's `MAX_FOLLOWS_THRESHOLD` default, which limits the accounts that one follows. Verso has
 * no follow limit of its own, so this only bounds what a move brings over.
 */
const mastodonFollowLimit = 7500;

/** How many subscribers one move records, so an instance can't make Verso fetch forever. */
const subscriberLimit = 50_000;

/** How many references of each collection one move walks. */
export type MoveImportLimits = {
    readonly subscribers: number;
    readonly subscriptions: number;
};

const limits: MoveImportLimits = {
    subscribers: subscriberLimit,
    subscriptions: mastodonFollowLimit,
};

/** How many references a page of a collection holds. */
const pageSize = 40;

/** Queues a job to fetch the next references of a collection. */
const enqueueImport = async (ctx: Context, payload: MoveImport, instanceId: string) => {
    const { collection, accountId, movedToId, offset } = payload;

    await enqueue(ctx, {
        queue: moveImportQueue,
        payload,
        group: instanceId,
        maxAttempts: 3,
        dedupeKey: `move-import:${collection}:${accountId}:${movedToId}:${offset}`,
    });
};

/**
 * Queues the fetching of the subscribers and the subscriptions of a remote account that moved to a
 * local one. A move between local accounts, or to a remote one, has nothing to fetch.
 */
export const queueMoveImports = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isAccountMoved(event)) return;

    const from = await findAccount(ctx, event.accountId);
    const to = await findAccount(ctx, event.movedToId);
    if (from === undefined || to === undefined) return;
    if (from.domain === null || from.instance_id === null || to.domain !== null) return;

    for (const collection of MoveImportJob.shape.collection.options) {
        await enqueueImport(
            ctx,
            { collection, accountId: from.id, movedToId: to.id, offset: 0, walked: 0 },
            from.instance_id,
        );
    }
};

/** Whether `accountId` records the account `id` on `host` as a subscriber of its old account. */
export const isMoveSubscriber = async (
    ctx: Context,
    accountId: string,
    host: string,
    id: string,
): Promise<boolean> => {
    const row = await ctx.db.selectFrom("move_subscribers").select("account_id")
        .where("account_id", "=", accountId)
        .where("host", "=", host)
        .where("remote_id", "=", id)
        .executeTakeFirst();

    return row !== undefined;
};

/** Accepts the follow request of `followerId` to `to`, unless the follower is silenced. */
export const acceptUnlessSilenced = async (
    ctx: Context,
    followerId: string,
    toId: string,
): Promise<void> => {
    if (!await isAccountSilenced(ctx, followerId)) await acceptFollow(ctx, followerId, toId);
};

/** Records a subscriber, and accepts its follow request if Verso already has one. */
const importSubscriber = async (
    ctx: Context,
    toId: string,
    reference: { readonly host: string; readonly id: string },
) => {
    // Local followers are moved with the rest of what follows the account.
    if (reference.host === ctx.urls.domain) return;

    await ctx.db.insertInto("move_subscribers")
        .values({
            account_id: toId,
            host: reference.host,
            remote_id: reference.id,
            created_at: ctx.clock.now(),
        })
        .onConflict((conflict) => conflict.doNothing())
        .execute();

    const known = await findRemoteAccountAt(ctx, reference.host, reference.id);
    if (known !== undefined) await acceptUnlessSilenced(ctx, known.id, toId);
};

/** Has `toId` follow the account `reference` is to, unless it blocks it. */
const importSubscription = async (
    ctx: Context,
    timed: Context,
    toId: string,
    reference: { readonly host: string; readonly id: string },
    until: number,
) => {
    const id = await ctx.federation.resolve(timed, reference, "User", fetchBudget(20, until))
        .catch((error) => {
            if (isRemoteFailure(error)) return undefined;
            throw error;
        });
    if (id === undefined) return;

    const target = ctx.db.selectFrom("accounts").select("id as account_id").where("id", "=", id);
    if ((await blockingAny(ctx, [toId], target)).size > 0) return;

    // A locked or remote account leaves it requested. `toId` itself and the rest can't be followed.
    await follow(ctx, toId, id);
};

/**
 * Walks the collection in the job, from its offset, `pageSize` references at a time, for at most 4
 * minutes, and does what it says for each, up to the limit for that collection. If the time runs
 * out first, queues a job for the rest. A failure to fetch a page is thrown, so the job is retried.
 */
export const importCollection = async (
    ctx: Context,
    job: MoveImport,
    max: MoveImportLimits = limits,
): Promise<void> => {
    const from = await findAccount(ctx, job.accountId);
    const to = await findAccount(ctx, job.movedToId);
    if (from === undefined || to === undefined || from.moved_to_account_id !== to.id) return;
    if (from.domain === null || from.instance_id === null || from.remote_id === null) return;
    if (to.domain !== null) return;
    if (await ctx.federation.isBlocked(ctx, from.domain)) return;

    const { domain, remote_id: remoteId, instance_id: instanceId } = from;
    const cap = max[job.collection];
    const until = ctx.clock.now().getTime() + walkMs;
    // A fetch started just before `until` may finish after it, so it isn't aborted and lost.
    const fetchesUntil = until + fetchSlackMs;
    const timed = withDeadline(ctx, fetchBudget(0, fetchesUntil));
    const timedOut = () => ctx.clock.now().getTime() >= until;
    let { offset, walked } = job;

    for (;;) {
        if (walked >= cap) return;
        if (timedOut()) return await enqueueImport(ctx, { ...job, offset, walked }, instanceId);

        const page = await fetchEntityCollection(timed, domain, "User", remoteId, job.collection, {
            offset,
            limit: pageSize,
        });
        if (page === null) return;
        const parsed = v0_7.ReferenceCollection.safeParse(page);
        if (!parsed.success) {
            throw new PermanentFailure(`${domain} sent invalid ${job.collection}`);
        }

        for (const [index, item] of parsed.data.items.entries()) {
            if (walked >= cap) return;
            // A page is walked once started, so a job always makes progress.
            if (index > 0 && timedOut()) {
                return await enqueueImport(
                    ctx,
                    { ...job, offset: offset + index, walked },
                    instanceId,
                );
            }

            walked++;
            const reference = v0_7.parseReference(item);
            if (reference === undefined) continue;

            if (job.collection === "subscribers") {
                await importSubscriber(ctx, to.id, reference);
            } else {
                await importSubscription(ctx, timed, to.id, reference, fetchesUntil);
            }
        }

        offset += parsed.data.items.length;
        if (parsed.data.items.length === 0 || offset >= parsed.data.total) return;
    }
};

/**
 * Fetches a collection of an account that moved, if both accounts are still there, and it still
 * says it moved to the other, as a local user may cancel its move.
 */
export const moveImportHandler: Handler = async (ctx: Context, job: JobsTable): Promise<void> => {
    const payload = MoveImportJob.safeParse(job.payload);
    if (!payload.success) throw new PermanentFailure("The job isn't a move import job");

    await importCollection(ctx, payload.data);
};

/** Deletes the subscribers recorded over 30 days ago, `batchSize` at a time. */
export const deleteExpiredMoveSubscribers = async (
    ctx: Context,
    batchSize = 1000,
): Promise<void> => {
    const before = new Date(ctx.clock.now().getTime() - subscriberMs);
    for (;;) {
        // The key has three columns, so a batch is deleted by listing its rows.
        const rows = await ctx.db.selectFrom("move_subscribers")
            .select(["account_id", "host", "remote_id"])
            .where("created_at", "<=", before)
            .limit(batchSize)
            .execute();
        if (rows.length === 0) return;

        await ctx.db.deleteFrom("move_subscribers")
            .where((eb) =>
                eb.or(rows.map((row) =>
                    eb.and({
                        account_id: row.account_id,
                        host: row.host,
                        remote_id: row.remote_id,
                    })
                ))
            )
            .execute();
        if (rows.length < batchSize) return;
    }
};
