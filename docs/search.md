# Search

Verso implements Mastodon's `/api/v2/search` and `/api/v1/accounts/search` in the database it
already has, with Postgres's full-text search or SQLite's FTS5. There's no search server to run.

The code is in [`app/search/`](../app/search/).

## Indexing

```
a status is posted, edited or received        an account is created, changed or received
  │                                             │
  ▼                                             ▼
indexStatuses (subscriber)                    indexAccountsOf (subscriber)
  │  content warning, text, media descriptions  │  username, display name, domain
  ▼                                             ▼
searchWords: letters and digits, lower case, no accents
  │
  ▼
note_search / account_search, in the same transaction
```

Verso splits text into words itself, in [`app/search/words.ts`](../app/search/words.ts), rather than
leaving it to each database. That way Postgres and SQLite find the same things, and words can never
contain a database's query syntax. "Café" is found as "cafe".

Every status is indexed, local and remote, except boosts. Who can find what is decided at search
time, so an author changing `indexable` doesn't need reindexing. Deleting a status or account
deletes its words through a cascade, plus a trigger on SQLite that clears the FTS5 row.
`verso migrate` indexes anything that isn't indexed yet, 500 at a time.

| Database | Words of a status or account                                                 |
| -------- | ---------------------------------------------------------------------------- |
| Postgres | a `document` tsvector in `note_search`, with a GIN index                     |
| SQLite   | the FTS5 table `note_search_text`, whose rowid is the `note_search` row's id |

Accounts are kept the same way, in `account_search`. FTS5 tables can't reference other tables, so on
SQLite the plain table holds the reference and the FTS5 table only the words. Both are in
[`app/search/index_queries.ts`](../app/search/index_queries.ts).

## Matching words

`matching` in `index_queries.ts` finds rows with words starting with each word searched for, so
`verso soc` finds "Verso social". One-letter words only match whole words, since so many words start
with any one letter. A phrase in quotes matches its words in order.

## Statuses

Only signed-in users can search statuses. A search finds, newest first, public statuses by
`indexable` authors, and statuses in the viewer's library: ones they wrote, were mentioned in, liked
or boosted. Results only include statuses the viewer can see, by authors they don't block or mute.
`in:public` and `in:library` limit the search to one of the two.

The query syntax is Mastodon's, parsed in [`app/search/query.ts`](../app/search/query.ts):

| Clause                                  | Finds statuses                                  |
| --------------------------------------- | ----------------------------------------------- |
| `word`, `"a phrase"`, `#hashtag`        | with it                                         |
| `-word`, or any clause with `-`         | without it                                      |
| `from:me`, `from:user@domain`           | by that account                                 |
| `has:media`, `is:sensitive`, `is:reply` | with media, marked sensitive, or replies        |
| `language:en`                           | in that language                                |
| `before:`, `after:`, `during:`          | by day (`2024-05-01`, in UTC) or by millisecond |
| `in:public`, `in:library`, `in:all`     | among those statuses                            |

Unknown prefixes are searched as words. Verso has no polls or link previews yet, so `has:poll` and
the like find nothing.

A query has to narrow the search through an index, with a word, a phrase, a hashtag, `from:`,
`in:library` or `account_id`. A query without one, such as `is:sensitive` alone, finds nothing
rather than reading every status. The queries are in
[`app/search/note_search_queries.ts`](../app/search/note_search_queries.ts).

## Accounts

[`app/search/accounts.ts`](../app/search/accounts.ts) follows Mastodon's order. The account at an
address, such as `@alice@example.com`, comes first, fetched if `resolve` is set and Verso doesn't
have it. Then come accounts whose words start with the query's: those the viewer follows or is
followed by, then those with the most followers.

Without signing in, a query shorter than 5 characters only finds the account at that address.
`following` only finds the viewer and the accounts they follow.

## Hashtags and URLs

Hashtags are matched by prefix in `tags`, shortest first, among those used by public or unlisted
statuses. `tags` has each hashtag once, in lower case, and shown as it was first written. See
[`app/search/hashtag_queries.ts`](../app/search/hashtag_queries.ts).

With `resolve`, a query that is the URL of a Versia `User` or `Note` (the `uri` Verso shows for an
account or status) finds only that entity, fetched if Verso doesn't have it. See
[`app/search/urls.ts`](../app/search/urls.ts).

## Limits

`[search]` in config limits how much a single search can ask for. Mastodon has no such limits.

| Setting        | Default | Limits                               |
| -------------- | ------- | ------------------------------------ |
| `query_length` | 500     | the length of a query, in characters |
| `max_offset`   | 10,000  | how many results a search may skip   |

Routes need the `search` permission, and `/api/v2/search` the `read:search` scope.

## Tests

Search tests run on whichever database the tests use, so `nix flake check` runs them on PGlite,
SQLite and Postgres. See [Database](database.md#tests).
