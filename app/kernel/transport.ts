/**
 * Sends an HTTP request to another server and resolves with its response, or rejects when the
 * server can't be reached, like `fetch`. Every outgoing request goes through it, so tests can
 * replace the network.
 */
export type Transport = (request: Request) => Promise<Response>;

/** For servers the admin configured, such as identity providers. */
export const fetchTransport: Transport = (request: Request): Promise<Response> => fetch(request);

export type FederationTransportOptions = {
    readonly fetch?: (request: Request, init: RequestInit) => Promise<Response>;
};

/**
 * For other instances, which anyone can name, such as in a signature's `Versia-Signed-By`.
 * Redirects aren't followed, since they could point anywhere and Versia's endpoints don't redirect:
 * the redirect itself is the response.
 */
export const federationTransport = (options: FederationTransportOptions = {}): Transport => {
    const send = options.fetch ?? fetch;

    return async (request) => await send(request, { redirect: "manual" });
};
