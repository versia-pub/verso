# Search

Verso searches accounts, statuses and hashtags, as Mastodon's `/api/v2/search` and
`/api/v1/accounts/search` do, in the database it already has: Postgres's full-text search, or
SQLite's FTS5. There is no search server to run.

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

- **Verso splits the words itself**, in [`app/search/words.ts`](../app/search/words.ts), rather than
  leaving it to each database, so Postgres and SQLite find the same things, and words never carry a
  database's query syntax. "Café" is found as "cafe".
- **Every status is indexed**, local and remote, other than boosts. Who may find which is decided
  when searching, so an author changing `indexable` needs no reindexing.
- **Deleting a status or account** deletes its words, by a cascade, and on SQLite a trigger that
  clears the FTS5 row.
- **`verso migrate`** indexes whatever isn't indexed yet, 500 at a time, such as statuses from
  before search existed.

| Database | Words of a status or account                                                 |
| -------- | ---------------------------------------------------------------------------- |
| Postgres | a `document` tsvector in `note_search`, with a GIN index                     |
| SQLite   | the FTS5 table `note_search_text`, whose rowid is the `note_search` row's id |

Accounts are kept the same way, in `account_search`. FTS5 tables can't reference other tables, so on
SQLite the plain table holds the reference and the FTS5 table only the words. Both are in
[`app/search/index_queries.ts`](../app/search/index_queries.ts).

## Matching words

`matching` in `index_queries.ts` finds rows whose words start with each word searched for:
`verso soc` finds "Verso social". A word of one letter matches only whole words, since one letter
starts most of them. A phrase, in quotes, matches its words one after another.

## Statuses

Only signed-in users search statuses, as on Mastodon. A search finds, newest first:

- **public statuses by authors who are `indexable`**, and
- **the viewer's library**: statuses they wrote, were mentioned in, liked or boosted,

of which only those the viewer may see, by authors they don't block or mute. `in:public` and
`in:library` search only one of these.

The query is read as Mastodon reads it, in [`app/search/query.ts`](../app/search/query.ts):

| Clause                                  | Finds statuses                                  |
| --------------------------------------- | ----------------------------------------------- |
| `word`, `"a phrase"`, `#hashtag`        | with it                                         |
| `-word`, or any clause with `-`         | without it                                      |
| `from:me`, `from:user@domain`           | by that account                                 |
| `has:media`, `is:sensitive`, `is:reply` | with media, marked sensitive, or replies        |
| `language:en`                           | in that language                                |
| `before:`, `after:`, `during:`          | by day (`2024-05-01`, in UTC) or by millisecond |
| `in:public`, `in:library`, `in:all`     | among those statuses                            |

A prefix Mastodon doesn't know is searched as words. Verso has no polls or link previews, so
`has:poll` and the like find nothing.

**A query must narrow the search through an index**: a word, a phrase, a hashtag, `from:`,
`in:library` or `account_id`. One that doesn't, such as `is:sensitive` alone, finds nothing, rather
than reading every status. The queries are in
[`app/search/note_search_queries.ts`](../app/search/note_search_queries.ts).

## Accounts

[`app/search/accounts.ts`](../app/search/accounts.ts) finds accounts as Mastodon does:

1. **The account at an address**, such as `@alice@example.com`, comes first. With `resolve`, Verso
   fetches it if it doesn't have it.
2. **Then accounts whose words start with the query's**: the ones the viewer follows or is followed
   by first, then those with the most followers.

Without signing in, a query of fewer than 5 characters finds only the account at its address.
`following` finds only the viewer and the accounts they follow.

## Hashtags and URLs

- **Hashtags** are found by how they start, shortest first, among those public or unlisted statuses
  use. Verso has no hashtags table: a hashtag is its name, in `note_tags`. See
  [`app/search/hashtag_queries.ts`](../app/search/hashtag_queries.ts).
- **URLs.** With `resolve`, a query that is the URL of a Versia `User` or `Note`, the `uri` Verso
  shows for an account or status, finds that alone, fetched if Verso doesn't have it. See
  [`app/search/urls.ts`](../app/search/urls.ts).

## Limits

`[search]` in config limits how much one search may ask for. Mastodon has no such limits.

| Setting        | Default | Limits                               |
| -------------- | ------- | ------------------------------------ |
| `query_length` | 500     | the length of a query, in characters |
| `max_offset`   | 10,000  | how many results a search may skip   |

Routes need the `search` permission, and `/api/v2/search` the `read:search` scope.

## Tests

Search tests run on whichever database the tests use, like the rest, so `nix flake check` runs them
on PGlite, SQLite and Postgres. See [Database](database.md#tests).
