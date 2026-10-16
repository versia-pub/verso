import { z } from "zod";
import { Binary, defineRoute, type Route } from "../http/route.ts";
import { identicon, identiconBanner } from "./identicon.ts";

const AccountId = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

/** A day: the pictures never change, but how they are drawn might. */
const pictureMaxAge = 24 * 60 * 60;

/** The default pictures of accounts without their own. Timelines load many, so no rate limit. */
export const accountRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/accounts/:id/avatar.png",
        summary: "An account's default avatar",
        tags: ["accounts"],
        maxAge: pictureMaxAge,
        rateLimit: false,
        params: AccountId,
        responses: { 200: Binary("image/png") },
        handler: async (_, { params }) => ({ status: 200, file: await identicon(params.id) }),
    }),
    defineRoute({
        method: "GET",
        path: "/accounts/:id/header.png",
        summary: "An account's default header",
        tags: ["accounts"],
        maxAge: pictureMaxAge,
        rateLimit: false,
        params: AccountId,
        responses: { 200: Binary("image/png") },
        handler: async (_, { params }) => ({ status: 200, file: await identiconBanner(params.id) }),
    }),
];
