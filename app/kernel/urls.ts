/**
 * Builds this instance's public URLs. Every URL Verso hands out (API `uri` and `url` fields,
 * WebFinger links, media) comes from here, so none are glued together from strings elsewhere.
 */
export type UrlBuilder = {
    /** The instance's domain, as Versia names instances: a bare hostname, without a port. */
    readonly domain: string;
    /** `https://` plus the instance's domain, or the development origin, with no trailing slash. */
    readonly origin: string;
    /**
     * A URL on this instance, written as a tagged template: `` urls.url`/api/v1/accounts/${id}` ``.
     * Each value becomes exactly one path segment, so it can't add segments or change the host.
     */
    url(path: TemplateStringsArray, ...values: string[]): string;
};

/**
 * Makes the builder for `domain`, which must be a bare hostname such as `config.domain`. In
 * development, `origin` can replace `https://<domain>`, such as with `http://localhost:8080`.
 */
export const urlBuilder = (domain: string, origin = `https://${domain}`): UrlBuilder => {
    return {
        domain,
        origin,
        url: (path, ...values) => {
            if (!path[0].startsWith("/")) {
                throw new Error(
                    `URL paths start with "/": ${path.join("${…}")}`,
                );
            }

            const encoded = values.map((value) => {
                // An empty value leaves a gap in the path, and URL parsing reads "." and ".." as
                // "this folder" and "the folder above".
                if (value === "" || value === "." || value === "..") {
                    throw new Error(`"${value}" can't be a URL path segment`);
                }
                return encodeURIComponent(value);
            });

            return origin + String.raw({ raw: path }, ...encoded);
        },
    };
};

/**
 * A URL on another Versia instance, at `domain`: `path` under its `/.versia/v0.6`, such as
 * `/inbox`. The path is Verso's own, so it is used as it is.
 * @see https://versia.pub/api/endpoints
 */
export const versiaUrl = (domain: string, path: string): URL =>
    new URL(`/.versia/v0.6${path}`, `https://${domain}`);

/**
 * Where an entity of `type` on another Versia instance, at `domain`, is fetched. Its type and id
 * are encoded, so each stays one segment, even an extension's type, such as
 * `pub.versia:likes/Like`.
 * @see https://versia.pub/api/endpoints
 */
export const entityUrl = (domain: string, type: string, id: string): URL =>
    versiaUrl(domain, `/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}`);
