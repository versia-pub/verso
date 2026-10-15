import type { Transport } from "./transport.ts";

/** Answers the requests sent to one host, like an app's `fetch`. */
export type Server = (request: Request) => Response | Promise<Response>;

/** A network in memory, for tests. */
export type FakeTransport = Transport & {
    /** Servers by host, as in `new URL(url).host`. Requests to any other host fail. */
    readonly servers: Map<string, Server>;
    /** Hosts that are unreachable for now, though they have a server. */
    readonly down: Set<string>;
    /** Every request sent, in order, including ones that failed. */
    readonly sent: Request[];
};

/** Routes each request by host to a server, failing like `fetch` does for unreachable hosts. */
export const fakeTransport = (servers: Record<string, Server> = {}): FakeTransport => {
    const transport: FakeTransport = Object.assign(async (request: Request) => {
        transport.sent.push(request.clone());
        const host = new URL(request.url).host;
        const server = transport.servers.get(host);
        if (!server || transport.down.has(host)) {
            throw new TypeError(`Can't reach ${host}`);
        }
        return await server(request);
    }, {
        servers: new Map(Object.entries(servers)),
        down: new Set<string>(),
        sent: [],
    });
    return transport;
};
