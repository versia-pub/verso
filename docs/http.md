# HTTP

Verso serves the Mastodon client API, Versia's federation endpoints, the OAuth login pages and its
API docs from one [Hono](https://hono.dev) app, built in [`app/http/app.ts`](../app/http/app.ts).
Routes are declared as data, so one definition gives the handler its validated input, the app its
checks, and the OpenAPI document its description.

## A route

```ts
const domainBlockList = defineRoute({
    method: "GET",
    path: "/api/v1/domain_blocks",
    summary: "Get domain blocks",
    description: "View domains the user has blocked.",
    docs: "https://docs.joinmastodon.org/methods/domain_blocks/#get",
    tags: ["domain_blocks"],
    auth: { require: "user", scope: "read:blocks", permission: "owner:block" },
    query: PageQuery({ default: 100, max: 200 }),
    responses: { 200: Paged(z.string()) },
    handler: async (ctx, { query, viewer }) => {
        const blocks = await domainBlockPage(ctx, viewer.accountId, query);
        return {
            status: 200,
            body: blocks.map((each) => each.domain),
            cursors: cursorsOf(blocks, query, (each) => each.id),
        };
    },
});
```

`defineRoute` in [`app/http/route.ts`](../app/http/route.ts) checks the types and erases them, so
routes of every shape fit in one list. Each module exports its list, such as `graphRoutes`, and
[`app/http/routes.ts`](../app/http/routes.ts) puts them together. Order matters only where paths
overlap, and a comment says so.

The main fields:

| Field                            | What it does                                                 |
| -------------------------------- | ------------------------------------------------------------ |
| `summary`, `description`, `docs` | the OpenAPI text, in Mastodon's words for client routes      |
| `auth`                           | who may call: `require`, `scope` and `permission`            |
| `params`, `query`, `body`        | Zod schemas for the path, query string and JSON or form body |
| `cookies`, `headers`             | Zod schemas for the cookies and headers the route reads      |
| `responses`                      | what it answers with, by status                              |
| `signed`                         | only remote instances may call it, signed                    |
| `rateLimit`                      | `false`, or a bucket of its own                              |
| `maxBodyBytes`                   | a larger body limit than 256 KiB, such as for uploads        |
| `maxAge`, `immutable`            | let others cache the response; otherwise nothing may         |

The comments in `route.ts` describe the rest. To add one, see
[Adding a route](guides/adding-a-route.md).

## What happens to a request

```
                          request
                             │
                             ▼
┌──────────────────────────────────────────────────────┐
│ security headers, CORS, body size limit              ├──▶ 413
├──────────────────────────────────────────────────────┤
│ unsigned routes: rate limit by client or bucket      ├──▶ 429
├──────────────────────────────────────────────────────┤
│ signed routes: check the Versia signature,           ├──▶ 401, 403, 429
│   then rate limit by the instance that signed        │
├──────────────────────────────────────────────────────┤
│ auth: find the token, check its scope                ├──▶ 401, 403, 422
├──────────────────────────────────────────────────────┤
│ permission: config's defaults and the user's roles   ├──▶ 403
├──────────────────────────────────────────────────────┤
│ input: params, query, body, cookies, headers         ├──▶ 422, or 400 on OAuth routes
├──────────────────────────────────────────────────────┤
│ handler(ctx, input)                                  ├──▶ an HttpError's status, or 500
└────────────────────────────┬─────────────────────────┘
                             ▼
               reply, sent as the response,
              no-store unless the route says,
                and signed on signed routes
```

The handler sees only input that passed its schemas, typed by them. `viewer` is typed by `auth`:
with `require: "user"`, `viewer.accountId` is a string, and without `auth`, there is no viewer.

## Input

- **Query and form values are strings.** Use the helpers in
  [`app/http/schemas.ts`](../app/http/schemas.ts): `Integer`, `Flag` for Mastodon's booleans,
  `Strings` for a key given more than once or as `key[]`, and `Text(max)`.
- **Limits from config** reach routes as arguments. `routes(settings)` passes each module what it
  needs, such as `searchRoutes(settings.search)`, and the module builds its schemas from it.
- **Paging.** `PageQuery({ default, max })` in [`app/http/paging.ts`](../app/http/paging.ts) reads
  `max_id`, `since_id`, `min_id` and `limit`, and clamps `limit`. The query function pages with
  `readPage` from `db/paging.ts`.

## Responses

A route declares a schema, or a kind, for each status it may answer with, from
[`app/http/responses.ts`](../app/http/responses.ts):

| Declared       | Handler returns                     | Sent as                    |
| -------------- | ----------------------------------- | -------------------------- |
| a Zod schema   | `{ status, body }`                  | JSON                       |
| `Paged(item)`  | `{ status, body: item[], cursors }` | JSON, with a `Link` header |
| `Linked(body)` | `{ status, body, cursors }`         | JSON, with a `Link` header |
| `NoBody`       | `{ status }`                        | no body                    |
| `Redirect`     | `{ status, location }`              | a redirect                 |
| `Binary(type)` | `{ status, file }`                  | a file                     |
| `Page`         | `{ status, page }`                  | HTML, from Hono's `html`   |
| `Upgrade`      | `{ status: 101, socket }`           | a WebSocket                |

Any reply may also set or delete `cookies`. Client API entities, such as `Status` and `Account`, are
Zod schemas in [`packages/client-api`](../packages/client-api/), and each module's `render.ts` turns
rows into them.

Responses aren't validated when serving. Tests build the app with `checkResponses: true`, which
validates every reply against its declared schema.

## Errors

To fail, throw one of the errors in [`app/http/errors.ts`](../app/http/errors.ts), such as
`NotFound`, `NotPermitted` or `Unprocessable`. Services throw them too, so a route doesn't need to
translate. The app sends them as `{ "error": "…", "error_description": "…" }`, as Mastodon does.
Anything else is logged and sent as a 500 with no details.

## Auth, scopes and permissions

Three checks decide who may call a route:

1. **`require`**: `"user"` needs a token for a user, `"app"` any token, and `"optional"` allows
   anyone, but a token that is sent must be valid. Without `auth`, tokens are ignored.
2. **`scope`**: the token must have it, or a scope that covers it, so `read` covers `read:statuses`.
   The scopes are Mastodon's, in [`app/kernel/scopes.ts`](../app/kernel/scopes.ts).
3. **`permission`**: what the caller may do on this instance. `[permissions]` in config says what
   everyone and every user may do, and roles add more. The names are Versia Server's, in
   [`app/kernel/permissions.ts`](../app/kernel/permissions.ts).

The app gets tokens and roles through `AppServices`, which [`app/services.ts`](../app/services.ts)
provides, so `http/` imports no feature module. How tokens are made is in the `auth` module.

## Rate limits

Every route is limited per client unless it sets `rateLimit: false`. A client is the signed-in
account, or else its IP address, where an IPv6 address counts by its /64. Signed routes are limited
per remote instance instead. Counts live in memory, or in the `rate_limits` table so several web
nodes share them, as `[http.rate_limit]` in config says. Responses carry the `RateLimit-*` headers
Versia requires. The code is in [`app/http/rate_limits.ts`](../app/http/rate_limits.ts).

Behind a reverse proxy, list it in `http.trusted_proxies`, so the client's address is read from
`X-Forwarded-For`.

## OpenAPI

`/openapi.json` is built from the routes by [`app/http/openapi.ts`](../app/http/openapi.ts), and
`/docs` shows it with Scalar. Schemas exported by `@versia/client-api` become named components.

A snapshot of the document is in [`app/http/openapi.json`](../app/http/openapi.json), and a test
fails when the API changes. When the change is intended, run `deno task update-openapi` and commit
the new snapshot, so the API change shows up in review.

## Health

`GET /health/live` answers `ok` in plain text, for load balancers. It isn't a route object, so it
isn't rate limited or in the OpenAPI document.

## Tests

`createTestApp(ctx, routes)` in [`app/testing/app.ts`](../app/testing/app.ts) builds the app with
the real services, unless a test replaces some. Call `app.request(…)` on it: there is no network in
between.
