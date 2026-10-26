import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { Binary, defineRoute, type Route } from "../http/route.ts";
import { lru } from "../kernel/lru.ts";
import { findAccount } from "./account_queries.ts";
import { identicon, identiconBanner } from "./identicon.ts";

const AccountId = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

/** A day: the pictures never change, but how they are drawn might. */
const pictureMaxAge = 24 * 60 * 60;

/** How many generated pictures are cached, at a few kilobytes each. */
const kept = 1000;

/** Generates a picture from an account's id. */
type Draw = (seed: string) => Promise<Uint8Array>;

/**
 * The default pictures of accounts without their own. Timelines load many at once, so these
 * requests are counted separately from other requests, with a far larger limit. Pictures are only
 * generated for accounts that exist, and each is generated once and cached; one that couldn't be
 * generated is generated again next time.
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
            // Ten times what a client may request from other routes.
            rateLimit: { bucket: "pictures", times: 10 },
            params: AccountId,
            responses: { 200: Binary("image/png") },
            handler: async (ctx, { params }) => {
                if (!await findAccount(ctx, params.id)) throw new NotFound();

                const key = `${name}:${params.id}`;
                let file = drawn.get(key);
                if (!file) {
                    file = draw[name](params.id);
                    drawn.set(key, file);
                    const drawing = file;
                    drawing.catch(() => {
                        // Unless it was generated again in the meantime.
                        if (drawn.get(key) === drawing) drawn.delete(key);
                    });
                }

                return { status: 200, file: await file };
            },
        });

    return [
        picture("avatar", "An account's default avatar"),
        picture("header", "An account's default header"),
    ];
};
