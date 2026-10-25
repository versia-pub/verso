import type { App } from "../http/app.ts";
import { createTestApp } from "./app.ts";
import { routes } from "../http/routes.ts";
import { defaultSettings } from "../instances/testing.ts";
import { queues as allQueues } from "../jobs/queues.ts";
import { drain, type Queue } from "../jobs/worker.ts";
import { type FakeClock, fakeClock } from "../kernel/clock.ts";
import { type FakeTransport, fakeTransport } from "../kernel/fake_transport.ts";
import type { Settings } from "../kernel/settings.ts";
import { createTestContext, type TestContext } from "../testing/context.ts";

export type Instance = TestContext & { readonly app: App };

export type Network = AsyncDisposable & {
    /** Instances by domain. */
    readonly instances: Readonly<Record<string, Instance>>;
    /** The clock every instance shares, so their timestamps agree. */
    readonly clock: FakeClock;
    /** The network between them. Take a host down with `transport.down`. */
    readonly transport: FakeTransport;
    /** Runs every instance's due jobs until a full round runs none, and returns how many ran. */
    drain(): Promise<number>;
};

export type NetworkOptions = {
    readonly clock?: FakeClock;
    /** The queues each instance runs. Defaults to the server's own. */
    readonly queues?: Record<string, Queue>;
    /** Each instance's settings. Defaults to those of a config that leaves them out. */
    readonly settings?: Partial<Settings>;
};

/**
 * Starts complete instances in one process, each with its own database, reachable from each
 * other at their domains through a shared fake network.
 */
export const createNetwork = async (
    domains: readonly string[],
    options: NetworkOptions = {},
): Promise<Network> => {
    if (new Set(domains).size !== domains.length) throw new Error("Domains must be different");

    const clock = options.clock ?? fakeClock();
    const transport = fakeTransport();
    const queues = options.queues ?? allQueues;

    await using stack = new AsyncDisposableStack();
    const instances: Record<string, Instance> = {};
    for (const domain of domains) {
        const test = stack.use(
            await createTestContext({ domain, clock, transport, settings: options.settings }),
        );
        const app = createTestApp(test.ctx, routes(defaultSettings()), { checkResponses: true });
        transport.servers.set(domain, app.fetch);
        instances[domain] = { ...test, app };
    }

    const owned = stack.move();

    return {
        instances,
        clock,
        transport,
        drain: async () => {
            let ran = 0;

            for (;;) {
                let round = 0;
                for (const instance of Object.values(instances)) {
                    round += await drain(instance.ctx, queues, instance.ctx.urls.origin);
                }

                if (round === 0) return ran;
                ran += round;
            }
        },
        [Symbol.asyncDispose]: () => owned.disposeAsync(),
    };
};
