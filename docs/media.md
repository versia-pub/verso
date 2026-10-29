# Media

Media is anything attached to a status, or used as an avatar, a header or a custom emoji. Local
media is a file someone uploaded, kept in the file store. Remote media is a URL and the metadata its
instance sent: Verso doesn't download or proxy it.

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

- **Files are stored under their SHA-256**, so identical uploads share one file. A second upload of
  an image that was already processed reuses the result.
- **The type of an image comes from its bytes**, not from what the client says, in
  [`app/kernel/images.ts`](../app/kernel/images.ts). Verso accepts JPEG (including Ultra HDR), PNG,
  WebP, GIF, AVIF and HEIC.
- **Other files** are stored as they are. Video and audio keep the type the client declared, if it
  is one Mastodon plays. Anything else is served as a download, so an uploaded page or script never
  runs.
- **The original of an image is never served**, as it may hold metadata such as where a photo was
  taken. It is kept only until processing finishes. An image that can't be processed is removed.
- **Limits** are in `[media]`: `max_upload_bytes`, 16 MiB, and `max_pixels`, 3840×2160, by default.
- **Avatars and headers** go through the same processing, scaled to fit their own sizes.

## Attaching

`attach` in [`app/media/attachments.ts`](../app/media/attachments.ts) attaches uploads to a status,
in the transaction that creates it. Each upload must be the author's, processed, and not attached to
another status. Edits keep the old version's media, so a status's history still shows them.

## Processing with vips

Images are processed by running the [vips](https://www.libvips.org) command-line tools from nixpkgs,
in [`app/kernel/vips_images.ts`](../app/kernel/vips_images.ts). The old server used sharp, which
ships native binaries that needed workarounds under Nix. With the CLI, no native npm packages are
involved.

It is fast enough: turning a 48 MP photo upright and stripping its metadata takes about 0.4 s on a
desktop, and up to 1.4 s on CI runners. A thumbnail takes less.

- **Untrusted loaders are blocked**, with `VIPS_BLOCK_UNTRUSTED=1`, so vips won't read formats such
  as SVG through ImageMagick. Verso checks this at startup, and stops if vips is too old to block
  them (it needs 8.13 or later).
- **Each job runs vips a few times**, a minute each at most, so the media queue runs two jobs at a
  time per worker, with a lease of 15 minutes.
- **Stripping metadata re-encodes JPEGs**, which loses a little quality.
- **vips adds about 278 MiB** to the container image.
- **In shell scripts**, quote arguments such as `"in.jpg[autorotate]"`. Nix's build shell drops them
  otherwise.

## File stores

`ctx.files` is a `FileStore`, from [`app/kernel/files.ts`](../app/kernel/files.ts): `put`, `get`,
`has` and `delete` by key. `[media] storage` picks one:

| Store    | Config                               | Code                         |
| -------- | ------------------------------------ | ---------------------------- |
| a folder | `storage = { filesystem = "/path" }` | `kernel/filesystem_files.ts` |
| S3       | `[media.storage.s3]`                 | `kernel/s3_files.ts`         |

The S3 store works with any server that speaks S3, such as AWS, Garage, MinIO or R2. It signs
requests with AWS Signature Version 4, through `aws4fetch`, and names the bucket in the path. With
`public_url`, such as a CDN in front of the bucket, `/media/<key>` redirects there. Without it,
Verso serves the files itself.

Every store's `check` runs at startup, so a store Verso can't write to stops it then, rather than at
the first upload.

Files never change, since their key is their hash, so `/media/<key>` is cached for a year.

## Cleaning up

A job in the `media-cleanup` queue runs every hour, in
[`app/media/cleanup.ts`](../app/media/cleanup.ts). It removes uploads that were never attached, and
remote media that nothing used, after `[media] unattached_hours`, 24 by default. A file is removed
once no media uses it.

Removing a file and starting to use one race each other, so both take a lock on the file's key:
`deleteFileIfUnused` while it checks and removes, and `keepUsed` in the transaction that starts
using it.

## Tests

Tests use the real vips, which the dev shell provides, and a folder in a temporary directory.
[`app/testing/fake_s3.ts`](../app/testing/fake_s3.ts) is an S3 server in the test process, for the
S3 store's tests. The `federation-vms` check runs Verso with its media in Garage, in NixOS VMs.
