# Database

Verso talks to its database through [Kysely](https://kysely.dev), a typed SQL query builder. The
same queries run on three databases:

| Database   | Driver                 | Used for                                  |
| ---------- | ---------------------- | ----------------------------------------- |
| PostgreSQL | `pg`                   | production                                |
| SQLite     | Deno's `node:sqlite`   | small instances in one process, and tests |
| PGlite     | `@electric-sql/pglite` | tests: PostgreSQL compiled to WebAssembly |

Config picks Postgres or SQLite with `database = { postgres = "…" }` or `{ sqlite = "…" }`.
[`app/db/database.ts`](../app/db/database.ts) opens it and lists every table in the `Database` type.
Each table's columns are in its module's `tables.ts`.

## Writing queries

Queries live in `*_queries.ts` files, and only there. Each is a function named for what it does,
that takes the context first:

```ts
/** The markers of `accountId` in those of `timelines` it has one in. */
export const markersOf = async (
    ctx: Context,
    accountId: string,
    timelines: readonly Timeline[],
): Promise<MarkerRow[]> => {
    if (timelines.length === 0) return [];

    return await ctx.db.selectFrom("markers").selectAll()
        .where("account_id", "=", accountId)
        .where("timeline", "in", timelines)
        .execute();
};
```

- **Use `ctx.db`.** Inside `ctx.transaction` it is the transaction, so the same function works in
  and out of one.
- **Take the time from `ctx.clock.now()`**, never from `now()` or a column default. SQLite stores
  times as text, and its own format would sort wrongly against Verso's.
- **Write only your module's tables.** To filter by another module's data, call its subquery helper,
  such as `followerIdsQuery(ctx, accountId)` from `graph`, and use it in `where … in`.
- **Reading another module's table directly** is allowed when it saves a query. Say so in the file's
  comment, as the search module's query files do.
- **Split long lists.** A query may bind only so many values, so pass ids through `batchesOf` from
  [`app/db/batches.ts`](../app/db/batches.ts), 1,000 at a time.
- **Don't pass an array as one value**, as in `= any(${ids})`. The `jsonValues` plugin sends arrays
  as JSON. Use `in` instead.

## Helpers

| File             | What it gives you                                                          |
| ---------------- | -------------------------------------------------------------------------- |
| `paging.ts`      | `readPage`: Mastodon's `max_id`, `since_id` and `min_id` paging            |
| `batches.ts`     | `batchesOf` and `batchSize`                                                |
| `count.ts`       | `countAll` and `readCount`, since drivers return counts as different types |
| `locking.ts`     | `skippingLocked` for job claims, `lockKey` for advisory locks              |
| `notify.ts`      | `notify`: a Postgres `NOTIFY`, sent on commit; nothing on SQLite           |
| `columns.ts`     | column types for migrations, `usesSqlite`, `checkForeignKeys`              |
| `json_values.ts` | sends objects and arrays as JSON                                           |
| `sqlite.ts`      | the SQLite dialect                                                         |

All of these are in [`app/db/`](../app/db/).

## Postgres and SQLite differences

The schema is the same on both. These are the differences:

- **Times** are `timestamptz` on Postgres and ISO 8601 text on SQLite. **JSON** is `jsonb` on
  Postgres and text on SQLite. Migrations use `columnTypes(db).timestamp` and `.json` from
  `columns.ts`, and the SQLite dialect turns them back into `Date`s and objects when reading, by the
  column's declared type. Booleans are 1 and 0 on SQLite, converted the same way.
- **There are no array columns.** Lists are join tables, such as `note_tags`.
- **Locks.** On Postgres, workers claim jobs with `FOR UPDATE SKIP LOCKED`, and `lockKey` takes an
  advisory lock. SQLite lets one writer in at a time, so both do nothing there. SQLite transactions
  begin with `begin immediate`, so a writer waits for another instead of failing.
- **Search** uses Postgres full-text search and SQLite's FTS5, in
  [`app/search/index_queries.ts`](../app/search/index_queries.ts).
- **Messages between processes** use `LISTEN` and `NOTIFY`. SQLite has none, so each process hears
  only its own messages, and workers poll for jobs. SQLite suits one process running `verso all`.

Branch on `usesSqlite(ctx.db)` only when you must, and keep the branch inside a query file or
migration.

On SQLite, Verso opens the file in WAL mode, so `serve` and `work` can share it. On Postgres, the
database must be UTF-8, or search misses words with letters outside ASCII.

## Migrations

Migrations are in [`app/db/migrations/`](../app/db/migrations/), one file each, numbered in order,
and listed in `mod.ts`. `verso migrate` applies the pending ones.

```ts
export const markers: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("markers")
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("timeline", "text", (column) => column.notNull())
            .addColumn("updated_at", columnTypes(db).timestamp, (column) => column.notNull())
            .addPrimaryKeyConstraint("markers_pkey", ["account_id", "timeline"])
            .execute();
    },
};
```

- **Migrations only go forward.** There is no `down`. To undo one, write another.
- **All pending migrations run in one transaction**, on both databases. If one fails, none are
  applied.
- **Never change a migration that has been released.** Instances have already run it.
- **Ids are `text`**, holding a UUIDv7 from `ctx.ids`.
- **Rebuilding a table on SQLite.** SQLite changes most things about a table by copying it to a new
  one. Foreign keys are off while migrating there, since dropping the old table would delete the
  rows that refer to it. A migration that rebuilds a table calls `checkForeignKeys` before it ends.
- **Migrations have no time limit.** Queries are held to `statement_timeout_seconds` on Postgres,
  but `verso migrate` opens the database without one.

After the schema, `verso migrate` also makes the instance's keys and indexes for search any statuses
and accounts that aren't yet.

To add a table, see [Adding a table](guides/adding-a-table.md).

## Tests

Each test gets a new database with every migration run, from `migratedTestDatabase` in
[`app/db/testing.ts`](../app/db/testing.ts). On PGlite, it is a copy of one migrated once per test
worker, which is several times faster. `VERSO_TEST_DATABASE` picks the database:

| Value             | Database                                          |
| ----------------- | ------------------------------------------------- |
| unset or `pglite` | PGlite, in the test process                       |
| `sqlite`          | SQLite, in memory                                 |
| `postgresql://…`  | a new database on that server, made for each test |

`nix flake check` runs the whole suite on all three.
