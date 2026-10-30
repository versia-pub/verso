# Adding a table

This guide adds a table, using `markers` from [`app/markers/`](../../app/markers/) as the example.
Read [Database](../database.md) first for the rules every query follows.

```
app/db/migrations/0052_markers.ts   creates the table, on Postgres and SQLite
app/db/migrations/mod.ts            lists the migration
app/markers/tables.ts               MarkersTable: the row type
app/db/database.ts                  Database: adds markers: MarkersTable
app/markers/marker_queries.ts       the only file that reads and writes it
docs/modules.md                     says markers owns it
```

## 1. Pick the owner

Every table has one owning module, which is the only one that writes it. That's usually the module
that needs it. Table names are plural and snake case, such as `push_subscriptions`.

## 2. Write the migration

Add the next numbered file to [`app/db/migrations/`](../../app/db/migrations/):

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

Then import it in `mod.ts` and add it to the list there, under its file name.

[Database](../database.md#migrations) has the rules every migration follows, such as `text` ids,
`columnTypes` for times and JSON, and no arrays. A few more things to get right for a new table:

- Never give a time column a default. Times come from `ctx.clock`.
- Every reference needs an `onDelete`. A row that means nothing without its account, like a marker,
  should be deleted with it, using `onDelete("cascade")`. Remember that remote accounts and statuses
  are deleted too, when their instance says so.
- Add an index for each column your queries filter or sort by that the primary key doesn't cover.

Once released, a migration never changes. To change the table later, write a new migration. On
SQLite, most changes rebuild the table, so read [Database](../database.md#migrations) first.

## 3. Write the row type

The row type goes in the module's `tables.ts`, with a comment on the table and on any column whose
meaning isn't obvious:

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

Use `Date` for times, `boolean` for booleans, and Kysely's `Generated<T>` for columns with a
default, so inserts can leave them out. Then add the table to `Database` in
[`app/db/database.ts`](../../app/db/database.ts): `markers: MarkersTable`.

## 4. Write the queries

Queries go in the module's `*_queries.ts` file. Other modules that need the data call these
functions, or a subquery helper the module exports. See
[Writing queries](../database.md#writing-queries).

## 5. Update the docs and test

- Add the table to its owner in [Modules](../modules.md#who-owns-which-table).
- `deno task test` runs every migration on a fresh database for each test, so a broken migration
  fails straight away. Run the tests on SQLite too, with `VERSO_TEST_DATABASE=sqlite`, as CI does.
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
