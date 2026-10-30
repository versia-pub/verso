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

/** A query's list, as `types[]=a&types[]=b`, or a single `types=a`. */
export const Strings: z.ZodType<string[], string | string[]> = z.union([
    z.string().transform((one) => [one]),
    z.array(z.string()),
]);

/** A query's list of ids, as {@link Strings} takes it, each once, and at most `max` of them. */
export const Ids = (max: number): z.ZodType<string[], string | string[]> =>
    Strings.transform((ids) => [...new Set(ids)]).pipe(
        z.array(z.string()).max(max, { error: `Must be at most ${max} ids` }),
    );
