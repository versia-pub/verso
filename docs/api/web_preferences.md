# Web app settings

Verso keeps each user's settings for its [web app](../web.md), so they follow the user from browser
to browser. They're one JSON object, and only the web app reads them.

## `GET /api/v1/web_preferences`

Returns the user's settings, or `{}` if none were saved. Needs `read:accounts`.

The `ETag` header names this version of the settings, like `"3"`. Before the first save it's `"0"`.

## `PUT /api/v1/web_preferences`

Replaces the user's settings with the JSON object in the body, and returns it with the new `ETag`.
Needs `write:accounts`. The body may be up to 256 KiB.

Without `If-Match`, the settings are always replaced. With it, they're replaced only if it names the
current version or is `*`. Otherwise the request gets a `412` and nothing changes.

To save without losing another tab's changes:

1. Send the `ETag` from the last read or save as `If-Match`.
2. On a `412`, read the settings again, merge in the change, and save again.
