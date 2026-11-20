/**
 * Fetching the collections of remote entities, like the replies of a status or the subscribers of a
 * user.
 * @see https://versia.pub/federation/endpoints#entity-collections
 * @module
 */
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import { entityUrl } from "../kernel/urls.ts";
import { fetchSigned } from "./request.ts";

/**
 * A page of the collection `name` of the remote entity `remoteId`, of Versia type `type`, on
 * `domain`, as JSON, or `null` if its instance doesn't have it. A page can't be empty, so its
 * `limit` is at least 1.
 */
export const fetchEntityCollection = async (
    ctx: Context,
    domain: string,
    type: string,
    remoteId: string,
    name: string,
    page: { readonly offset?: number; readonly limit: number },
): Promise<unknown> => {
    const url = entityUrl(domain, type, remoteId);
    url.pathname += `/collections/${name}`;
    if (page.offset !== undefined) url.searchParams.set("offset", String(page.offset));
    url.searchParams.set("limit", String(page.limit));

    const reply = await fetchSigned(ctx, url);
    if (reply.status === 404 || reply.status === 410) return null;
    if (reply.status < 200 || reply.status > 299) {
        throw new Error(`${domain} answered ${reply.status} for ${name} of ${remoteId}`);
    }

    try {
        return JSON.parse(new TextDecoder().decode(reply.body));
    } catch {
        throw new PermanentFailure(`${domain} sent an invalid ${name}`);
    }
};
