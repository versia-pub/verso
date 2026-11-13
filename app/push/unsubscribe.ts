/**
 * Links in pushes that remove their subscription without a token, in an `Unsubscribe-URL` header
 * like Mastodon's. They hold the subscription's id, signed with the VAPID key, and expire when the
 * push would.
 * @see https://docs.joinmastodon.org/methods/push/
 * @module
 */
import { jwtVerify, SignJWT } from "@panva/jose";
import type { Context } from "../kernel/context.ts";

/** What sets these apart from the JWTs that sign pushes, which are `JWT`. */
const typ = "unsubscribe+jwt";

/** The link that removes the subscription `id`, for `validSeconds` from now. */
export const unsubscribeUrl = async (
    ctx: Context,
    id: string,
    validSeconds: number,
): Promise<string> => {
    const key = await ctx.federation.vapidKey(ctx);
    const token = await new SignJWT({ sub: id })
        .setProtectedHeader({ typ, alg: "ES256" })
        .setAudience(ctx.urls.origin)
        .setExpirationTime(Math.floor(ctx.clock.now().getTime() / 1000) + validSeconds)
        .sign(key.privateKey);

    return ctx.urls.url`/api/web/push_subscriptions/${token}`;
};

/** The id of the subscription `token` removes, unless it is forged, expired, or not one. */
export const unsubscribedId = async (
    ctx: Context,
    token: string,
): Promise<string | undefined> => {
    const key = await crypto.subtle.importKey(
        "raw",
        (await ctx.federation.vapidKey(ctx)).publicKey,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
    );

    try {
        const { payload } = await jwtVerify(token, key, {
            typ,
            audience: ctx.urls.origin,
            currentDate: ctx.clock.now(),
            requiredClaims: ["sub", "exp"],
        });

        return payload.sub;
    } catch {
        return undefined;
    }
};
