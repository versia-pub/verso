# Contributing to Verso

Thanks for helping out. This file covers how to set up, how to run things, and
what we look for in a pull request.

## Setup

You need Nix with flakes enabled, on x86_64 or aarch64 Linux. Nix is the only
supported way to work on Verso. It pins Deno and every other tool, so your
machine, CI and production all run the same versions.

```sh
nix develop    # or run `direnv allow` once, if you use direnv
deno install   # downloads dependencies into vendor/ and node_modules/
```

The dev shell gives you Deno, nixfmt and PostgreSQL. You don't need to install
anything else.

Nix only sees files that git knows about. If you add a file, `git add` it before
running `nix build` or `nix flake check`, or Nix will act as if it isn't there.

## Commands

| Command                         | What it does                                          |
| ------------------------------- | ----------------------------------------------------- |
| `deno task fmt`                 | Format the code                                       |
| `deno task lint`                | Lint the code                                         |
| `deno task check`               | Type-check the code                                   |
| `deno task test`                | Run the tests                                         |
| `deno task unused-dependencies` | List dependencies nothing imports                     |
| `nix fmt`                       | Format the Nix files                                  |
| `nix flake check`               | Run everything CI runs                                |
| `nix build`                     | Build the server package                              |
| `nix run .#update-hashes`       | Update the dependency hash after changing `deno.lock` |

CI runs `nix flake check` and nothing else. It runs the same Deno tasks inside
the Nix sandbox, without network access. If it passes on your machine, it should
pass in CI.

Tests run on PGlite, an in-process PostgreSQL, by default. To run them on
SQLite, set `VERSO_TEST_DATABASE=sqlite`. To run them on a real PostgreSQL
server, set it to the server's URL and add `--allow-net` for its address. Each
test creates its own database there, so use a throwaway server.
`nix flake check` runs all three.

## Dependencies

Every dependency is code we don't control, so add one only when it pays for
itself. In the pull request, say what it replaces, how big it is, how well it's
maintained, and why the standard library or Deno's built-ins aren't enough.

To add one:

```sh
deno add --save-exact jsr:@std/cli   # or npm:some-package
nix run .#update-hashes
```

Commit `deno.json`, `deno.lock` and `nix/deps.nix` together. If you forget the
hash, the `deps-hash` check fails and tells you what to run.

## Writing code

- Formatting is whatever `deno fmt` does. There's nothing to argue about.
- The lint rules are strict on purpose: no `any`, no `@ts-ignore`, no non-null
  `!`, and exported functions declare their return types. If you really need to
  break a rule, add a `deno-lint-ignore` comment with the reason after `--`.
- Write functions as arrow functions, not with the `function` keyword. Methods
  and generators are the exception. Our own lint rules live in `lint/plugin.ts`.
- Don't use `console` for logging. Logs go through LogTape so they stay
  structured. Printing command output, like `--version`, is fine with a
  lint-ignore comment.
- Get a logger with `getLogger(["verso", "<module>"])`. Put values in the log's
  properties, as in `logger.info("Fetched {url}", { url })`, so they stay
  searchable.
- Logs printed to a terminal should be easy to scan. Use colour, bold text and
  alignment to make the important parts stand out.
- Comments explain why the code is the way it is: a spec rule, a constraint, a
  past bug. Don't use them to repeat what the code already says.
- Write the least code that is obviously correct. Don't add an abstraction until
  the third time you need it.

## Commits and pull requests

Keep each change small enough to review in a few minutes. Commit messages use
[Conventional Commits](https://www.conventionalcommits.org/), with a capital
letter after the type:

```
build(nix): Add dev shell
fix(federation): Reject deletes from non-owners
```

Every pull request should answer these questions, in its description or during
review:

1. Could this be fewer lines, or none? Is there an existing function, a standard
   library module or a Deno built-in that already does it?
2. Is there one obvious place for this code, and is it there?
3. Is every error handled, converted or reported, and never swallowed?
4. Are inputs validated at the boundary and trusted after that?
5. Is there a test that fails without this change?
6. Does it add a dependency, a config option, a port or a new pattern? If so, is
   the reason written down?
7. Could a new contributor understand it from the code, comments and docs alone?

## No AI agent files

Don't add `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.claude/` or any other file
meant for AI tools. This project is for humans: even if that wasn't the case, if
a tool needs to know something, a person probably does too, so write it here or
in `docs/`. The `agent-files` check enforces this.
