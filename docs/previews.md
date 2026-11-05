# Preview cards

A status that links to a web page shows a card for it: the page's title, description and image. The
code is in [`app/previews/`](../app/previews/).

```
status posted, edited or received
  │  subscriber (queueCards): is the status's first link not the one its card is for?
  ▼
card job (previews/cards.ts)
  │  a card for that address under two weeks old? use it
  │  otherwise fetch the page, read it, store its image, save the card
  ▼
note_preview_cards: the status's card, with the link as it wrote it
```

Only the first link counts. Mentions, hashtags, profile cards and links to this instance are
skipped, and a boost has no card, though the status it boosts does. Any visibility gets a card, as
on Mastodon. A remote status waits up to a minute before its job runs, so a status that many servers
receive doesn't make each of them fetch the page at once.

## Fetching

Pages and images are fetched through `ctx.webTransport`, so the checks for federation apply: names
that resolve to internal addresses are refused, and so are ports other than 80, 443 and the ones in
`[federation] extra_web_ports`. The transport doesn't follow redirects, so `fetchLimited` in
[`fetching.ts`](../app/previews/fetching.ts) follows up to five itself, sending each hop through the
transport. It gives up after 30 seconds. A page must be a `200` of type `text/html`, and is read up
to 1 MiB. An image can be up to 8 MiB, and has to be a JPEG, PNG, GIF or WebP.

The image is processed as an upload is, scaled down to fit 640×360, and stored as media that belongs
to no account. The card uses it, so removing unused media keeps it. This is the one case where Verso
downloads media from elsewhere.

A job isn't retried. A status whose page couldn't be fetched has no card, but another status that
links the same page tries again. A page already fetched is fetched again only when its card is more
than two weeks old.
