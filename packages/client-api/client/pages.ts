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
 *
 * Most lists give their items as an array, which is the page's `body`. Some give them in a shape of
 * their own, such as notification groups with the accounts and statuses they refer to, and then
 * `body` is that, and `items` are picked from it.
 */
export class Page<T, B = readonly T[]> implements AsyncIterable<T> {
    private constructor(
        readonly body: B,
        readonly items: readonly T[],
        private readonly links: Map<string, string>,
        private readonly load: (url: string, options?: CallOptions) => Promise<Page<T, B>>,
    ) {}

    /** Gets the page of `item`s at `to` from `http`. */
    static get<S extends z.ZodType>(
        http: Http,
        item: S,
        to: string,
        query: Query,
        options?: CallOptions,
    ): Promise<Page<z.output<S>>> {
        return Page.getIn(http, z.array(item), (items) => items, to, query, options);
    }

    /** Gets the page at `to` from `http`, a `body` with its items picked out by `itemsOf`. */
    static async getIn<S extends z.ZodType, T>(
        http: Http,
        body: S,
        itemsOf: (body: z.output<S>) => readonly T[],
        to: string,
        query: Query,
        options?: CallOptions,
    ): Promise<Page<T, z.output<S>>> {
        const pageOf = async (response: Response): Promise<Page<T, z.output<S>>> => {
            const parsed = await parse(body, response);

            return new Page(
                parsed,
                itemsOf(parsed),
                linksOf(response.headers.get("link")),
                async (url, options) => pageOf(await http.send("GET", url, options)),
            );
        };

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
    next(options?: CallOptions): Promise<Page<T, B> | undefined> {
        const url = this.links.get("next");

        return url === undefined ? Promise.resolve(undefined) : this.load(url, options);
    }

    /** The newer page, or `undefined` if the instance links to none. It may be empty. */
    previous(options?: CallOptions): Promise<Page<T, B> | undefined> {
        const url = this.links.get("prev");

        return url === undefined ? Promise.resolve(undefined) : this.load(url, options);
    }

    /** This page and every older one, getting each as it is needed. */
    async *pages(): AsyncIterable<Page<T, B>> {
        yield this;
        for (let page = await this.next(); page !== undefined; page = await page.next()) {
            yield page;
        }
    }

    async *[Symbol.asyncIterator](): AsyncIterator<T> {
        for await (const page of this.pages()) yield* page.items;
    }
}
