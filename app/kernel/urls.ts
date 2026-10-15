/**
 * Builds this instance's public URLs. Every URL Verso hands out (API `uri` and `url` fields,
 * WebFinger links, media) comes from here, so none are glued together from strings elsewhere.
 */
export type UrlBuilder = {
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
