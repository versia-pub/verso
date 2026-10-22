/**
 * Instance messaging: other instances tell this one, in plain text, why something it sent them
 * failed, as Versia has it for debugging federation. Messages are only logged, for admins to read.
 * @see https://versia.pub/extensions/instance-messaging
 * @module
 */
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { defineRoute, NoBody, type Route } from "../http/route.ts";

export const messagingExtension = "pub.versia:instance_messaging";

/**
 * The longest message logged, enough to name what failed and why, and to quote some of it. Longer
 * ones are cut, so a message can't fill the logs.
 */
const maxMessageLength = 4096;

const logger = getLogger(["verso", "federation", "messaging"]);

/**
 * Where other instances send messages. Versia doesn't sign them, so anyone may send one, and what
 * it says of who sent it can't be trusted. Rate limits keep anyone from sending too many.
 */
export const messagingRoute: Route = defineRoute({
    method: "POST",
    path: "/.versia/v0.6/messaging",
    summary: "A message from another instance about why something this one sent failed",
    tags: ["versia"],
    textBody: true,
    body: z.string().trim().min(1),
    responses: { 200: NoBody },
    handler: (_ctx, { body }) => {
        const cut = body.length > maxMessageLength;
        logger.info("Another instance sent a message: {message}", {
            message: cut ? `${body.slice(0, maxMessageLength)}…` : body,
        });

        return Promise.resolve({ status: 200 });
    },
});
