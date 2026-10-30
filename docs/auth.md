# Logging in and permissions

Verso has no passwords. Users log in through an OpenID Connect provider, such as Keycloak or
Authentik, and apps get OAuth access tokens like on Mastodon. What a user can then do depends on the
token's scopes and the user's roles.

The code is in [`app/auth/`](../app/auth/), with accounts and roles in
[`app/accounts/`](../app/accounts/).

## Apps

Apps register with `POST /api/v1/apps` and get a client id and secret. The secret is shown once, and
only its SHA-256 is stored. Every secret and token Verso makes is 256 random bits, from
[`app/auth/secrets.ts`](../app/auth/secrets.ts), so a fast hash is enough.

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

Each login is a flow in `oauth_flows`, from `/oauth/authorize` until the app exchanges its code. A
cookie ties the flow to the browser that started it, so another browser can't finish it. The user
has 30 minutes to log in, and the app 10 minutes to use its code.

Issuers are listed in `[[auth.issuers]]` in config. Each one is an `IdentityProvider` from
[`app/kernel/identity.ts`](../app/kernel/identity.ts), using the authorization code flow with PKCE.

Apps can send an S256 `code_challenge`, and must then send its verifier with the code. Out-of-band
apps, which use `urn:ietf:wg:oauth:2.0:oob`, are shown the code to copy instead of being redirected.
The `client_credentials` grant gives an app a token for itself, with no user.

The browser pages are plain HTML, in [`app/auth/pages.ts`](../app/auth/pages.ts). Forms carry a CSRF
token and their origin is checked, so other sites can't submit them.

## Accounts from logins

On each login, `provision` in [`app/accounts/provision.ts`](../app/accounts/provision.ts) finds the
account linked to the issuer and the user's `sub`, or creates one.

Logins are linked by issuer URL and subject only, never by email, so another issuer can't take over
an account by claiming the same address. This also means changing an issuer's `url` unlinks its
accounts.

A new account's username comes from `username_claim`, `preferred_username` by default, trimmed to
what Versia allows. If it's taken, Verso tries `name2`, `name3` and so on. Whether a new account is
created at all depends on `registration`, as [Configuring](admin/configuring.md#logging-in)
explains.

`roles = [{ claim, contains, role }]` grants roles at every login, and takes back roles the issuer
granted that no longer match. Roles an admin granted aren't touched.

## The development login

With `mode = "development"` and `[auth] dev_login = true`, Verso adds an issuer whose login form
takes any username, with no password. It's off by default, refused outside development mode, and
logged as a warning at startup. See [`app/auth/dev_login.ts`](../app/auth/dev_login.ts).

## Access tokens

Only a token's hash is stored, in `access_tokens`, along with its app, its account (`null` for an
app's own token) and its scopes. Tokens are looked up by hashing what the client sent.

Tokens don't expire. An app revokes one with `POST /oauth/revoke`, which deletes it and tells every
process on the `tokens.revoked` channel, so streams opened with the token close straight away.

Push subscriptions are the one place a token is stored in full, so pushes can include it as
Mastodon's do. See
[Notifications and push](notifications.md#subscriptions-keep-their-access-tokens).

The HTTP app reads the token from `Authorization: Bearer`, through `authenticateToken` in
[`app/auth/tokens.ts`](../app/auth/tokens.ts), and gives the route a `viewer`. See
[HTTP](http.md#auth-scopes-and-permissions).

## Scopes

Scopes are Mastodon's, listed in [`app/kernel/scopes.ts`](../app/kernel/scopes.ts). An app registers
the most it may ask for, a login asks for some of those, and the token holds what the user allowed.
A broad scope covers its narrower ones, as `read` covers `read:statuses`. Each route names the scope
it needs in its `auth`.

## Permissions and roles

Scopes limit what an app can do for a user, and permissions limit what the user can do at all.
Routes check both:

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

Permission names come from Versia Server, and are in
[`app/kernel/permissions.ts`](../app/kernel/permissions.ts). `owner:` permissions cover the user's
own things, such as `owner:note`, `read:` ones cover viewing, and bare ones such as `roles` cover
everyone's. A permission is only added once a route checks it.

`[permissions]` in config sets what everyone can do: `anonymous` for logged-out visitors, and
`default` for every user. Roles add more. Each role has permissions and a priority. Users with the
`roles` permission can create, change and grant roles below their own highest, with permissions they
have themselves. Admins can also use `verso admin roles` and `verso admin users grant-role`.

When an account's roles change, every process hears about it on `roles.changed` and looks the
permissions up again, so open streams pick up the change.

## Tests

[`app/testing/fake_idp.ts`](../app/testing/fake_idp.ts) is an OpenID Connect provider in the test
process, so tests can run the whole login, from `/oauth/authorize` to a token.
