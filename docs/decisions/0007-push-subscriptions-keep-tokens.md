# 7. Push subscriptions keep their access tokens

Verso stores only the hash of an access token, so someone who reads the database can't act as its
users. Push subscriptions are the exception: each keeps its token as it is, in
`push_subscriptions.access_token`.

Mastodon's pushes carry the token, so that clients such as its web app can fetch the notification
with it, and Verso's do the same. To put it in a push, Verso has to have it.

So someone who can read that table can act as each subscribed user, as their app, until the token is
revoked. Revoking it, or deleting the subscription, deletes the stored copy. Mastodon has the same
exposure.

Encrypting the column with a key from the config would protect against a leak of the database alone.
It isn't done for now, as it adds a key to manage and rotate. If it is done later, only this table's
queries change.
