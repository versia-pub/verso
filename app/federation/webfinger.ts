/**
 * Finding users on other instances by their address, such as `bob@b.example`, with WebFinger.
 * @see https://versia.pub/federation/discovery
 * @module
 */
import { canonicalizeDomain, type Reference } from "@versia/protocol";
import { z } from "zod";
import type { Context } from "../kernel/context.ts";
import { fetchUnsigned } from "./request.ts";
import { ResolveFailed } from "./resolver.ts";

/** The parts of a JSON Resource Descriptor read here. Other instances may send more. */
const Jrd = z.object({
    links: z.array(z.object({ rel: z.string(), type: z.string().optional(), href: z.string() }))
        .default([]),
});

/** Where a Versia 0.6 User is fetched, so the link gives its id. */
const userPath = /^\/\.versia\/v0\.6\/entities\/User\/([A-Za-z0-9_-]+)$/;

/** The user a WebFinger link points at, if it is a Versia User on `domain`. */
const userOf = (domain: string, href: string): Reference | undefined => {
    const url = URL.parse(href);
    if (url?.protocol !== "https:" || url.host !== domain || url.search !== "") return undefined;

    const id = userPath.exec(url.pathname)?.[1];
    return id === undefined ? undefined : { host: domain, id };
};

/**
 * The Versia User `username@domain` is, asking `domain`, or `undefined` if there is none, or
 * none Verso may look up: on a blocked instance, or one at an address that isn't a domain. It
 * throws if the instance can't be reached or gives an answer that isn't WebFinger.
 */
export const webfinger = async (
    ctx: Context,
    username: string,
    domain: string,
): Promise<Reference | undefined> => {
    const host = canonicalizeDomain(domain);
    if (host === undefined || await ctx.federation.isBlocked(ctx, host)) return undefined;

    const url = new URL(`https://${host}/.well-known/webfinger`);
    url.searchParams.set("resource", `acct:${username}@${host}`);

    const reply = await fetchUnsigned(ctx, url, "application/jrd+json, application/json");

    if (reply.status === 404 || reply.status === 410) return undefined;
    if (reply.status < 200 || reply.status > 299) {
        throw new ResolveFailed(`${host} answered ${reply.status} to WebFinger`);
    }

    let jrd;
    try {
        jrd = Jrd.parse(JSON.parse(new TextDecoder().decode(reply.body)));
    } catch {
        throw new ResolveFailed(`${host} didn't answer with WebFinger`);
    }

    const link = jrd.links.find((link) =>
        link.rel === "self" && link.type?.split(";")[0].trim() === "application/vnd.versia+json"
    );
    return link && userOf(host, link.href);
};
