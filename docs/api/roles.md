# Roles

Roles give accounts [permissions](../admin/configuring.md#permissions) beyond what every user has.
Verso's role methods are the same as [Versia Server's](https://github.com/versia-pub/server), so
apps made for it work. Admins can also manage roles with
[`verso admin`](../admin/commands.md#verso-admin-roles).

## The Role entity

```json
{
    "id": "01a1899c-2489-7b71-b747-d5847bd3147a",
    "name": "Moderator",
    "description": "Looks after the instance's emoji.",
    "permissions": ["blocks", "emojis"],
    "priority": 50,
    "visible": true,
    "color": "#ff3838",
    "icon": "https://social.example/role-icons/moderator.png"
}
```

| Field         | Type     | Description                                                  |
| ------------- | -------- | ------------------------------------------------------------ |
| `id`          | string   | The role's id                                                |
| `name`        | string   | Up to 128 characters, unique whatever the case               |
| `description` | string   | Up to 1024 characters, or empty                              |
| `permissions` | string[] | The permissions it gives                                     |
| `priority`    | integer  | Its rank: roles with a higher priority manage those below    |
| `visible`     | boolean  | Whether it is shown on the profiles of accounts that have it |
| `color`       | string   | A hex colour, such as `#ff3838`, or empty for none           |
| `icon`        | string   | The URL of an image for the role. Left out when it has none  |

## Who may manage roles

A user with the `roles` permission can manage roles below their own highest role. When creating or
changing a role, they can only set a priority below their own highest, and only give permissions
they have themselves, though a role keeps the permissions it already had.

To grant or take away a role, it must be below their highest, and the account must be their own or
rank below them. They can only grant a role if they have all of its permissions. A user without any
roles can't manage roles, even with the `roles` permission. Anything else gets a `403` saying why.

## Methods

Every method needs a user's token. Reading needs the `read:accounts` scope, and changes need
`write:accounts` and the `roles` permission.

### `GET /api/v1/roles`

Every role, highest priority first.

### `GET /api/v1/roles/:id`

A role, or `404` if there's none.

### `POST /api/v1/roles`

Creates a role and returns it with a `201`. Every field except `name` is optional:

| Field         | Default |
| ------------- | ------- |
| `name`        |         |
| `description` | `""`    |
| `permissions` | `[]`    |
| `priority`    | `0`     |
| `visible`     | `false` |
| `color`       | `""`    |
| `icon`        | `null`  |

```sh
curl -X POST https://social.example/api/v1/roles \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Moderator", "permissions": ["blocks", "emojis"], "priority": 50}'
```

A name that's already taken gets a `422`.

### `PATCH /api/v1/roles/:id`

Changes the given fields and returns the role. `icon: null` removes the icon.

### `DELETE /api/v1/roles/:id`

Deletes a role, taking it away from everyone who has it, and returns `{}`.

### `GET /api/v1/accounts/:id/roles`

A local account's roles, highest priority first, including hidden ones. Remote accounts have no
roles here, so they get a `404`.

### `POST /api/v1/accounts/:id/roles/:role_id`

Gives a local account a role, and returns `{}`, even if it already had the role.

### `DELETE /api/v1/accounts/:id/roles/:role_id`

Takes a role away from a local account, if it was granted by hand, and returns `{}`. Roles from a
login provider follow its claims, as
[Roles from your provider](../admin/configuring.md#roles-from-your-provider) explains.

## Roles on accounts

Mastodon's own entities show roles too. `roles` on an Account lists its visible roles, as
`{ id, name, color }`. `role` on the user's own Account, from `verify_credentials`, is their highest
role, with `permissions` as Mastodon's bitmask. Mastodon apps use it to decide whether to show admin
tools, as [Moderating](../admin/moderating.md#moderators) explains.
