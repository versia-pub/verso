# The client API

Verso speaks the Mastodon client API, so Mastodon apps work with it as they are. It reports itself
as Mastodon 4.3.0, the version apps check to decide which features to use. These pages are for
people who write apps, or want to know what an app can do with Verso:

- [Mastodon API compatibility](compatibility.md) lists every Mastodon method, and whether Verso has
  it.
- [Differences from Mastodon](differences.md) says where the methods Verso has behave differently.
- [Roles](roles.md) documents Verso's role methods.
- [Custom emoji](emojis.md) documents adding, changing and deleting custom emoji.
- [Reactions](reactions.md) documents reacting to statuses with emoji.

Every instance also serves its own API reference: `/docs` shows it, and `/openapi.json` is the
OpenAPI document it is made from. Each method there says what it needs, and where Verso differs from
Mastodon.

## Logging in

Apps log users in with OAuth, as on Mastodon:

1. **Register the app** with `POST /api/v1/apps`, giving its name, redirect URIs and scopes. The
   response has a client id and secret. The secret is shown only this once.
2. **Send the user to `/oauth/authorize`**, with the client id, a redirect URI, the scopes and,
   optionally, a PKCE `code_challenge` with method `S256`.
3. **The user logs in.** Verso has no passwords: it sends the user to an OpenID Connect provider,
   asking them to pick one if the instance has several, then asks whether to let the app in.
4. **Exchange the code** at `POST /oauth/token`, with `grant_type=authorization_code`, the client id
   and secret, the redirect URI and, with PKCE, the `code_verifier`. The code works once, for 10
   minutes.

For apps that can't receive a redirect, `urn:ietf:wg:oauth:2.0:oob` as the redirect URI shows the
user the code to copy. `GET /.well-known/oauth-authorization-server` describes these endpoints.

- **Tokens don't expire.** `POST /oauth/revoke` revokes one, and closes the streams it opened.
- **An app's own token**, from `grant_type=client_credentials`, acts for no user. Methods that act
  for a user refuse it with a `422`, as on Mastodon.
- **New accounts** are made at a user's first login, if the instance lets them in. There is no
  `POST /api/v1/accounts`.

## Scopes and permissions

Two things decide what a request may do:

- **Scopes** limit what the app may do for the user. They are Mastodon's, such as `read`,
  `write:statuses` or `push`, and a broad scope covers its narrow ones: `read` covers
  `read:statuses`. The token holds the scopes the user allowed.
- **Permissions** limit what the user may do on the instance at all, such as posting statuses or
  managing roles. The instance gives every user some, and roles give more. Logged-out requests get
  the instance's anonymous [permissions](../admin/configuring.md#permissions).

A request needs both: the method's scope in its token, and the method's permission for its user.
Missing either is a `403`. `/docs` names each method's scope and permission.

## Ids, pages and errors

- **Ids are strings**, as on Mastodon, holding UUIDs rather than numbers. They are UUIDv7s, so they
  sort by when they were made, but apps should treat them as opaque.
- **Lists come in pages**, newest first, with Mastodon's `max_id`, `since_id`, `min_id` and `limit`.
  The `Link` header has the next and previous pages.
- **Errors** are JSON, as on Mastodon: `{ "error": "…" }`, with `error_description` when there is
  more to say. A request that doesn't validate is a `422` saying what is wrong with it.
- **Rate limits** count per account, or per IP address without one. Responses carry the IETF draft's
  `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers, not Mastodon's
  `X-RateLimit-*` ones. Past the limit, requests get a `429`, with `Retry-After`.

## Text

Statuses are plain text by default, as on Mastodon: links, mentions and hashtags are found and
linked. Posting with `content_type` set to `text/markdown`, as on Pleroma, formats the status as
Markdown instead. `GET /api/v1/statuses/:id/source` gives the text back as it was written, with its
`content_type`, for editing. An edit keeps the format unless it sets `content_type`.

## Streaming

`GET /api/v1/streaming` opens a WebSocket, on the same host and port as the rest of the API, as
`/api/v2/instance` says. The token can be sent as `Authorization`, as the `access_token` query
parameter, or as `Sec-WebSocket-Protocol`, which browsers can set.
