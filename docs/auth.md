# Logging in and permissions

Verso has no passwords. Users log in through an OpenID Connect provider, such as Keycloak or
Authentik, and apps get OAuth access tokens, as on Mastodon. What a user may then do depends on the
token's scopes and on the user's roles.

The code is in [`app/auth/`](../app/auth/), with accounts and roles in
[`app/accounts/`](../app/accounts/).

## Apps

A client app registers with `POST /api/v1/apps`, as on Mastodon, and gets a client id and secret.
The secret is shown once, and only its SHA-256 is stored. Every secret and token Verso makes is 256
random bits, from [`app/auth/secrets.ts`](../app/auth/secrets.ts), so a fast hash is enough: there
is nothing to guess.

## Logging in

```
app            browser                              Verso                    issuer
 │                │                                   │                         │
 │── opens ──────►│                                   │                         │
 │                │── GET /oauth/authorize ──────────►│                         │
 │                │                                   │ checks the app, starts  │
 │                │                                   │ a flow, sets a cookie   │
 │                │◄── which issuer? ─────────────────│                         │
 │                │── POST /oauth/authorize/issuer ──►│                         │
 │                │◄── redirect ──────────────────────│                         │
 │                │── user logs in ────────────────────────────────────────────►│
 │                │◄── redirect back ───────────────────────────────────────────│
 │                │── GET /oauth/callback ───────────►│                         │
 │                │                                   │ checks the ID token,    │
 │                │                                   │ finds or makes the      │
 │                │                                   │ account                 │
 │                │◄── allow the app? ────────────────│                         │
 │                │── POST /oauth/consent ───────────►│                         │
 │                │◄── redirect with a code ──────────│                         │
 │◄── code ───────│                                   │                         │
 │── POST /oauth/token: code, secret ────────────────►│                         │
 │◄── access token ───────────────────────────────────│                         │
```

- **A flow** in `oauth_flows` follows one login, from `/oauth/authorize` until the app exchanges its
  code. A cookie ties it to the browser that started it, so another browser can't finish it. The
  user has 30 minutes to log in, and the app 10 minutes to use its code.
- **Issuers** are listed in `[[auth.issuers]]` in config. Each is an `IdentityProvider`, from
  [`app/kernel/identity.ts`](../app/kernel/identity.ts), using the code flow with PKCE. Verso never
  sees passwords.
- **Out-of-band apps**, which use `urn:ietf:wg:oauth:2.0:oob`, are shown the code to copy instead of
  being redirected.
- **PKCE.** Apps may send an S256 `code_challenge`, and must then send its verifier with the code.
- **`client_credentials`** gives an app a token for itself, with no user.

The browser pages are plain HTML, in [`app/auth/pages.ts`](../app/auth/pages.ts). Forms carry a
token and are checked for their origin, so other sites can't post them.

## Accounts from logins

On a login, `provision` in [`app/accounts/provision.ts`](../app/accounts/provision.ts) finds the
account linked to the issuer and the user's `sub`, or makes one:

- **Logins are linked by issuer URL and subject only**, never by email, so another issuer can't take
  over an account by claiming the same address. Changing an issuer's `url` unlinks its accounts.
- **Registration** is `"open"`, `"closed"`, or open to anyone whose claim holds a value, such as
  `{ claim = "groups", contains = "social-users" }`.
- **The username** comes from `username_claim`, `preferred_username` by default, cut down to what
  Versia allows. If it is taken, Verso tries `name2`, `name3` and so on.
- **Roles from claims.** `roles = [{ claim, contains, role }]` grants roles at every login, and
  takes back the ones the issuer granted that no longer match. Roles an admin granted stay.

## The development login

With `mode = "development"` and `[auth] dev_login = true`, Verso adds an issuer whose login form
takes any username, with no password. It is off by default, refused outside development mode, and
logged as a warning at startup. See [`app/auth/dev_login.ts`](../app/auth/dev_login.ts).

## Access tokens

- **Only the hash is stored**, in `access_tokens`, with its app, its account (or `null` for an app's
  own token) and its scopes. A token is looked up by hashing what the client sent.
- **Tokens don't expire.** An app revokes one with `POST /oauth/revoke`, which deletes it.
- **Revoking tells every process**, on the `tokens.revoked` channel, so streams opened with the
  token close at once.
- **Push subscriptions** are the one place a token is stored as it is, so pushes can carry it, as
  Mastodon's do. See [decision 7](decisions/0007-push-subscriptions-keep-tokens.md).

The HTTP app reads the token from `Authorization: Bearer`, through `authenticateToken` in
[`app/auth/tokens.ts`](../app/auth/tokens.ts), and gives the route a `viewer`. See
[HTTP](http.md#auth-scopes-and-permissions).

## Scopes

Scopes are Mastodon's, listed in [`app/kernel/scopes.ts`](../app/kernel/scopes.ts). An app registers
the most it may ask for, a login asks for some of them, and the token holds what the user allowed. A
broad scope covers its narrow ones: `read` covers `read:statuses`. A route names the scope it needs,
in its `auth`.

## Permissions and roles

Scopes limit what an app may do for a user. Permissions limit what the user may do at all. A route
checks both:

```
token has the route's scope, or one covering it?   no ──► 403
          │ yes
          ▼
caller has the route's permission?                 no ──► 403
  a user:   [permissions] default, and their roles'
  no user:  [permissions] anonymous
          │ yes
          ▼
handler
```

- **Permissions** are named as in Versia Server, in
  [`app/kernel/permissions.ts`](../app/kernel/permissions.ts). `owner:` ones cover the user's own
  things, such as `owner:note`; `read:` ones cover viewing; bare ones, such as `roles`, cover
  everyone's. A name is only added when a route checks it.
- **`[permissions]`** in config sets what everyone may do: `anonymous` for logged-out visitors, and
  `default` for every user.
- **Roles** add more. Each has permissions and a priority. Users with the `roles` permission may
  create, change and grant roles below their own highest, with permissions they have themselves.
  Admins can also use `verso admin roles` and `verso admin users grant-role`.
- **Changes reach open streams.** When an account's roles change, every process hears it on
  `roles.changed`, and looks the permissions up again.

## Tests

[`app/testing/fake_idp.ts`](../app/testing/fake_idp.ts) is an OpenID Connect provider in the test
process, so tests can run the whole login, from `/oauth/authorize` to a token.
