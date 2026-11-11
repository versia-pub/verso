# Moving accounts

A user moving to Verso from another account first says which account they moved from. That account's
instance then checks it before moving them, as Versia's
[migration extension](https://versia.pub/extensions/migration) has it. Mastodon only has settings
pages for this, so these methods are Verso's own.

## The AccountMigration entity

```json
{
    "previous": {
        "id": "01a1899c-2489-7b71-b747-d5847bd3147a",
        "acct": "alice@old.example",
        "…": "…"
    }
}
```

| Field      | Type            | Description                                                                        |
| ---------- | --------------- | ---------------------------------------------------------------------------------- |
| `previous` | Account or null | The [Account](https://docs.joinmastodon.org/entities/Account/) the user moved from |

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
