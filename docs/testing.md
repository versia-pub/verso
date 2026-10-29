# Testing

Tests are `*.test.ts` files beside the code they test, run with `deno task test`. They use real
databases and real vips, and fakes only for what is outside Verso: the clock, the network, identity
providers and S3.

## Running them

| Command                                                           | Runs                        |
| ----------------------------------------------------------------- | --------------------------- |
| `deno task test`                                                  | every test, on PGlite       |
| `deno task test app/notes/`                                       | one folder's, or one file's |
| `deno task test --filter "markers"`                               | tests whose names match     |
| `VERSO_TEST_DATABASE=sqlite deno task test`                       | every test, on SQLite       |
| `VERSO_TEST_DATABASE=postgresql://… deno task test --allow-net=…` | on a real Postgres server   |

`nix flake check` runs the whole suite three times, as `test-pglite`, `test-sqlite` and
`test-postgres`. A test must pass on all three. See [Database](database.md#tests) for how each gets
a database.

## A test's context

`createTestContext`, in [`app/testing/context.ts`](../app/testing/context.ts), makes a
[context](architecture.md) for one test:

| Part        | In tests                                                         |
| ----------- | ---------------------------------------------------------------- |
| `db`        | a new, migrated database, with the instance's keys made          |
| `clock`     | a fake clock: time stands still until `test.clock.advance(ms)`   |
| `ids`       | made from the clock and a counter, so they are the same each run |
| `transport` | a fake network with no servers on it, unless the test adds some  |
| `files`     | a store in memory                                                |
| `images`    | the real vips                                                    |
| `pubsub`    | in memory                                                        |
| `settings`  | `defaultSettings`, with any the test gives                       |

Use it with `await using`, so the database closes when the test ends. Any part can be replaced
through its options.

## Testing a route

Most tests call routes, as a client would. `createTestApp`, in
[`app/testing/app.ts`](../app/testing/app.ts), makes the HTTP app for some routes, and `app.request`
sends it a request without a server:

```ts
Deno.test("a marker is saved", async () => {
    await using test = await createTestContext();
    const app = createTestApp(test.ctx, markerRoutes, { checkResponses: true });
    await createLocalAccount(test.ctx, "alice");
    const token = await tokenFor(test.ctx, "alice");

    const response = await app.request("/api/v1/markers", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ home: { last_read_id: "a" } }),
    });
    assertEquals(response.status, 200);
});
```

- **`checkResponses: true`** checks every response against the route's declared schemas, so a route
  can't answer with something its OpenAPI doesn't say.
- **Modules' `testing.ts` files** make what tests need, such as `createLocalAccount` in
  `app/accounts/testing.ts` and `tokenFor` in `app/auth/testing.ts`. Add one beside a module when
  its tests and others' need the same setup.
- **Jobs don't run by themselves.** Call `drain(ctx, queues)` to run every due job. See
  [Events, jobs and messages](events-and-jobs.md#tests).

## Several instances

Federation is tested between complete instances in one process. `createNetwork`, in
[`app/testing/network.ts`](../app/testing/network.ts), starts one per domain, each with its own
database and every route, on a shared fake network and clock:

```ts
await using network = await createNetwork(["a.test", "b.test"]);
const alice = await clientOf(network.instances["a.test"], aliceId);
const bob = await clientOf(network.instances["b.test"], bobId);

await followAddress(bob, "alice@a.test");
await network.drain(); // every instance's jobs, until none are left
```

- **[`app/testing/clients.ts`](../app/testing/clients.ts)** calls an instance's client API as a
  user, and counts what each instance was sent.
- **`network.transport.down.add(host)`** takes an instance off the network, to test retries and the
  circuit breaker.
- **[`app/testing/evil.ts`](../app/testing/evil.ts)** adds an instance that misbehaves on purpose.
- The `scenarios.test.ts` files in modules use these to test whole stories, such as a status being
  posted, edited and deleted everywhere it went.

## Other fakes

- **[`app/testing/fake_idp.ts`](../app/testing/fake_idp.ts)** is an OpenID Connect provider, for
  testing the whole login.
- **[`app/testing/fake_s3.ts`](../app/testing/fake_s3.ts)** is an S3 server, for the S3 store.
- **`fakeTransport`**, in [`app/kernel/fake_transport.ts`](../app/kernel/fake_transport.ts), routes
  requests by host to any `(request) => Response`, so a test can answer as a remote instance would.

## The OpenAPI snapshot

[`app/http/routes.test.ts`](../app/http/routes.test.ts) compares the OpenAPI document with
`app/http/openapi.json`, so a change to the API shows up in review. After a change you meant, run
`deno task update-openapi` and commit the new snapshot. See [HTTP](http.md#openapi).

## Beyond `deno task test`

- **`nixos-module`** starts the NixOS module in a VM, and checks it serves.
- **`federation-vms`** runs instances in NixOS VMs that federate over a real network, with Postgres
  and Garage.
- **`image`** runs the container image's entrypoint, and checks it prints Verso's version.

All three run in `nix flake check`.

## Writing tests

- **Name a test by what it shows**, as a sentence: "markers are saved, a version on each time, and
  read for the timelines asked for".
- **Test through the route or the service**, not a module's private helpers, so tests survive a
  refactor.
- **Each test sets up its own data**, so tests run in any order and in parallel.
- **Advance the clock** rather than waiting, for anything about time.
- **Write a test that fails without your change**, as CONTRIBUTING.md asks.
