# Roles

Roles give accounts [permissions](../admin/configuring.md#permissions) beyond what every user has.
Verso's role methods are [Versia Server's](https://github.com/versia-pub/server), so apps made for
it work. Admins can also manage roles with [`verso admin`](../admin/commands.md#verso-admin-roles).

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

A user with the `roles` permission manages roles below their own highest role:

- **Creating or changing** a role, they may set its priority only below their own highest, and give
  it only permissions they have themselves. A role keeps the permissions it already had.
- **Granting or taking away** a role, the role must be below their highest, and the account must be
  their own or rank below them. They may grant a role only if they have all its permissions.
- **A user without roles** manages none, even with the `roles` permission.

Anything else is a `403`, saying why.

## Methods

Every method needs a user's token. Reading needs the `read:accounts` scope, and changing needs
`write:accounts` and the `roles` permission.

### `GET /api/v1/roles`

Every role, highest priority first.

### `GET /api/v1/roles/:id`

A role. `404` if there is none.

### `POST /api/v1/roles`

Creates a role, and answers `201` with it. Every field but `name` is optional:

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

A name already taken is a `422`.

### `PATCH /api/v1/roles/:id`

Changes the fields given, and answers with the role. `icon: null` removes the icon.

### `DELETE /api/v1/roles/:id`

Deletes a role, taking it from everyone who has it. Answers with `{}`.

### `GET /api/v1/accounts/:id/roles`

A local account's roles, highest priority first, including those not shown on its profile. `404` for
a remote account, which has no roles here.

### `POST /api/v1/accounts/:id/roles/:role_id`

Gives a local account a role. Answers with `{}`, also when it already had the role.

### `DELETE /api/v1/accounts/:id/roles/:role_id`

Takes a role from a local account, if it was granted by hand. Roles a login provider grants come and
go with its claims, as [Roles from your provider](../admin/configuring.md#roles-from-your-provider)
explains. Answers with `{}`.

## Roles on accounts

Mastodon's own entities show roles too:

- **`roles` on an Account** lists its visible roles, as `{ id, name, color }`.
- **`role` on the user's own Account**, from `verify_credentials`, is their highest role, with
  `permissions` as Mastodon's bitmask of what they may do. Mastodon apps read it to show admin
  tools, as [Moderating](../admin/moderating.md#moderators) explains.
