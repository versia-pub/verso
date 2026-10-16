import { z } from "zod";

/** A boolean, as JSON sends it or as a form does: `true`, `1`, `false` or `0`. */
export const Flag: z.ZodType<boolean, boolean | string> = z.union([
    z.boolean(),
    z.stringbool({ truthy: ["true", "1"], falsy: ["false", "0"] }),
]);

/** Text of at most `max` characters, counted as Mastodon counts them, by code point. */
export const Text = (max: number): z.ZodType<string, string> =>
    z.string().refine((text) => Array.from(text).length <= max, {
        error: `Must be at most ${max} characters`,
    });

/** A whole number, as JSON sends it or as a form does, in digits. */
export const Integer: z.ZodType<number, number | string> = z.union([
    z.int(),
    z.string().regex(/^-?\d+$/, { error: "Must be a whole number" }).transform(Number).pipe(
        z.int(),
    ),
]);
