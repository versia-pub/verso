# The web frontend

Verso serves two things to browsers: a web app, and pages it renders itself for addresses such as
`/@alice`, for visitors who aren't logged in, link previews and search engines.

## The web app

The web app is a SvelteKit app in [`packages/web`](../packages/web), built as static files with no
server rendering. For now it's only a placeholder page.

`deno task build-web` builds it into `packages/web/build`, and the Nix package puts that build into
the binary. A web node reads it into memory at startup, in [`app/http/web.ts`](../app/http/web.ts).
If it isn't built, the node logs a warning and serves only the API.

Its files are served under `/_web/`, rate limited in a bucket of their own. Those under
`/_web/immutable/` are cached for a year. The page's Content-Security-Policy allows its own files
and the hash of its inline script.

A GET or HEAD that accepts HTML, for an address no route serves, gets the app's page, unless the
address is under one of `reservedPaths`. Of those, only `/oauth/web-callback` gets the page. A test
fails if a route is outside `reservedPaths`, so a new top-level path must be added there.

The app logs in as the public app `verso-web`, which every instance has, as
[Differences from Mastodon](api/differences.md#apps) explains.

## Pages Verso renders

The pages are in [`app/web/`](../app/web/), written with Hono's JSX. Each is the web app's page with
the view put into it, with OpenGraph tags for link previews, so the app still starts on top.

| Address                      | Shows                                                  | File          |
| ---------------------------- | ------------------------------------------------------ | ------------- |
| `/`                          | the instance's description and rules, and latest posts | `front.tsx`   |
| `/@alice`, `/@bob@b.example` | an account, with its pinned and latest posts           | `profile.tsx` |
| `/@alice/:id`                | a status, with its thread                              | `status.tsx`  |
| `/tags/cats`                 | a hashtag, with its latest posts                       | `tag.tsx`     |

[`views.ts`](../app/web/views.ts) lists them, each with the permission anonymous visitors need to
see it. A page is rendered as an anonymous visitor sees it, whatever the request accepts. If
anonymous visitors may not see it, the address gets the web app's page instead, where the visitor
may be logged in. If there's nothing there, it gets the web app's page as a 404.

A remote account Verso doesn't know isn't fetched. A status not by the account in its address, a
boost, and one anonymous visitors may not see get a 404, including a suspended account's. Mastodon
answers 403 or 410 for those.

A hashtag no status has used, nor anyone followed or featured, gets a 404. Posts on the hashtag and
front pages come only from the feeds `[timelines_access]` lets anyone see. Mastodon renders no posts
on these two pages, only their meta tags.

Pages may show pictures from any `https:` address, since remote accounts' are stored by URL.

To add a page, write its view in `app/web/`, add it to `viewsFor`, and test it with `open` from
[`app/web/testing.ts`](../app/web/testing.ts).
