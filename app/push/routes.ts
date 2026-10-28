import { WebPushSubscription } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Flag } from "../http/schemas.ts";
import { bearerToken } from "../http/viewer.ts";
import { alertNames, renderSubscription } from "./render.ts";
import {
    deleteSubscription,
    findSubscription,
    replaceSubscription,
    updateSubscription,
} from "./subscription_queries.ts";

const docs = "https://docs.joinmastodon.org/methods/push";

const auth = { require: "user", scope: "push", permission: "owner:notification" } as const;

/** Bytes in URL-safe base64, or in base64, as some clients send them, padded or not. */
const Base64Bytes = (length: number, description: string) =>
    z.string()
        .transform((text) => text.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""))
        .refine((text) => {
            try {
                return Uint8Array.fromBase64(text, { alphabet: "base64url" }).length === length;
            } catch {
                return false;
            }
        }, `Must be ${length} bytes in URL-safe base64`)
        .meta({ description });

/** Which notifications to push, and whose: none unless asked for, and everyone's. */
const Data = z.object({
    alerts: z.object(Object.fromEntries(alertNames.map((name) => [name, Flag.optional()])))
        .optional()
        .meta({ description: "Whether to push each type of notification, by its type." }),
    policy: z.enum(["all", "followed", "follower", "none"]).optional().meta({
        description: "Whose notifications to push: `all`, `followed`, `follower` or `none`. " +
            "Defaults to `all`.",
    }),
}).optional();

/** The types `data` asks to push, and whose. */
const choices = (data: z.output<typeof Data>) => ({
    alerts: alertNames.filter((name) => data?.alerts?.[name] === true),
    policy: data?.policy ?? "all",
});

export const pushRoutes: readonly Route[] = [
    defineRoute({
        method: "POST",
        path: "/api/v1/push/subscription",
        summary: "Subscribe to push notifications",
        description: "Add a Web Push API subscription to receive notifications. Each access " +
            "token can have one push subscription. If you create a new subscription, the old " +
            "subscription is deleted. Verso only pushes to `https` endpoints.",
        docs: `${docs}/#create`,
        tags: ["push"],
        auth,
        headers: z.object({ authorization: z.string().optional() }),
        body: z.object({
            subscription: z.object({
                endpoint: z.url({ protocol: /^https$/ }).max(2048).meta({
                    description: "The endpoint URL that is called when a notification event " +
                        "occurs.",
                }),
                keys: z.object({
                    p256dh: Base64Bytes(
                        65,
                        "User agent public key. Base64 encoded string of " +
                            "a public key from a ECDH keypair using the `prime256v1` curve.",
                    )
                        // Its first byte, 4, is "B" in base64.
                        .refine((key) => key.startsWith("B"), "Must be an uncompressed point"),
                    auth: Base64Bytes(
                        16,
                        "Auth secret. Base64 encoded string of 16 bytes of " +
                            "random data.",
                    ),
                }),
            }),
            data: Data,
        }),
        responses: { 200: WebPushSubscription },
        handler: async (ctx, { body, headers, viewer }) => {
            const token = bearerToken(headers.authorization);
            // Push routes take tokens only in the header, so a viewer always has one there.
            if (token === undefined) throw new Error("A viewer without a bearer token");

            const row = {
                id: ctx.ids(),
                token_id: viewer.tokenId,
                account_id: viewer.accountId,
                access_token: token,
                endpoint: body.subscription.endpoint,
                p256dh: body.subscription.keys.p256dh,
                auth: body.subscription.keys.auth,
                ...choices(body.data),
                created_at: ctx.clock.now(),
            };
            await ctx.transaction((tx) => replaceSubscription(tx, row));

            return { status: 200, body: await renderSubscription(ctx, row) };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/push/subscription",
        summary: "Get current subscription",
        description: "View the PushSubscription currently associated with this access token.",
        docs: `${docs}/#get`,
        tags: ["push"],
        auth,
        responses: { 200: WebPushSubscription },
        handler: async (ctx, { viewer }) => {
            const row = await findSubscription(ctx, viewer.tokenId);
            if (!row) throw new NotFound();

            return { status: 200, body: await renderSubscription(ctx, row) };
        },
    }),
    defineRoute({
        method: "PUT",
        path: "/api/v1/push/subscription",
        summary: "Change types of notifications",
        description: "Updates the current push subscription. Only the data part can be " +
            "updated. To change fundamentals, a new subscription must be created instead. " +
            "What isn't given is reset, as when subscribing.",
        docs: `${docs}/#update`,
        tags: ["push"],
        auth,
        body: z.object({ data: Data }),
        responses: { 200: WebPushSubscription },
        handler: async (ctx, { body, viewer }) => {
            const { alerts, policy } = choices(body.data);
            const row = await updateSubscription(ctx, viewer.tokenId, alerts, policy);
            if (!row) throw new NotFound();

            return { status: 200, body: await renderSubscription(ctx, row) };
        },
    }),
    defineRoute({
        method: "DELETE",
        path: "/api/v1/push/subscription",
        summary: "Remove current subscription",
        description: "Removes the current Web Push API subscription.",
        docs: `${docs}/#delete`,
        tags: ["push"],
        auth,
        responses: { 200: z.object({}) },
        handler: async (ctx, { viewer }) => {
            await deleteSubscription(ctx, viewer.tokenId);
            return { status: 200, body: {} };
        },
    }),
];
