# Adding a table

This walks through adding a table, using `markers` from [`app/markers/`](../../app/markers/) as the
example. Read [Database](../database.md) first for the rules every query follows.

```
app/db/migrations/0052_markers.ts   creates the table, on Postgres and SQLite
app/db/migrations/mod.ts            lists the migration
app/markers/tables.ts               MarkersTable: the row type
app/db/database.ts                  Database: adds markers: MarkersTable
app/markers/marker_queries.ts       the only file that reads and writes it
docs/modules.md                     says markers owns it
```

## 1. Pick the owner

Every table has one module that owns it and is the only one to write it. Usually that is the module
that needs it. Name the table in the plural, in snake case, such as `push_subscriptions`.

## 2. Write the migration

Add the next file in [`app/db/migrations/`](../../app/db/migrations/), numbered after the last:

```ts
// 0052_markers.ts
export const markers: Migration = {
    up: async (db: Kysely<unknown>) => {
        await db.schema.createTable("markers")
            .addColumn(
                "account_id",
                "text",
                (column) => column.notNull().references("accounts.id").onDelete("cascade"),
            )
            .addColumn("timeline", "text", (column) => column.notNull())
            .addColumn("last_read_id", "text", (column) => column.notNull())
            .addColumn("version", "integer", (column) => column.notNull())
            .addColumn("updated_at", columnTypes(db).timestamp, (column) => column.notNull())
            .addPrimaryKeyConstraint("markers_pkey", ["account_id", "timeline"])
            .execute();
    },
};
```

Then import it in `mod.ts`, and add it to the list there under its file name.

- **Ids are `text`**, filled with `ctx.ids()`, a UUIDv7.
- **Times and JSON** use `columnTypes(db).timestamp` and `.json`, so they work on both databases.
  Never give a time column a default: times come from `ctx.clock`.
- **Say what happens on delete.** A row that means nothing without its account, such as a marker,
  goes with it: `onDelete("cascade")`. Think about remote accounts and statuses too, which are
  deleted when their instance says so.
- **Add the indexes your queries need**, such as one for each column a query filters or orders by
  that the primary key doesn't cover.
- **No arrays.** A list is a table of its own, such as `note_tags`.
- **Write the same schema on both databases.** Branch on `usesSqlite(db)` only for what SQLite can't
  do, such as full-text search.

A released migration never changes, since instances have already run it. To change a table later,
write another migration. On SQLite, read the migration rules in
[Database](../database.md#migrations) first: most changes there rebuild the table.

## 3. Write the row type

In the module's `tables.ts`, with a comment on the table and on any column whose meaning isn't
plain:

```ts
/**
 * Where a local user last read up to in a timeline, so that their apps can carry on from there, as
 * Mastodon's markers.
 * @see https://docs.joinmastodon.org/entities/Marker/
 */
export type MarkersTable = {
    account_id: string;
    timeline: Timeline;
    /** The newest status, or notification, read. */
    last_read_id: string;
    /** How many times it was set. */
    version: number;
    updated_at: Date;
};
```

Use `Date` for times, `boolean` for booleans, and Kysely's `Generated<T>` for a column with a
default, so inserts may leave it out. Then add the table to `Database` in
[`app/db/database.ts`](../../app/db/database.ts): `markers: MarkersTable`.

## 4. Write the queries

Put them in the module's `*_queries.ts` file. Other modules never write the table. One that needs
its data calls these functions, or a subquery helper this module exports, and reads the table itself
only when that saves a query. See [Writing queries](../database.md#writing-queries).

## 5. Update the docs and test

- Add the table to its owner in [Modules](../modules.md#who-owns-which-table).
- `deno task test` runs every migration on a new database for each test, so a broken one fails at
  once. Run the tests on SQLite too, with `VERSO_TEST_DATABASE=sqlite`, as CI does.
- Test the queries through the module's routes or services, as in [Testing](../testing.md).

## Checklist

- [ ] One module owns the table, and only its `*_queries.ts` files write it.
- [ ] The migration has the next number, and is in `mod.ts`.
- [ ] Times and JSON use `columnTypes`, and no column defaults to the current time.
- [ ] Every reference says what happens on delete.
- [ ] The queries have the indexes they need.
- [ ] The row type is in `tables.ts` and `Database`.
- [ ] The tests pass on PGlite and SQLite.
- [ ] `modules.md` lists the table.
