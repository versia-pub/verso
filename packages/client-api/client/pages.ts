/**
 * Lists, which instances give a page at a time, newest first, linking to the pages beside each.
 * @see https://docs.joinmastodon.org/api/guidelines/#pagination
 * @module
 */
import { z } from "zod";
import { type CallOptions, type Http, parse, type Query } from "./http.ts";

/** Which page of a list to get. Without cursors, it is the newest. */
export type PageQuery = {
    /** Only what is older than this id. */
    readonly max_id?: string;
    /** Only what is newer than this id, starting from the newest. */
    readonly since_id?: string;
    /** Only what is newer than this id, starting just after it. */
    readonly min_id?: string;
    /** At most this many. The instance has a default and a maximum. */
    readonly limit?: number;
};

/** The URLs a `Link` header gives for each `rel`. */
const linksOf = (header: string | null): Map<string, string> =>
    new Map(
        [...(header ?? "").matchAll(/<([^>]*)>\s*;\s*rel="?([^",;]+)"?/g)]
            .map(([, url, rel]) => [rel, url]),
    );

/**
 * A page of a list. Iterating it with `for await` gives its items and those of every older page,
 * getting each as it is needed.
 */
export class Page<T> implements AsyncIterable<T> {
    private constructor(
        readonly items: readonly T[],
        private readonly links: Map<string, string>,
        private readonly load: (url: string, options?: CallOptions) => Promise<Page<T>>,
    ) {}

    /** Gets the page of `item`s at `to` from `http`. */
    static async get<S extends z.ZodType>(
        http: Http,
        item: S,
        to: string,
        query: Query,
        options?: CallOptions,
    ): Promise<Page<z.output<S>>> {
        const pageOf = async (response: Response): Promise<Page<z.output<S>>> =>
            new Page(
                await parse(z.array(item), response),
                linksOf(response.headers.get("link")),
                async (url, options) => pageOf(await http.send("GET", url, options)),
            );

        return pageOf(await http.send("GET", to, { ...options, query }));
    }

    /** Whether there is an older page. */
    get hasNext(): boolean {
        return this.links.has("next");
    }

    /** Whether there may be a newer page. Instances link to it even when nothing is newer yet. */
    get hasPrevious(): boolean {
        return this.links.has("prev");
    }

    /** The older page, or `undefined` if this is the oldest. */
    next(options?: CallOptions): Promise<Page<T> | undefined> {
        const url = this.links.get("next");

        return url === undefined ? Promise.resolve(undefined) : this.load(url, options);
    }

    /** The newer page, or `undefined` if the instance links to none. It may be empty. */
    previous(options?: CallOptions): Promise<Page<T> | undefined> {
        const url = this.links.get("prev");

        return url === undefined ? Promise.resolve(undefined) : this.load(url, options);
    }

    async *[Symbol.asyncIterator](): AsyncIterator<T> {
        yield* this.items;
        for (let page = await this.next(); page !== undefined; page = await page.next()) {
            yield* page.items;
        }
    }
}
