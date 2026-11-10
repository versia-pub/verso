# Media

Media is anything attached to a status, or used as an avatar, header or custom emoji. Local media is
an uploaded file, kept in the file store. Remote media is just a URL and the metadata its instance
sent, which Verso doesn't download or proxy. The only image it downloads is the one on a page that a
status links to, for that page's [preview card](previews.md).

The code is in [`app/media/`](../app/media/), with the file stores and image processing behind ports
in [`app/kernel/`](../app/kernel/).

## Uploading

```
POST /api/v2/media
  │  stream to a temporary file, hashing it on the way (kernel/spool.ts)
  │  sniff the first bytes: an image Verso accepts?
  │
  ├── no:  store it as uploaded, ready at once ──────────────────► 200
  │
  └── yes: store the original, queue a media job ────────────────► 202, "processing"
           │
           ▼  media job (media/processing.ts)
           vips: turn it upright, strip metadata, scale it down to [media] max_pixels,
                 make a preview, a thumbhash and a blurhash
           │
           ▼
           store the result and preview, remove the original
```

Files are stored under their SHA-256, so identical uploads share one file, and uploading an already
processed image again reuses the result.

An image's type comes from its bytes, not from what the client says, in
[`app/kernel/images.ts`](../app/kernel/images.ts). Verso accepts JPEG (including Ultra HDR), PNG,
WebP, GIF, AVIF and HEIC. Other files are stored as they are. Video and audio keep the type the
client gave, if it's one Mastodon plays, and anything else is served as a download, so an uploaded
page or script never runs.

The original image is never served, because it may contain metadata such as where a photo was taken.
It's only kept until processing finishes, and an image that can't be processed is deleted. Avatars
and headers are processed the same way, scaled to their own sizes. Upload limits are in `[media]`:
16 MiB and 3840×2160 by default.

## Attaching

`attach` in [`app/media/attachments.ts`](../app/media/attachments.ts) attaches uploads to a status,
in the transaction that creates it. Each upload must belong to the author, be processed, and not be
attached to another status. Edits keep the old version's media, so a status's history still shows
it.

## Processing with vips

Images are processed by running the [vips](https://www.libvips.org) command-line tools, built by
[`nix/vips.nix`](../nix/vips.nix), in [`app/kernel/vips_images.ts`](../app/kernel/vips_images.ts).
Versia Server used sharp, whose native binaries needed workarounds under Nix. The CLI avoids native
npm packages entirely, and it's fast enough: turning a 48 MP photo upright and stripping its
metadata takes about 0.4 s on a desktop, and up to 1.4 s on CI runners.

vips runs with `VIPS_BLOCK_UNTRUSTED=1`, so it won't read formats such as SVG even if it was built
with them. Verso checks this at startup, and won't start with a vips older than 8.13, which can't
block them.

Each job runs vips a few times, for at most a minute each, so the media queue runs two jobs at a
time per worker, with a 15-minute lease. Stripping metadata re-encodes JPEGs, which loses a little
quality.

Verso's vips only has the libraries for the formats it accepts, plus colour profiles and EXIF
orientation. nixpkgs's vips also pulls in ImageMagick, Poppler and more. Even so, it adds about 90
MiB to the container image, over a third of that for HEIC and AVIF, which x265 and libaom encode.
The dev shell and the tests use the same vips.

In shell scripts, quote arguments such as `"in.jpg[autorotate]"`, or Nix's build shell drops them.

## File stores

`ctx.files` is a `FileStore`, from [`app/kernel/files.ts`](../app/kernel/files.ts): `put`, `get`,
`has` and `delete` by key. `[media] storage` picks one:

| Store    | Config                               | Code                         |
| -------- | ------------------------------------ | ---------------------------- |
| a folder | `storage = { filesystem = "/path" }` | `kernel/filesystem_files.ts` |
| S3       | `[media.storage.s3]`                 | `kernel/s3_files.ts`         |

The S3 store works with any server that speaks S3, such as AWS, Garage, MinIO or R2. It signs
requests with AWS Signature Version 4 through `aws4fetch`, using path-style bucket URLs. With
`public_url`, such as a CDN in front of the bucket, `/media/<key>` redirects there. Otherwise Verso
serves the files itself.

Each store's `check` runs at startup, so Verso fails then if it can't write to the store, rather
than at the first upload. Files never change, since their key is their hash, so `/media/<key>` is
cached for a year.

## Remote media

When Verso receives remote media, a job in the `remote-media` queue fetches its file, in
[`app/media/remote_cache.ts`](../app/media/remote_cache.ts), unless `[media] cache_remote_media` is
off. Images are processed as uploads are. Video and audio are stored as fetched, up to 99 MiB, as on
Mastodon. Other files aren't fetched. A file that doesn't match the hash its instance gave isn't
stored.

The job is grouped by the host the file is on, so one host is fetched from once at a time. It is
tried three times. Media that can't be fetched by then is marked processed with no file, and isn't
tried again until its URL or hash changes.

`url`, `media_type` and `remote_sha256` keep what the remote instance said. `sha256`, `cached_type`
and the preview columns describe the stored file. Once stored, the file is served as `cached_type`
and rendered at Verso's URL; until then, or if fetching failed, at the remote instance's. Custom
emojis are still sent to other instances at their own instance's URL.

## Cleaning up

A job in the `media-cleanup` queue runs every hour, in
[`app/media/cleanup.ts`](../app/media/cleanup.ts). After `[media] unattached_hours`, 24 by default,
it deletes uploads that were never attached and remote media nothing uses. A file is deleted once no
media uses it. Files that remote media stops using, when it is deleted or its file changes, are
deleted by a job in the `media-files` queue, after the transaction that stopped using them.

Deleting a file could race with something starting to use it, so both sides lock the file's key:
`deleteFileIfUnused` while it checks and deletes, and `keepUsed` in the transaction that starts
using the file.

## Tests

Tests use the real vips, which the dev shell provides, and a folder in a temporary directory.
[`app/testing/fake_s3.ts`](../app/testing/fake_s3.ts) is an S3 server in the test process, for the
S3 store's tests. The `federation-vms` check runs Verso with its media in Garage, in NixOS VMs.
