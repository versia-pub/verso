# Reactions

Users can react to statuses with emoji, as on Versia Server and Pleroma. A user can react to a
status with several different emoji, once each. Reactions federate, so statuses also show those
Verso has received from other instances.

## Naming an emoji

Reactions name their emoji in one of three ways:

| Name               | Emoji                                                       |
| ------------------ | ----------------------------------------------------------- |
| `👍`               | a Unicode emoji, one only                                   |
| `:blobcat:`        | one of the instance's global custom emoji, by its shortcode |
| `:blob@b.example:` | another instance's custom emoji, with its domain            |

Users react with Unicode emoji and the instance's global custom emoji, not their own. Other
instances' emoji appear in their users' reactions, but can't be reacted with here. In URLs, names
are percent-encoded, as `%F0%9F%91%8D` for `👍`.

## On statuses

Each Status has `reactions`, the reactions to it grouped by emoji, in the order each emoji was first
used. Reactions from accounts the viewer blocks aren't counted.

```json
{
    "reactions": [
        { "name": "👍", "count": 3, "remote": false, "me": true },
        { "name": ":blob@b.example:", "count": 1, "remote": true, "me": false }
    ]
}
```

| Field    | Type    | Description                                                   |
| -------- | ------- | ------------------------------------------------------------- |
| `name`   | string  | The emoji, named as above                                     |
| `count`  | integer | How many accounts reacted with it                             |
| `remote` | boolean | Whether the emoji is another instance's                       |
| `me`     | boolean | Whether the viewer reacted with it. Left out without a viewer |

A custom emoji's picture is in the status's `emojis`, by its shortcode.

## Methods

Reading needs the `read:statuses` scope and the `read:reaction` permission, and works without a
token too. Reacting needs a user's token, the `write:statuses` scope and the `owner:reaction`
permission. A status the viewer may not see is a `404`. Reacting to a boost reacts to the status it
boosts.

### `PUT /api/v1/statuses/:id/reactions/:name`

Reacts to a status with an emoji, and answers `201` with the status. Reacting again with the same
emoji changes nothing. An emoji that isn't one of those users can react with is a `422`.

```sh
curl -X PUT https://social.example/api/v1/statuses/$ID/reactions/%F0%9F%91%8D \
  -H "Authorization: Bearer $TOKEN"
```

### `DELETE /api/v1/statuses/:id/reactions/:name`

Undoes the viewer's reaction with an emoji, and answers with the status. A status the viewer reacted
to can be undone even if they may no longer see it.

### `GET /api/v1/statuses/:id/reactions`

The status's reactions, the same as its `reactions` field.

### `GET /api/v1/statuses/:id/reactions/:name`

The accounts that reacted with an emoji, newest first, a page at a time, as Mastodon pages lists.
`limit` is 40 by default, at most 80. Accounts the viewer blocks are left out. An emoji nobody
reacted with is a `404`.

## Notifications

A user is notified when someone reacts to their status, with a `reaction` notification. It has the
emoji, as Pleroma's do:

| Field       | Description                                               |
| ----------- | --------------------------------------------------------- |
| `emoji`     | The emoji, named as above                                 |
| `emoji_url` | The custom emoji's picture, or `null` for a Unicode emoji |

On `/api/v2/notifications`, `reaction` notifications are grouped by status when `grouped_types`
includes `reaction`. Each group then has `emojis`, the different emoji of its newest reactions, each
with `emoji` and `emoji_url`. Apps that don't know `reaction` ignore these notifications, as they do
any type they don't know.
