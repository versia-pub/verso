/**
 * Requests to remote instances, signed as this instance.
 * @see https://versia.pub/signatures
 * @module
 */
import { sign } from "@versia/protocol";
import { versiaJson } from "../http/route.ts";
import type { Context } from "../kernel/context.ts";
import { checkSignature } from "../kernel/signatures.ts";
import { timeoutSignal, userAgent } from "../kernel/transport.ts";

/**
 * The largest response read from a remote instance: the largest body Verso accepts, so a fetched
 * entity is no larger than one sent to it, and displaying it costs no more.
 */
const maxReplyBytes = 256 * 1024;

/** How long a remote instance has to respond, so a slow one can't hold a worker. */
const timeoutMs = 30_000;

/** A response from a remote instance, with its body read. */
export type FederationReply = {
    readonly status: number;
    readonly headers: Headers;
    readonly body: Uint8Array<ArrayBuffer>;
};

/** A response from a remote instance that can't be used: too large, or not signed by it. */
export class BadReply extends Error {
    override readonly name = "BadReply";
}

/**
 * A remote instance couldn't be reached, or didn't respond in time. Only failures of the request
 * itself become this, so a bug in Verso can't pass for an instance being down.
 */
export class Unreachable extends Error {
    override readonly name = "Unreachable";
}

/** Reads a body, stopping as soon as it exceeds `maxReplyBytes`. */
const readCapped = async (response: Response): Promise<Uint8Array<ArrayBuffer>> => {
    const chunks: Uint8Array[] = [];
    let size = 0;

    const reader = response.body?.getReader();
    for (let read = await reader?.read(); read && !read.done; read = await reader?.read()) {
        size += read.value.length;
        if (size > maxReplyBytes) {
            await reader?.cancel();
            throw new BadReply(`The reply is larger than ${maxReplyBytes} bytes`);
        }

        chunks.push(read.value);
    }

    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
    }

    return body;
};

/**
 * Sends a request to a remote instance and reads the response, allowing `timeoutMs` in total, or
 * less if `ctx.signal` aborts first. It rejects with `Unreachable` when the instance can't be
 * reached or takes too long, and with `BadReply` when the response is too large.
 */
const send = async (
    ctx: Context,
    url: URL,
    init: { method: string; headers: Record<string, string>; body?: Uint8Array<ArrayBuffer> },
): Promise<FederationReply> => {
    const request = new Request(url, {
        ...init,
        headers: {
            ...init.headers,
            "user-agent": userAgent(ctx.urls.origin),
        },
        signal: timeoutSignal(timeoutMs, ctx.signal),
    });

    try {
        const response = await ctx.transport(request);
        return {
            status: response.status,
            headers: response.headers,
            body: await readCapped(response),
        };
    } catch (error) {
        if (error instanceof BadReply) throw error;
        throw new Unreachable(`${url.host} couldn't be reached: ${error}`, { cause: error });
    }
};

/**
 * Sends a request to a remote instance, signed as this instance, and reads the response, as `send`
 * does.
 */
export const sendSigned = async (
    ctx: Context,
    method: "GET" | "POST",
    url: URL,
    body: Uint8Array<ArrayBuffer> = new Uint8Array(),
): Promise<FederationReply> => {
    const signature = await sign(
        { method, pathname: url.pathname, body },
        (await ctx.federation.instanceKey(ctx)).privateKey,
        ctx.urls.domain,
        ctx.clock.now(),
    );

    return await send(ctx, url, {
        method,
        body: method === "GET" ? undefined : body,
        headers: {
            ...signature,
            accept: versiaJson,
            ...(method === "GET" ? {} : { "content-type": versiaJson }),
        },
    });
};

/**
 * Fetches from a remote instance without signing, for what any server may request, such as its
 * metadata or WebFinger, and reads the response, as `send` does.
 */
export const fetchUnsigned = (ctx: Context, url: URL, accept: string): Promise<FederationReply> =>
    send(ctx, url, { method: "GET", headers: { accept } });

/**
 * Posts plain text to a remote instance without signing, for what Versia doesn't sign, such as
 * instance messages, and reads the response, as `send` does.
 */
export const postUnsigned = (ctx: Context, url: URL, text: string): Promise<FederationReply> =>
    send(ctx, url, {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: new TextEncoder().encode(text),
    });

/**
 * Fetches from a remote instance with a signed GET. A successful response is only returned if the
 * instance that was asked signed it, so nobody in between, nor another instance, can answer for it.
 */
export const fetchSigned = async (
    ctx: Context,
    url: URL,
): Promise<FederationReply> => {
    const reply = await sendSigned(ctx, "GET", url);
    if (reply.status < 200 || reply.status > 299) return reply;

    const message = { method: "GET", pathname: url.pathname, body: reply.body };
    const verification = await checkSignature(
        ctx,
        ctx.federation.remoteKeys,
        message,
        reply.headers,
        url.hostname,
    );
    if (!verification.ok) throw new BadReply(`The reply isn't signed by ${url.hostname}`);

    return reply;
};
