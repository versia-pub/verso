# Installing Verso

This sets up a Verso instance: on NixOS, in a container, or from the package on another Linux
system. To work on Verso itself, see [CONTRIBUTING.md](../../CONTRIBUTING.md) instead.

## What you need

- **A Linux server**, x86_64 or aarch64, with [Nix](https://nixos.org) and flakes enabled to build
  Verso.
- **A domain, served over HTTPS.** Accounts and federation are tied to it, so it can't change later.
  Verso must answer at `https://<domain>/` itself, as other instances look for it there.
- **A database**: PostgreSQL, tested with version 18, with a UTF-8 database. SQLite also works, for
  a small instance in one process.
- **An OpenID Connect provider**, such as Keycloak, Authentik or Kanidm. Verso has no passwords:
  users log in there. Register Verso with it as a confidential client, with
  `https://<domain>/oauth/callback` as the redirect URI.
- **Optionally, an S3 bucket** for media, on AWS, Garage, MinIO or any other server that speaks S3.
  Otherwise, media is kept in a directory.

Verso brings libraries it needs, such as vips for processing images.

## On NixOS

Add Verso to your flake, and import its module:

```nix
{
  inputs.verso.url = "github:versia-pub/verso";

  outputs = { nixpkgs, verso, ... }: {
    nixosConfigurations.social = nixpkgs.lib.nixosSystem {
      modules = [ verso.nixosModules.default ./configuration.nix ];
    };
  };
}
```

Then, in `configuration.nix`:

```nix
services.verso = {
  enable = true;
  settings = {
    domain = "social.example";
    instance.name = "Example Social";
    auth.issuers = [{
      name = "Example ID";
      url = "https://id.social.example";
      client_id = "verso";
      client_secret = "\${file:/run/credentials/verso.service/oidc}";
      # Anyone the provider lets in gets an account. It is "closed" by default.
      registration = "open";
    }];
  };
  credentials.oidc = "/run/secrets/verso-oidc";
};
```

| Option                   | What it does                                                |
| ------------------------ | ----------------------------------------------------------- |
| `settings`               | `config.toml`, written as Nix                               |
| `credentials`            | secret files, by name, kept out of the Nix store            |
| `database.createLocally` | runs PostgreSQL on the machine for Verso, `true` by default |
| `package`                | the Verso package to run                                    |

- **Settings** are the same as in `config.toml`. See [Configuring](configuring.md).
- **Secrets** go in `credentials` (never in `settings`, which ends up in the world-readable Nix
  store). The module refuses a client secret, S3 secret key or database password written there.
  Refer to a credential as `${file:/run/credentials/verso.service/<name>}`, written `\${…}` in Nix.
- **Media** is kept in `/var/lib/verso/media`, unless `settings.media.storage` says otherwise.
- **The service** runs `verso migrate`, then `verso all`, as an unprivileged dynamic user.
- **Admin commands** run with `sudo verso-admin …`, which has the service's config and secrets.

## In a container

Verso has a container image, which you build with Nix and load into Docker or Podman:

```sh
$(nix build --print-out-paths github:versia-pub/verso#image) | docker load
```

The image is `verso:<version>`. It runs as user 65534, listens on port 8080, and reads
`/config.toml`. Pass secrets as environment variables, and refer to them with `${env:NAME}`:

```sh
docker run --rm -v ./config.toml:/config.toml:ro -e DB_PASSWORD verso:0.0.0 migrate
docker run -d -p 8080:8080 -v ./config.toml:/config.toml:ro -e DB_PASSWORD verso:0.0.0
```

The first command sets up the database, and the second runs Verso. Use S3 for media in a container,
or mount a volume writable by user 65534 and point `[media] storage` at it. Add the proxy's address
to `[http] trusted_proxies`, so Verso sees each client's real address.

## From the package

On another Linux system with Nix:

```sh
nix build --out-link /opt/verso github:versia-pub/verso
/opt/verso/bin/verso --config /etc/verso/config.toml migrate
/opt/verso/bin/verso --config /etc/verso/config.toml all
```

The link in `/opt/verso` keeps the build from being garbage-collected. Run `verso all` as a service,
under its own user, such as with systemd. It stops cleanly on `SIGTERM`, finishing the requests and
jobs in progress first.

## Behind a reverse proxy

Verso serves plain HTTP, on port 8080 by default. Put a reverse proxy in front of it for HTTPS. It
must pass WebSocket upgrades, for streaming, and allow uploads as large as
`[media] max_upload_bytes`, 16 MiB by default.

With [Caddy](https://caddyserver.com), which gets certificates and does the rest by itself:

```
social.example {
    reverse_proxy localhost:8080
}
```

With nginx:

```nginx
server {
    listen 443 ssl;
    server_name social.example;
    # ssl_certificate …

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

`$connection_upgrade` comes from the usual `map $http_upgrade $connection_upgrade` block. Verso
trusts `X-Forwarded-For` only from `[http] trusted_proxies`, localhost by default.

`GET /health/live` answers `ok` while Verso is running, for load balancers and container health
checks.

## First steps

1. **Log in.** Verso has no web interface of its own: add your domain to a Mastodon app, and log in
   through your provider. Your account is made at your first login, if the issuer's `registration`
   lets you in.
2. **Make an admin role**, and give it to yourself:

   ```sh
   verso admin roles create Admin --permissions roles,emojis,blocks --priority 100
   verso admin users grant-role yourname Admin
   ```

   On NixOS, run `sudo verso-admin` instead of `verso admin`. To grant roles from your provider's
   groups instead, see [Roles from your provider](configuring.md#roles-from-your-provider).
3. **Check federation**, by searching for an account on another Versia instance.

[Commands](commands.md) lists every command, and [Running an instance](running.md) covers upgrades,
backups and logs. Each instance serves its API reference at `/docs`.
