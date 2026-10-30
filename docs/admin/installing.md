# Installing Verso

This page sets up a Verso instance on NixOS, in a container, or from the package on another Linux
system. To work on Verso itself, see [CONTRIBUTING.md](../../CONTRIBUTING.md) instead.

## What you need

- A Linux server, x86_64 or aarch64, with [Nix](https://nixos.org) and flakes enabled.
- A domain served over HTTPS, which [can't change later](configuring.md#main-options). Verso has to
  answer at `https://<domain>/` itself, because other instances look for it there.
- PostgreSQL, tested with version 18, and a UTF-8 database. SQLite works too, for a small instance
  in one process.
- An OpenID Connect provider, such as Keycloak, Authentik or Kanidm. Verso has no passwords of its
  own; users log in with the provider. Register Verso there as a confidential client, with
  `https://<domain>/oauth/callback` as the redirect URI.
- Optionally, an S3 bucket for media, on AWS, Garage, MinIO or anything else that speaks S3.
  Otherwise media is stored in a directory.

Verso comes with the libraries it needs, such as vips for images.

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

`settings` takes the same options as `config.toml`, described in [Configuring](configuring.md).

Secrets go in `credentials`, never in `settings`, which ends up in the world-readable Nix store. The
module refuses a client secret, S3 secret key or database password written in `settings`. Refer to a
credential as `${file:/run/credentials/verso.service/<name>}`, escaped as `\${…}` in Nix.

Media is stored in `/var/lib/verso/media`, unless `settings.media.storage` says otherwise. The
service runs `verso migrate` and then `verso all`, as an unprivileged dynamic user. Run admin
commands with `sudo verso-admin …`, as described in [Commands](commands.md).

## In a container

Verso has a container image, which you build with Nix and load into Docker or Podman:

```sh
$(nix build --print-out-paths github:versia-pub/verso#image) | docker load
```

The image is `verso:<version>`. It runs as user 65534, listens on port 8080, and reads
`/config.toml`. Pass [secrets](configuring.md#secrets) as environment variables:

```sh
docker run --rm -v ./config.toml:/config.toml:ro -e DB_PASSWORD verso:0.0.0 migrate
docker run -d -p 8080:8080 -v ./config.toml:/config.toml:ro -e DB_PASSWORD verso:0.0.0
```

The first command sets up the database, and the second runs Verso. In a container, use S3 for media,
or mount a volume that user 65534 can write to and point `[media] storage` at it.

## From the package

On another Linux system with Nix:

```sh
nix build --out-link /opt/verso github:versia-pub/verso
/opt/verso/bin/verso --config /etc/verso/config.toml migrate
/opt/verso/bin/verso --config /etc/verso/config.toml all
```

The `/opt/verso` link stops the build from being garbage-collected. Run `verso all` as a service
under its own user, for example with systemd.

## Behind a reverse proxy

Verso serves plain HTTP, on port 8080 by default, so put a reverse proxy in front of it for HTTPS.
The proxy has to pass WebSocket upgrades for streaming, and allow uploads as large as
`[media] max_upload_bytes`, 16 MiB by default.

[Caddy](https://caddyserver.com) gets certificates and handles the rest on its own:

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

`$connection_upgrade` comes from the usual `map $http_upgrade $connection_upgrade` block. If the
proxy isn't on the same machine, add its address to
[`[http] trusted_proxies`](configuring.md#main-options).

## First steps

1. Log in. Verso has no web interface of its own, so add your domain to a Mastodon app and log in
   through your provider. Your account is created the first time you log in.
2. Create an admin role and give it to yourself:

   ```sh
   verso admin roles create Admin --permissions roles,emojis,blocks --priority 100
   verso admin users grant-role yourname Admin
   ```

   On NixOS, run `sudo verso-admin` instead of `verso admin`. To grant roles from your provider's
   groups instead, see [Roles from your provider](configuring.md#roles-from-your-provider).
3. Check that federation works by searching for an account on another Versia instance.

[Commands](commands.md) lists every command, and [Running an instance](running.md) covers upgrades,
backups and logs. Each instance serves its API reference at `/docs`.
