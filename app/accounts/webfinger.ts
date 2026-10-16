import { z } from "zod";
import { BadRequest, NotFound } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { findLocalAccount } from "./accounts.ts";

/**
 * A JSON Resource Descriptor: what a WebFinger lookup answers.
 * @see https://www.rfc-editor.org/rfc/rfc7033#section-4.4
 */
const Jrd = z.object({
    subject: z.string(),
    aliases: z.array(z.url()),
    links: z.array(z.object({ rel: z.string(), type: z.string(), href: z.url() })),
});

/** `acct:user@domain`, the only kind of resource looked up. */
const acctUri = /^acct:([^@\s]+)@([^@\s]+)$/i;

/**
 * Finds a local account by its address, giving the URL of its Versia User entity, as Versia's
 * discovery does.
 * @see https://versia.pub/federation/discovery
 */
export const webfingerRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/.well-known/webfinger",
        summary: "A local account, by its acct: address",
        tags: ["versia"],
        contentType: "application/jrd+json",
        // The resource is checked by hand, so a bad one gets WebFinger's 400 rather than 422.
        query: z.object({ resource: z.string().optional() }),
        responses: { 200: Jrd },
        handler: async (ctx, { query }) => {
            const match = acctUri.exec(query.resource ?? "");
            if (!match) throw new BadRequest("The resource must be an acct: URI");

            const domain = new URL(ctx.urls.origin).hostname;
            const [, username, host] = match;
            const account = host.toLowerCase() === domain
                ? await findLocalAccount(ctx, username)
                : undefined;
            if (!account) throw new NotFound();

            const profile = ctx.urls.url`/@${account.username}`;
            const user = ctx.urls.url`/.versia/v0.6/entities/User/${account.id}`;

            return {
                status: 200,
                body: {
                    subject: `acct:${account.username}@${domain}`,
                    aliases: [user, profile],
                    links: [
                        {
                            rel: "http://webfinger.net/rel/profile-page",
                            type: "text/html",
                            href: profile,
                        },
                        { rel: "self", type: "application/vnd.versia+json", href: user },
                        {
                            rel: "http://webfinger.net/rel/avatar",
                            type: "image/png",
                            href: ctx.urls.url`/accounts/${account.id}/avatar.png`,
                        },
                    ],
                },
            };
        },
    }),
];
