import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { Binary, defineRoute, type Route } from "../http/route.ts";
import { lru } from "../kernel/lru.ts";
import { findAccount } from "./account_queries.ts";
import { identicon, identiconBanner } from "./identicon.ts";

const AccountId = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

/** A day: the pictures never change, but how they are drawn might. */
const pictureMaxAge = 24 * 60 * 60;

/** How many drawn pictures are kept, at a few kilobytes each. */
const kept = 1000;

/** Draws a picture from an account's id. */
type Draw = (seed: string) => Promise<Uint8Array>;

/**
 * The default pictures of accounts without their own. Timelines load many at once, so they have no
 * rate limit; instead, they are only drawn for accounts that exist, and each is drawn once and
 * kept.
 */
export const pictureRoutes = (
    draw: { readonly avatar: Draw; readonly header: Draw } = {
        avatar: identicon,
        header: identiconBanner,
    },
): readonly Route[] => {
    const drawn = lru<string, Promise<Uint8Array>>(kept);

    const picture = (name: keyof typeof draw, summary: string) =>
        defineRoute({
            method: "GET",
            path: `/accounts/:id/${name}.png`,
            summary,
            tags: ["accounts"],
            maxAge: pictureMaxAge,
            rateLimit: false,
            params: AccountId,
            responses: { 200: Binary("image/png") },
            handler: async (ctx, { params }) => {
                if (!await findAccount(ctx, params.id)) throw new NotFound();

                const key = `${name}:${params.id}`;
                let file = drawn.get(key);
                if (!file) {
                    file = draw[name](params.id);
                    drawn.set(key, file);
                }

                return { status: 200, file: await file };
            },
        });

    return [
        picture("avatar", "An account's default avatar"),
        picture("header", "An account's default header"),
    ];
};
