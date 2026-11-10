/**
 * Fetching from web servers that anyone can name, such as the pages that statuses link to and the
 * media of remote instances. Every hop of a redirect is a new request through the context's web
 * transport, so each is checked as the first was.
 * @module
 */
import type { Context } from "./context.ts";
import { readLimited } from "./limited.ts";
import { timeoutSignal, userAgent } from "./transport.ts";

/** How many redirects are followed. */
const maxRedirects = 5;

/** How long a fetch may take in all, as Mastodon allows. */
const totalMs = 30_000;

/** What a fetch gives back: the address it ended at, the response's headers, and its body. */
export type Fetched = {
    readonly url: URL;
    readonly headers: Headers;
    readonly body: Uint8Array<ArrayBuffer>;
    /** Whether the body was cut off at the limit. */
    readonly truncated: boolean;
};

/**
 * Fetches `url` and follows redirects to other web addresses, then reads up to `limit` bytes of the
 * body. Resolves with `undefined` if it ends in anything but a 200, runs out of redirects or time,
 * can't be reached, or isn't of a type `accept` approves. The fetch is of public addresses only,
 * as far as the context's web transport guarantees.
 */
export const fetchLimited = async (
    ctx: Context,
    url: URL,
    options: {
        readonly accept: string;
        /** Whether the response's `Content-Type` is one to read. */
        readonly approves: (contentType: string) => boolean;
        readonly limit: number;
    },
): Promise<Fetched | undefined> => {
    const signal = timeoutSignal(totalMs, ctx.signal);

    try {
        let at = url;
        for (let redirects = 0; redirects <= maxRedirects; redirects++) {
            const response = await ctx.webTransport(
                new Request(at, {
                    headers: {
                        "Accept": options.accept,
                        "User-Agent": `${userAgent(ctx.urls.origin)} Bot`,
                    },
                    redirect: "manual",
                    signal,
                }),
            );

            const location = response.headers.get("location");
            if (response.status >= 300 && response.status < 400 && location) {
                await response.body?.cancel();
                const next = new URL(location, at);
                if (!/^https?:$/.test(next.protocol)) return undefined;

                at = next;
                continue;
            }

            const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
            if (response.status !== 200 || !type || !options.approves(type)) {
                await response.body?.cancel();
                return undefined;
            }

            const { body, truncated } = await readLimited(response.body, options.limit);
            return { url: at, headers: response.headers, body, truncated };
        }
    } catch {
        // A server that can't be reached, or that isn't a public one, gives nothing.
    }

    return undefined;
};
