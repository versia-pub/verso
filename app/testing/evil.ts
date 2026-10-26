import { sign } from "@versia/protocol";
import { type KeyPair, keyPair, metadata } from "../instances/testing.ts";
import type { Network } from "./network.ts";

export type EvilRequest = {
    readonly method?: "GET" | "POST";
    /** Sent as it is if a string, or else as JSON. */
    readonly body?: unknown;
    /** Who the signature claims to be from. Defaults to the evil instance itself. */
    readonly signedBy?: string;
    /** Defaults to the network's time. */
    readonly signedAt?: Date;
};

/**
 * An instance on the network with a valid key of its own, which signs whatever it is told to, to
 * test what an honest-looking peer still can't do.
 */
export type EvilInstance = {
    readonly domain: string;
    /** Sends a request signed with its own key, to `url` on any instance. */
    readonly send: (url: string, request?: EvilRequest) => Promise<Response>;
    /**
     * Responds to GETs to `path` with `body` as JSON, signed by itself unless `signed` is false.
     */
    readonly serve: (path: string, body: unknown, options?: { signed?: boolean }) => void;
    /** Replaces its key pair, as an instance whose key leaked would. */
    readonly rotateKey: () => Promise<void>;
};

const bytesOf = (body: unknown) =>
    new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));

/** Adds an evil instance at `domain` to the network, which says it supports `extensions`. */
export const addEvilInstance = async (
    network: Network,
    domain: string,
    extensions: readonly string[] = [],
): Promise<EvilInstance> => {
    let pair: KeyPair = await keyPair();
    const served = new Map<string, { body: unknown; signed: boolean }>();

    network.transport.servers.set(domain, async (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/.versia/v0.6/instance") {
            return Response.json(metadata(domain, pair.spki, "ed25519", extensions));
        }

        const entry = served.get(pathname);
        if (!entry) return Response.json({ error: "Not found" }, { status: 404 });

        const body = bytesOf(entry.body);
        const headers = entry.signed
            ? await sign(
                { method: request.method, pathname, body },
                pair.privateKey,
                domain,
                network.clock.now(),
            )
            : {};

        return new Response(body, {
            headers: { ...headers, "content-type": "application/vnd.versia+json" },
        });
    });

    return {
        domain,
        send: async (url, request = {}) => {
            const method = request.method ?? (request.body === undefined ? "GET" : "POST");
            const body = request.body === undefined ? new Uint8Array() : bytesOf(request.body);
            const headers = await sign(
                { method, pathname: new URL(url).pathname, body },
                pair.privateKey,
                request.signedBy ?? domain,
                request.signedAt ?? network.clock.now(),
            );

            return await network.transport(
                new Request(url, {
                    method,
                    body: method === "GET" ? undefined : body,
                    headers: { ...headers, "content-type": "application/vnd.versia+json" },
                }),
            );
        },
        serve: (path, body, options = {}) => {
            served.set(path, { body, signed: options.signed ?? true });
        },
        rotateKey: async () => {
            pair = await keyPair();
        },
    };
};
