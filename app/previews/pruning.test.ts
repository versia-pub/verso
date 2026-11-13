import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { CompiledQuery, sql } from "kysely";
import { createLocalAccount } from "../accounts/testing.ts";
import { testDatabaseKind } from "../db/testing.ts";
import { queues, tasks } from "../jobs/queues.ts";
import { schedule } from "../jobs/scheduler.ts";
import { drain } from "../jobs/worker.ts";
import { dayMs } from "../kernel/clock.ts";
import type { Context } from "../kernel/context.ts";
import { bytesSource } from "../kernel/files.ts";
import { removeUnusedMedia } from "../media/cleanup.ts";
import { createNote } from "../notes/testing.ts";
import { createTestContext } from "../testing/context.ts";
import { pruneCards, startCardPruning } from "./pruning.ts";
import { clearCardImages, deleteUnusedCards, oldCardsQuery } from "./pruning_queries.ts";
import { createCard } from "./testing.ts";

const open = async (settings: { previewCardMs?: number | null } = {}) => {
    const test = await createTestContext({ settings });
    await createLocalAccount(test.ctx, "alice");

    return test;
};

/** Prunes the cards fetched before now. The command does the same. */
const prune = (ctx: Context) => pruneCards(ctx, new Date(ctx.clock.now().getTime() + 1));

/** The cards left, by id, with whether each still has its image. */
const cards = async (ctx: Context) =>
    Object.fromEntries(
        (await ctx.db.selectFrom("preview_cards").select(["id", "image_id"]).orderBy("id")
            .execute()).map((row) => [row.id, row.image_id !== null]),
    );

/** A card that alice's status shows. */
const shownCard = async (ctx: Context) =>
    await createCard(ctx, [(await createNote(ctx, "alice")).id]);

Deno.test("an old card no status shows is deleted, and an old card one shows loses its image", async () => {
    await using test = await open();
    const shown = await shownCard(test.ctx);
    await createCard(test.ctx, []);

    assertEquals(await prune(test.ctx), { deleted: 1, cleared: 1 });
    assertEquals(await cards(test.ctx), { [shown]: false });
});

Deno.test("a trending card, and one an admin approved or rejected, aren't deleted", async () => {
    await using test = await open();
    const trending = await createCard(test.ctx, []);
    await test.ctx.db.insertInto("trending_links")
        .values({
            card_id: trending,
            score: 1,
            max_score: 1,
            max_score_at: test.clock.now(),
        })
        .execute();
    const approved = await createCard(test.ctx, [], { trendable: true });
    const rejected = await createCard(test.ctx, [], { trendable: false });

    assertEquals(await prune(test.ctx), { deleted: 0, cleared: 3 });
    assertEquals(await cards(test.ctx), {
        [trending]: false,
        [approved]: false,
        [rejected]: false,
    });
});

Deno.test("a card fetched since the cutoff is kept with its image", async () => {
    await using test = await open();
    const fetchedAt = test.clock.now();
    const shown = await shownCard(test.ctx);
    const unshown = await createCard(test.ctx, []);

    assertEquals(await pruneCards(test.ctx, fetchedAt), { deleted: 0, cleared: 0 });
    assertEquals(await cards(test.ctx), { [shown]: true, [unshown]: true });

    assertEquals(await pruneCards(test.ctx, new Date(fetchedAt.getTime() + 1)), {
        deleted: 1,
        cleared: 1,
    });
});

Deno.test("only the cards given that were fetched before the cutoff are pruned", async () => {
    await using test = await open();
    const fetchedAt = test.clock.now();
    const given = await createCard(test.ctx, []);
    const other = await createCard(test.ctx, []);
    test.clock.advance(dayMs);
    const fresh = await createCard(test.ctx, []);
    const cutoff = new Date(fetchedAt.getTime() + 1);

    assertEquals(await clearCardImages(test.ctx, [given, fresh], cutoff), 1);
    assertEquals(await deleteUnusedCards(test.ctx, [given, fresh], cutoff), 1);
    assertEquals(await cards(test.ctx), { [other]: true, [fresh]: true });
});

Deno.test("the files of pruned cards' images are removed with other unused media, unless still used", async () => {
    await using test = await open();
    const key = await test.ctx.files.put(await bytesSource(new Uint8Array([1, 2, 3])), "image/png");
    const shown = await shownCard(test.ctx);
    await createCard(test.ctx, []);
    await test.ctx.db.updateTable("media").set({ sha256: key }).execute();
    await prune(test.ctx);

    // A card fetched later uses the same file.
    const later = await createCard(test.ctx, []);
    await test.ctx.db.updateTable("media").set({ sha256: key })
        .where(
            "id",
            "=",
            (eb) => eb.selectFrom("preview_cards").select("image_id").where("id", "=", later),
        )
        .execute();

    test.clock.advance(dayMs);
    await removeUnusedMedia(test.ctx);

    assertEquals(await cards(test.ctx), { [shown]: false, [later]: true });
    assertEquals((await test.ctx.db.selectFrom("media").select("id").execute()).length, 1);
    const stream = await test.ctx.files.get(key);
    await stream?.cancel();
    assert(stream !== undefined);

    await test.ctx.db.deleteFrom("preview_cards").where("id", "=", later).execute();
    await removeUnusedMedia(test.ctx);
    assertEquals(await test.ctx.files.get(key), undefined);
});

/** Adds `count` cards no status shows, fetched a day and a moment ago. */
const addCards = async (ctx: Context, count: number) => {
    const fetchedAt = new Date(ctx.clock.now().getTime() - dayMs - 1);
    for (let start = 0; start < count; start += 200) {
        await ctx.db.insertInto("preview_cards")
            .values(
                Array.from({ length: Math.min(200, count - start) }, (_, index) => {
                    const id = `x${String(start + index).padStart(5, "0")}`;
                    return {
                        id,
                        url: `https://news.example/${id}`,
                        title: "A story",
                        description: "",
                        author_name: "",
                        author_url: "",
                        provider_name: "",
                        provider_url: "",
                        image_description: "",
                        link_type: "unknown" as const,
                        fetched_at: fetchedAt,
                    };
                }),
            )
            .execute();
    }
};

Deno.test("each day, cards fetched more than preview_card_days ago are pruned, in batches", async () => {
    await using test = await open({ previewCardMs: dayMs });
    const shown = await shownCard(test.ctx);
    const recent = await createCard(test.ctx, [], {
        fetched_at: new Date(test.clock.now().getTime() - dayMs / 2),
    });
    await addCards(test.ctx, 1200);

    await schedule(test.ctx, tasks);
    await drain(test.ctx, queues);

    assertEquals(await cards(test.ctx), { [shown]: true, [recent]: true });
});

Deno.test("cards aren't pruned unless preview_card_days is set", async () => {
    await using test = await open();
    await addCards(test.ctx, 3);

    await startCardPruning(test.ctx);
    await drain(test.ctx, queues);

    assertEquals(Object.keys(await cards(test.ctx)).length, 3);
});

Deno.test("old cards are read by index", async () => {
    await using test = await open();
    const { db } = test.ctx;
    const old = oldCardsQuery(test.ctx, test.clock.now(), {
        fetchedAt: test.clock.now(),
        id: "0",
    }, 500).compile();
    if (testDatabaseKind === "sqlite") {
        const plan = await db.executeQuery<{ detail: string }>(
            CompiledQuery.raw(`explain query plan ${old.sql}`, [...old.parameters]),
        );
        assertStringIncludes(
            plan.rows.map((row) => row.detail).join("\n"),
            "preview_cards_by_fetch",
        );
        return;
    }

    await sql`set enable_seqscan = off`.execute(db);
    const plan = await db.executeQuery(
        CompiledQuery.raw(`explain (format json) ${old.sql}`, [...old.parameters]),
    );
    assertStringIncludes(JSON.stringify(plan.rows), '"Index Name":"preview_cards_by_fetch"');
});

Deno.test({
    name: "what refers to cards is what keeps one from being deleted, and is indexed",
    ignore: testDatabaseKind !== "sqlite",
    fn: async () => {
        await using test = await open();
        const rows = await sql<{ name: string; from: string; indexed: number }>`
            select m.name, p."from", exists (
                select 1 from pragma_index_list(m.name) l, pragma_index_info(l.name) i
                where l.partial = 0 and i.seqno = 0 and i.name = p."from"
            ) as indexed
            from sqlite_master m, pragma_foreign_key_list(m.name) p
            where m.type = 'table' and p."table" = 'preview_cards'
        `.execute(test.ctx.db);

        // A new reference should be added to deleteUnusedCards, or here if it doesn't keep one.
        assertEquals(
            rows.rows.map((row) => `${row.name}.${row.from}:${row.indexed}`).toSorted(),
            ["note_preview_cards.card_id:1", "trending_links.card_id:1"],
        );
    },
});
