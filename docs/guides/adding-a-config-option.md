# Adding a config option

This guide adds `[push] timeout_seconds`, how long a push service has to answer, which used to be a
constant in [`app/push/pushes.ts`](../../app/push/pushes.ts). Read
[Configuration](../configuration.md) first.

```
config_sections.ts   PushSettings: timeout_seconds, with its default
config.ts            Config: push: PushSettings
settings.ts          Settings: pushTimeoutMs, from settingsOf and in defaultSettings
pushes.ts            reads ctx.settings.pushTimeoutMs
config.example.toml  documents it
```

Before adding an option, ask whether anyone would actually change it. A constant with a comment is
simpler, and every option is one more thing to document, test and maintain.

## 1. Add it to the schema

Small sections are defined in [`app/kernel/config.ts`](../../app/kernel/config.ts). Larger ones, and
ones the code imports by name, are in
[`app/kernel/config_sections.ts`](../../app/kernel/config_sections.ts):

```ts
/** How Web Push is sent. */
export const PushSettings = z.strictObject({
    /**
     * How long a push service has to respond, so a slow one can't hold a worker. One that takes
     * longer isn't tried again, as it would hold a worker as long each time.
     */
    timeout_seconds: z.int().min(1).default(10),
}).prefault({});
```

Then add the section to `Config`: `push: PushSettings`.

Give it a default that suits most instances, so configs can leave it out. Only settings that can't
have a sensible default, like `domain`, are required. Name it in snake case with its unit, like
`timeout_seconds`, `unattached_hours` or `max_upload_bytes`, and use `min` and `max` so a value that
can't work stops Verso at startup.

A new section uses `z.strictObject`, and `.prefault({})` so it can be left out. Development-only
settings are refused in production by `Config`'s `superRefine`.

## 2. Get it to the code

The value reaches the code in one of three ways:

| It is used by                    | Pass it through                                        |
| -------------------------------- | ------------------------------------------------------ |
| a service or job handler         | `Settings`, in `app/kernel/settings.ts`                |
| a route, to check or describe    | the module's route function, from `app/http/routes.ts` |
| an adapter, such as a file store | `contextFor` in `app/run.ts`                           |

The push timeout is read by a job handler, so it goes in `Settings`, in the unit the code uses:

```ts
// settings.ts
export type Settings = {
    // …
    /** How long a push service has to respond. */
    readonly pushTimeoutMs: number;
};

export const settingsOf = (config: Pick<Config, /* … */ "push">): Settings => ({
    // …
    pushTimeoutMs: config.push.timeout_seconds * 1000,
});

export const defaultSettings: Settings = {
    // …
    pushTimeoutMs: 10_000,
};
```

```ts
// pushes.ts
signal: timeoutSignal(ctx.settings.pushTimeoutMs, ctx.signal),
```

A setting that routes use, such as `[search]`, goes in `AboutSettings` in `app/instances/render.ts`
instead, and in `defaultSettings()` in `app/instances/testing.ts` for tests.

## 3. Document it

Add it to [`docs/config.example.toml`](../config.example.toml), commented out with its default, and
a comment saying what it does and why someone would change it:

```toml
[push]
# How many seconds a push service has to respond. One that takes longer isn't tried again.
# timeout_seconds = 10
```

If it changes how a feature behaves, say so in that feature's doc too, as
[Notifications and push](../notifications.md#web-push) does for this one.

## 4. Test it

In `app/kernel/config.test.ts`, add the default to "a minimal config gets the defaults", and a value
to the test that sets every setting, which also checks `settingsOf`. A test parses the example
config too, so a typo there fails.

In the feature's tests, pass the setting to `createTestContext({ settings: { … } })` and show it has
an effect, as `app/push/pushes.test.ts` does with a push service that answers too slowly.

## Checklist

- [ ] Someone would set it, and it has a default that suits most instances.
- [ ] Its name says its unit, and it is limited to values that work.
- [ ] It reaches the code through `Settings`, a route function or `contextFor`, never by reading the
      config again.
- [ ] `defaultSettings` has the same default.
- [ ] `config.example.toml` documents it.
- [ ] The config tests and the feature's tests cover it.
