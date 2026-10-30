# Adding a route

This guide adds a client API route, using `GET /api/v1/markers` from
[`app/markers/`](../../app/markers/) as the example. Read [HTTP](../http.md) first, which explains
each field.

## 1. Pick the module

A route belongs in the module that owns what it reads or changes. [Modules](../modules.md) lists the
modules and their tables. Markers own the `markers` table, so their routes are in
`app/markers/routes.ts`.

For a new module, make a folder in `app/` with a `routes.ts`, and add it to `modules.md`.

## 2. Find or add the response schema

Mastodon's entities are Zod schemas in [`packages/client-api/`](../../packages/client-api/), such as
`Markers` in `marker.ts`. Use the one Mastodon's docs give for the route. If it's missing, add it
with Mastodon's field descriptions, and export it from `schemas.ts`.

## 3. Write the query and the rendering

Queries go in a `*_queries.ts` file, and turning rows into the API's JSON goes in `render.ts`:

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

Copy `summary`, `description` and the parameter descriptions from Mastodon's docs, and link them
with `docs`. Add anything Verso does differently to the description.

The scope in `auth` is the one Mastodon's docs give, and the permission says what kind of user may
call the route. Only add a new permission to
[`app/kernel/permissions.ts`](../../app/kernel/permissions.ts) if no existing one fits, and then add
it to the `[permissions]` defaults and `docs/config.example.toml`.

Query values are strings, so use `z.coerce` for numbers. Writes go in `ctx.transaction`, with an
event for anything other modules should do, as in [Adding a side effect](adding-a-side-effect.md).
For errors, throw `NotFound`, `Unprocessable` and so on from `app/http/errors.ts`.

## 5. Register it

Add the module's list to `routes` in [`app/http/routes.ts`](../../app/http/routes.ts). If its paths
overlap another module's, like `/api/v1/accounts/search` and `/api/v1/accounts/:id`, put the more
specific one first and say why in a comment.

## 6. Test it

Write `routes.test.ts` next to it, calling the route through `createTestApp` with
`checkResponses: true`. Test what Mastodon's docs promise, the errors, and who isn't allowed to call
it. See [Testing](../testing.md#testing-a-route).

## 7. Update the OpenAPI snapshot

```sh
deno task update-openapi
```

Commit the updated `app/http/openapi.json` with the route, so reviewers can see the API change in
its diff.

## 8. Add a client method

Add a method for the route to the client in
[`packages/client-api/client/`](../../packages/client-api/client/), in the file for its area, with a
`@see` link to Mastodon's docs. Then add the route and a call to the method to `calls` in
[`app/http/client_coverage.test.ts`](../../app/http/client_coverage.test.ts). That test fails until
every route has a call, or a reason in `uncalled`, such as a page only browsers open.

If the method builds its request in an unusual way, test what it sends in
`packages/client-api/client.test.ts`. Test what it does against Verso in `app/http/client.test.ts`.

## Checklist

- [ ] The route is in the module that owns its data.
- [ ] Its text and scope are Mastodon's, with `docs` linking to them.
- [ ] Every input has a schema, and every response a declared status.
- [ ] Writes are in a transaction, and side effects are events.
- [ ] Tests cover the errors and who may not call it.
- [ ] `openapi.json` is updated.
- [ ] The client has a method for it, in `client_coverage.test.ts`.
