import { z } from "zod";
import { optional, ReferenceText, TransientEntity } from "./common.ts";

/** The extension that {@link Report} is from. */
export const reportsKey = "pub.versia:reports";

/**
 * A report to the moderators of the instance it is sent to, of the users and Notes in `reported`,
 * with `tags` such as `spam` to sort it by. It is anonymous if `author` is left out.
 * @see https://versia.pub/extensions/reports
 */
export const Report = TransientEntity.extend({
    type: z.literal("pub.versia:reports/Report"),
    author: optional(ReferenceText),
    reported: z.array(ReferenceText),
    tags: z.array(z.string()),
    comment: optional(z.string()),
});
export type Report = z.infer<typeof Report>;
