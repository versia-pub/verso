# Moving accounts

A user moving to another account first has that account say it moved from theirs. Their instance
checks it before moving them and their followers, as Versia's
[migration extension](https://versia.pub/extensions/migration) has it. Mastodon only has settings
pages for this, so these methods are Verso's own.

## The AccountMigration entity

```json
{
    "previous": {
        "id": "01a1899c-2489-7b71-b747-d5847bd3147a",
        "acct": "alice@old.example",
        "…": "…"
    },
    "moved": null
}
```

| Field      | Type            | Description                                                                        |
| ---------- | --------------- | ---------------------------------------------------------------------------------- |
| `previous` | Account or null | The [Account](https://docs.joinmastodon.org/entities/Account/) the user moved from |
| `moved`    | Account or null | The Account the user moved to                                                      |

## Methods

Every method needs a user's token, with the `read:accounts` scope to read and `write:accounts` to
change.

### `GET /api/v1/migration`

The user's AccountMigration.

### `PUT /api/v1/migration/previous`

Says the user moved from the account at `acct`, such as `alice@old.example`, and returns the
AccountMigration. Verso fetches the account if it doesn't have it. The user's followers' instances
are sent the change.

```sh
curl -X PUT https://social.example/api/v1/migration/previous \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"acct": "alice@old.example"}'
```

An address with no account, or the user's own, gets a `422`. Versia names one account a user moved
from, so this replaces any other, where Mastodon keeps a list of aliases.

### `DELETE /api/v1/migration/previous`

Says the user moved from no account, and returns the AccountMigration.

### `POST /api/v1/migration/move`

Moves the user to the account at `acct`, and returns the AccountMigration. Verso fetches the account
again first, and the account must say the user moved from theirs. The user's local followers follow
it instead, and the instances of their remote followers, and the account's own, are sent the move.

```sh
curl -X POST https://social.example/api/v1/migration/move \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"acct": "bob@new.example"}'
```

The user gets a `422` if the account can't be fetched, doesn't say so, is suspended, deleted or has
moved itself, or if the user already moved to it, or moved less than 30 days ago.

Once moved, the user gets a `403` with `Your login is currently disabled` from every method that
needs a user, except these, streaming, and the account and profile settings: `verify_credentials`,
`update_credentials`, `/api/v1/profile`, `/api/v1/preferences` and `/api/v1/web_preferences`.
Mastodon refuses the settings methods too.

### `DELETE /api/v1/migration/move`

Cancels the user's move, and returns the AccountMigration. Followers that already moved stay with
the new account, and the user still can't move again until 30 days after they moved.
