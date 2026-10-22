/**
 * Users of complete instances, as their clients see them, for scenarios across a network.
 * @module
 */
import { assertEquals } from "@std/assert";
import { tokenFor } from "../auth/testing.ts";
import type { Instance, Network } from "./network.ts";

/** A user's client: calls their instance's client API, with a JSON body if there is one. */
export type Client = (
    method: string,
    path: string,
    body?: Record<string, unknown>,
) => Promise<{
    status: number;
    // deno-lint-ignore no-explicit-any -- scenarios read whatever JSON the API gives back
    body: any;
}>;

/** Calls `instance`'s client API as `accountId`. */
export const clientOf = async (instance: Instance, accountId: string): Promise<Client> => {
    const authorization = `Bearer ${await tokenFor(instance.ctx, accountId)}`;

    return async (method, path, body) => {
        const response = await instance.app.request(path, {
            method,
            headers: body === undefined
                ? { authorization }
                : { authorization, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

        return { status: response.status, body: await response.json() };
    };
};

/** Has `client` look up `acct` and follow them. Returns the id their instance gives them. */
export const followAddress = async (client: Client, acct: string): Promise<string> => {
    const found = await client("GET", `/api/v1/accounts/lookup?acct=${acct}`);
    assertEquals(found.status, 200, acct);
    assertEquals((await client("POST", `/api/v1/accounts/${found.body.id}/follow`)).status, 200);

    return found.body.id;
};

/** How many times each host was sent an entity of `type`, from the `from`th request on. */
export const deliveries = async (
    network: Network,
    type: string,
    from: number,
): Promise<Record<string, number>> => {
    const hosts: Record<string, number> = {};
    for (const request of network.transport.sent.slice(from)) {
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== "/.versia/v0.6/inbox") continue;
        if ((await request.clone().json()).type !== type) continue;

        hosts[url.host] = (hosts[url.host] ?? 0) + 1;
    }

    return hosts;
};
