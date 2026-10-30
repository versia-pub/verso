# The client API

Verso implements the Mastodon client API, so Mastodon apps work with it unchanged. It reports itself
as Mastodon 4.3.0, which apps check to decide which features to use. These pages are for people
writing apps, or wondering what an app can do with Verso:

- [Mastodon API compatibility](compatibility.md) lists every Mastodon method, and whether Verso has
  it.
- [Differences from Mastodon](differences.md) lists where Verso's methods behave differently.
- [Roles](roles.md) documents Verso's role methods.
- [Custom emoji](emojis.md) documents managing custom emoji.
- [Reactions](reactions.md) documents emoji reactions to statuses.

Every instance also serves its own API reference at `/docs`, built from the OpenAPI document at
`/openapi.json`. It shows what each method needs, and where Verso differs from Mastodon.

## Logging in

Apps log users in with OAuth, the same way as on Mastodon:

1. Register the app with `POST /api/v1/apps`, giving its name, redirect URIs and scopes. The
   response has a client id and secret, and the secret is only shown this once.
2. Send the user to `/oauth/authorize` with the client id, a redirect URI, the scopes and,
   optionally, a PKCE `code_challenge` with method `S256`.
3. The user logs in. Verso has no passwords, so it sends the user to an OpenID Connect provider,
   letting them pick one if the instance has several, and then asks whether to allow the app.
4. Exchange the code at `POST /oauth/token`, with `grant_type=authorization_code`, the client id and
   secret, the redirect URI and, with PKCE, the `code_verifier`. The code can be used once, within
   10 minutes.

Apps that can't receive a redirect can use `urn:ietf:wg:oauth:2.0:oob` as the redirect URI, which
shows the user the code to copy. `GET /.well-known/oauth-authorization-server` describes these
endpoints.

Tokens don't expire. `POST /oauth/revoke` revokes one and closes any streams it opened. An app's own
token, from `grant_type=client_credentials`, doesn't act for a user, so methods that need one refuse
it with a `422`.

Accounts are created the first time a user logs in, if the instance allows it. There's no
`POST /api/v1/accounts`.

## Scopes and permissions

Scopes limit what an app can do for the user. They're Mastodon's, such as `read`, `write:statuses`
or `push`, and a broad scope covers its narrower ones, as `read` covers `read:statuses`.

Permissions limit what the user can do on the instance at all, such as posting statuses or managing
roles. Every user gets the instance's default permissions, and roles add more. Logged-out requests
get the instance's anonymous [permissions](../admin/configuring.md#permissions).

A request needs both the method's scope in its token and the method's permission for its user, or it
gets a `403`. `/docs` lists each method's scope and permission.

## Ids, pages and errors

Ids are strings holding UUIDs rather than numbers. They're UUIDv7s, so they sort by creation time,
but apps should treat them as opaque.

Lists are paged newest first, with Mastodon's `max_id`, `since_id`, `min_id` and `limit`, and the
`Link` header points to the next and previous pages.

Errors are JSON, `{ "error": "…" }`, with `error_description` when there's more to say. A request
that doesn't validate gets a `422` saying what's wrong.

Rate limits are counted per account, or per IP address without one. Responses carry Mastodon's
`X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers, plus the IETF draft's
`RateLimit-*` ones, which Versia requires. Over the limit, requests get a `429` with `Retry-After`.

## Text

Statuses are plain text by default, with links, mentions and hashtags linked automatically. Posting
with `content_type` set to `text/markdown`, as on Pleroma, formats the status as Markdown instead.
`GET /api/v1/statuses/:id/source` gives the text back as it was written, with its `content_type`,
for editing. An edit keeps the format unless it sets `content_type`.

## Streaming

`GET /api/v1/streaming` opens a WebSocket on the same host and port as the rest of the API, which
`/api/v2/instance` reports. The token can be sent in `Authorization`, the `access_token` query
parameter, or `Sec-WebSocket-Protocol`, which browsers can set.

## TypeScript client

[`packages/client-api/`](../../packages/client-api/) has a client for the API, for Deno and
browsers. It isn't published yet. It checks each response against the package's schemas, throws an
`ApiError` with the instance's error on failure, and returns lists as pages that follow the `Link`
header:

```ts
import { Client } from "@versia/client-api";

const client = new Client("https://verso.example", { token });
const me = await client.accounts.verifyCredentials();
for await (const status of await client.accounts.statuses(me.id)) console.log(status.content);
```
