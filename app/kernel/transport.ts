/**
 * Sends an HTTP request to another server and resolves with its response, or rejects when the
 * server can't be reached, like `fetch`. Every outgoing request goes through it, so tests can
 * replace the network.
 */
export type Transport = (request: Request) => Promise<Response>;

export const fetchTransport: Transport = (request: Request): Promise<Response> => fetch(request);
