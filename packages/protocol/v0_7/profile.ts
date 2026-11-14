import { z } from "zod";
import { optional, RichText } from "./common.ts";

/** The key of {@link Profile} in a User's `extensions`. */
export const profileKey = "pub.versia:profile";

/** A BCP 47 language tag, like `en-US`. */
const LanguageTag = z.string().refine((tag) => {
    try {
        return Intl.getCanonicalLocales(tag).length === 1;
    } catch {
        return false;
    }
}, "Invalid language tag");

/**
 * An IANA time zone name, like `America/New_York`. `Intl` also takes offsets like `+01:00`, which
 * aren't names, so the shape is checked first.
 */
const TimeZone = z.string().regex(/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/).refine(
    (zone) => {
        try {
            new Intl.DateTimeFormat("en", { timeZone: zone });
            return true;
        } catch {
            return false;
        }
    },
    "Unknown time zone",
);

/** `YYYY-MM-DD`, or `--MM-DD` without the year. */
const Birthday = z.union([
    z.iso.date(),
    z.string().regex(/^--(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/),
]);

/**
 * What a user says about themselves, in its `extensions` under {@link profileKey}. `pronouns` maps
 * a language tag to plain text, like `{ "en": "she/her" }`.
 * @see https://versia.pub/extensions/profile
 */
export const Profile = z.object({
    bio: optional(RichText),
    fields: optional(z.array(z.object({ key: RichText, value: RichText }))),
    pronouns: optional(z.record(LanguageTag, z.string())),
    birthday: optional(Birthday),
    location: optional(z.string()),
    timezone: optional(TimeZone),
});
export type Profile = z.infer<typeof Profile>;
