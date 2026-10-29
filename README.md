<div align="center">

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
    <img src="docs/assets/banner.svg" alt="Verso: the Versia reference implementation" width="640">
  </picture>
</p>

[![CI](https://github.com/versia-pub/verso/actions/workflows/ci.yml/badge.svg)](https://github.com/versia-pub/verso/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-22162B)](LICENSE)
[![Versia 0.6](https://img.shields.io/badge/Versia-0.6-E6A9FE)](https://versia.pub)
[![Built with Deno](https://img.shields.io/badge/built_with-Deno-22162B?logo=deno)](https://deno.com)
[![Nix flake](https://img.shields.io/badge/Nix-flake-5277C3?logo=nixos&logoColor=white)](flake.nix)

**[Docs](docs/README.md)** · **[Installing](docs/admin/installing.md)** ·
**[Contributing](CONTRIBUTING.md)** · **[Versia](https://versia.pub)**

</div>

Verso is the reference implementation of [Versia](https://versia.pub), a federation protocol for
social media. It also speaks the Mastodon client API, so it works with the apps people already use.

> [!NOTE]
> Verso is in early development and isn't ready for production yet.

## Features

- **Versia 0.6 federation**: statuses, follows, shares, reactions and custom emoji
- **Mastodon client API**: works with existing apps, including streaming, notifications and Web
  Push; see [what's supported](docs/api/compatibility.md)
- **Search** across statuses, accounts and hashtags
- **Sign-in** through OpenID Connect
- **Media storage** on local disk or any S3-compatible service
- **PostgreSQL or SQLite** as the database
- **Scales out** by running web nodes and job workers separately

## Running Verso

[Installing Verso](docs/admin/installing.md) covers NixOS, the container image and the package, and
[Configuring](docs/admin/configuring.md) the settings most instances change. To run it locally for
development, see [Running Verso locally](CONTRIBUTING.md#running-verso-locally).

## Documentation

The [docs](docs/README.md) cover running an instance, the client API and how Verso works, with
guides to common changes such as adding a route or a table. [CONTRIBUTING.md](CONTRIBUTING.md)
covers setup, everyday commands and what we look for in a pull request.

## License

Verso is free software, licensed under the [GNU Affero General Public License v3.0](LICENSE).
