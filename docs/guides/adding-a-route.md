# Adding a route

This walks through adding a client API route, using `GET /api/v1/markers` from
[`app/markers/`](../../app/markers/) as the example. Read [HTTP](../http.md) first for what each
field does.

## 1. Pick the module

A route goes in the module that owns what it reads or changes. [Modules](../modules.md) lists them
with the tables each owns. Markers own the `markers` table, so their routes are in
`app/markers/routes.ts`.

For a new module, make a folder in `app/` with a `routes.ts`, and add it to `modules.md`.

## 2. Find or add the response schema

Mastodon's entities are Zod schemas in [`packages/client-api/`](../../packages/client-api/), such as
`Markers` in `marker.ts`. Use the one Mastodon's docs name for the route. If it isn't there, add it,
with Mastodon's field descriptions, and export it from `schemas.ts`.

## 3. Write the query and the rendering

Queries go in a `*_queries.ts` file, the only kind of file that uses Kysely. Turning rows into the
API's JSON goes in `render.ts`:

```ts
// marker_queries.ts
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

// render.ts
/** Markers, by their timelines. */
export const renderMarkers = (rows: readonly MarkerRow[]): Markers =>
    Object.fromEntries(rows.map((row) => [row.timeline, renderMarker(row)]));
```

See [Database](../database.md) for the query helpers, such as paging.

## 4. Define the route

```ts
// routes.ts
const docs = "https://docs.joinmastodon.org/methods/markers";

export const markerRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v1/markers",
        summary: "Get saved timeline positions",
        description: "Get current positions in timelines.",
        docs: `${docs}/#get`,
        tags: ["markers"],
        auth: { require: "user", scope: "read:statuses", permission: "owner:account" },
        query: z.object({
            timeline: Strings.transform((names) => names.filter(isTimeline)).optional().meta({
                description: "Specify the timeline(s) for which markers should be fetched. …",
            }),
        }),
        responses: { 200: Markers },
        handler: async (ctx, { query, viewer }) => ({
            status: 200,
            body: renderMarkers(await markersOf(ctx, viewer.accountId, query.timeline ?? [])),
        }),
    }),
];
```

- **Words.** `summary`, `description` and each parameter's description are Mastodon's, copied from
  its docs, and `docs` links to them. Say what Verso does differently in the description.
- **`auth`.** The scope is the one Mastodon's docs give. The permission says what kind of user may
  call it. Only add a new permission to
  [`app/kernel/permissions.ts`](../../app/kernel/permissions.ts) if no existing one fits, and then
  add it to the `[permissions]` defaults and to `docs/config.example.toml`.
- **Input.** Everything the handler reads comes through a schema, so it is validated before the
  handler runs. Query values are strings: use `z.coerce` for numbers.
- **Writes** go in `ctx.transaction`, with an event for anything other modules should do. See
  [Adding a side effect](adding-a-side-effect.md).
- **Errors.** Throw `NotFound`, `Unprocessable` and the like, from `app/http/errors.ts`.

## 5. Register it

Add the module's list to `routes` in [`app/http/routes.ts`](../../app/http/routes.ts). If its paths
overlap another module's, such as `/api/v1/accounts/search` and `/api/v1/accounts/:id`, put it first
and say why in a comment.

## 6. Test it

Write `routes.test.ts` beside it, calling the route through `createTestApp` with
`checkResponses: true`. Test what Mastodon's docs promise, the errors, and who may not call it. See
[Testing](../testing.md#testing-a-route).

## 7. Update the OpenAPI snapshot

```sh
deno task update-openapi
```

Commit the changed `app/http/openapi.json` with the route. Reviewers read its diff to see the API
change.

## 8. Add a client method

Add a method for the route to the client in
[`packages/client-api/client/`](../../packages/client-api/client/), in the file for its area, with
Mastodon's docs in `@see`. Then add the route and a call of the method to `calls` in
[`app/http/client_coverage.test.ts`](../../app/http/client_coverage.test.ts), which fails until
every route has one, or a reason in `uncalled` it has none, such as a page only browsers open. Test
what the method sends in `packages/client-api/client.test.ts`, if it builds the request in a way of
its own, and what it does against Verso in `app/http/client.test.ts`.

## Checklist

- [ ] The route is in the module that owns its data.
- [ ] Its text and scope are Mastodon's, with `docs` linking to them.
- [ ] Every input has a schema, and every response a declared status.
- [ ] Writes are in a transaction, and side effects are events.
- [ ] Tests cover the errors and who may not call it.
- [ ] `openapi.json` is updated.
- [ ] The client has a method for it, in `client_coverage.test.ts`.
