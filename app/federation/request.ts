/**
 * Requests to other instances, signed as this one.
 * @see https://versia.pub/signatures
 * @module
 */
import { sign } from "@versia/protocol";
import denoConfig from "../../deno.json" with { type: "json" };
import { versiaJson } from "../http/route.ts";
import type { Context } from "../kernel/context.ts";
import { checkSignature } from "../kernel/signatures.ts";

/** The largest reply read from another instance. Entities and pages of 40 fit with room to spare. */
const maxReplyBytes = 1024 * 1024;

/** How long another instance has to answer, so a slow one can't hold a worker. */
const timeoutMs = 30_000;

/** A reply from another instance, with its body read. */
export type FederationReply = {
    readonly status: number;
    readonly headers: Headers;
    readonly body: Uint8Array<ArrayBuffer>;
};

/** Another instance's reply that can't be used: too large, or not signed by it. */
export class BadReply extends Error {
    override readonly name = "BadReply";
}

/**
 * Another instance couldn't be reached, or didn't answer in time. Only failures of the request
 * itself become this, so a bug in Verso can't pass for an instance being down.
 */
export class Unreachable extends Error {
    override readonly name = "Unreachable";
}

/** Reads a body, stopping as soon as it passes `maxReplyBytes`. */
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
 * Sends a request to another instance and reads the reply, giving it `timeoutMs` in all. It
 * rejects with `Unreachable` when the instance can't be reached or takes too long, and with
 * `BadReply` when the reply is too large.
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
            "user-agent": `Verso/${denoConfig.version} (+${ctx.urls.origin})`,
        },
        signal: AbortSignal.timeout(timeoutMs),
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

/** Sends a request to another instance, signed as this one, and reads the reply, as `send` does. */
export const sendSigned = async (
    ctx: Context,
    method: "GET" | "POST",
    url: URL,
    body: Uint8Array<ArrayBuffer> = new Uint8Array(),
): Promise<FederationReply> => {
    const signature = await sign(
        { method, pathname: url.pathname, body },
        await ctx.federation.signingKey(ctx),
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
 * Fetches from another instance without signing, for what any server may ask, such as its
 * metadata or WebFinger, and reads the reply, as `send` does.
 */
export const fetchUnsigned = (ctx: Context, url: URL, accept: string): Promise<FederationReply> =>
    send(ctx, url, { method: "GET", headers: { accept } });

/**
 * Fetches from another instance with a signed GET. A successful reply is only given if the
 * instance asked signed it, so nobody in between, nor another instance, can answer for it.
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
