# 6. Secrets in the config file

Secrets such as an issuer's client secret or a database password shouldn't sit in `config.toml`,
which on NixOS lands in the world-readable Nix store, and elsewhere often ends up in a repository.

Any string value in the config can include references, filled in when the config is read:

- `${env:NAME}`, an environment variable, for containers and `.env` files.
- `${file:/path}`, a file's contents without its trailing newline, for Docker and systemd
  credentials and other secret managers.
- `$${` for a literal `${`.

They can be mixed with text, as in `postgres = "postgresql://verso:${env:PGPASS}@db/verso"`. A
missing variable or file, or anything else in `${…}`, stops Verso from starting, and the error names
where in the config it is, never the value. References only fill in strings, so numbers such as
`http.port` can't come from them.
