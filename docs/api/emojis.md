# Custom emoji

Users add custom emoji through the API, with [Versia Server's](https://github.com/versia-pub/server)
emoji methods. Each emoji is either a user's own, which only they can use, or global, for everyone
on the instance. Making global emoji needs the `emojis` permission, as
[Moderating](../admin/moderating.md#custom-emoji) explains.

## Listing them

`GET /api/v1/custom_emojis` is Mastodon's: the emojis the viewer can use, as Mastodon's
[CustomEmoji](https://docs.joinmastodon.org/entities/CustomEmoji/). These are the global emojis and,
with a user's token, their own, which replace global ones with the same shortcode. Emojis whose
picture are still being processed are left out.

## The Emoji entity

Verso's emoji methods answer with Mastodon's CustomEmoji, plus these fields:

```json
{
    "id": "01a18a2f-7c3e-7d40-9a51-3f0e2b8c4d17",
    "shortcode": "blobcat",
    "url": "https://social.example/media/…",
    "static_url": "https://social.example/media/…",
    "visible_in_picker": true,
    "category": "Blobs",
    "global": true,
    "description": "A yellow blob with a cat face",
}
```

| Field         | Type           | Description                                             |
| ------------- | -------------- | ------------------------------------------------------- |
| `id`          | string         | The emoji's id                                          |
| `global`      | boolean        | Whether everyone can use it, rather than only its owner |
| `description` | string or null | Its alt text                                            |
| `url`         | string or null | `null` until the picture is processed                   |
| `static_url`  | string or null | The picture, not animated. `null` until it is processed |

## Methods

Every method needs a user's token. Reading needs the `read` scope and the `read:emoji` permission;
the others need `write:media` and `owner:emoji`. Users see the global emoji and their own, and
change their own. Those with the `emojis` permission see and change any. Changing a global emoji
without it is a `403`.

### `POST /api/v1/emojis`

Adds an emoji, sent as `multipart/form-data`:

| Field       | Description                                                             |
| ----------- | ----------------------------------------------------------------------- |
| `shortcode` | At least 2 letters, digits or underscores, at most 100                  |
| `element`   | The picture, at most `[media] max_emoji_bytes`, 256 KiB by default      |
| `category`  | Optional. The picker's group for it, at most 64 characters              |
| `alt`       | Optional. Its alt text                                                  |
| `global`    | Optional. `true` to make it global, which needs the `emojis` permission |

```sh
curl -X POST https://social.example/api/v1/emojis \
  -H "Authorization: Bearer $TOKEN" \
  -F shortcode=blobcat -F element=@blobcat.png -F category=Blobs
```

The picture is processed after the response, which is a `202` with the emoji and no URLs. Until it
is processed, statuses don't use the emoji; `GET /api/v1/emojis/:id` shows when it is ready.

A shortcode the user can already use, their own or a global one, is a `422`. A file that isn't an
image is a `422` too.

### `GET /api/v1/emojis/:id`

An emoji, or `404` if it isn't one the viewer may see.

### `PATCH /api/v1/emojis/:id`

Changes the fields given, the same as when adding one, and answers with the emoji. A new picture is
processed again, and the emoji has no URLs until it is.

- **Renaming** an emoji leaves the statuses that use it as they are.
- **Making a global emoji not global** makes it the editor's own.

### `DELETE /api/v1/emojis/:id`

Deletes an emoji, and answers with `{}`. Statuses and profiles that used it no longer show it, and
local users' reactions with it are undone.

## Remote emoji

Emoji from other instances arrive with the statuses and profiles that use them. They aren't in
`custom_emojis`, and these methods don't change them.
