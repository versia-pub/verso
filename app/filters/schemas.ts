/**
 * What the filter routes accept: their path parameters, bodies and the limits on them.
 * @module
 */
import { z } from "zod";
import { Unprocessable } from "../http/errors.ts";
import { Flag, Integer, notBlank, Strings, Text } from "../http/schemas.ts";
import type { KeywordChange } from "./filters.ts";
import { filterActions, filterContexts } from "./tables.ts";

/** The longest title or keyword a filter may have. Mastodon has no limit. */
export const textLimit = 256;

/** The most keywords one request may add to a filter or change. */
export const keywordsLimit = 100;

/** The furthest off a filter may expire, a hundred years from now, in seconds. */
export const expiryLimit = 100 * 365 * 24 * 60 * 60;

export const FilterId = z.object({
    id: z.string().meta({ description: "The ID of the Filter in the database." }),
});

export const ParentId = z.object({
    filter_id: z.string().meta({ description: "The ID of the Filter in the database." }),
});

export const KeywordId = z.object({
    id: z.string().meta({ description: "The ID of the FilterKeyword in the database." }),
});

export const FilterStatusId = z.object({
    id: z.string().meta({ description: "The ID of the FilterStatus in the database." }),
});

export const Title = Text(textLimit).refine(...notBlank("Title")).meta({
    description: "The name of the filter group.",
});

// Mastodon drops blank contexts before checking them.
export const Context = Strings
    .transform((contexts) => contexts.map((each) => each.trim()).filter((each) => each !== ""))
    .pipe(
        z.array(z.enum(filterContexts, { error: "None or invalid context supplied" }))
            .min(1, { error: "Context can't be blank" }),
    )
    .meta({
        description: "Where the filter should be applied. Specify at least one of `home`, " +
            "`notifications`, `public`, `thread`, `account`.",
    });

export const FilterAction = z.enum(filterActions).meta({
    description:
        "The policy to be applied when the filter is matched. Specify `warn`, `hide` or `blur`.",
});

// Mastodon reads a blank value as never expiring.
export const ExpiresIn = z.union([
    Integer.pipe(z.int().min(0).max(expiryLimit)),
    z.literal("").transform(() => null),
    z.null(),
]);

export const Keyword = Text(textLimit);

export const WholeWord = Flag.meta({
    description: "Whether the keyword should consider word boundaries.",
});

export const KeywordAttribute = z.object({
    id: z.string().optional().meta({
        description: "Provide the ID of an existing keyword to modify it, instead of creating a " +
            "new keyword.",
    }),
    keyword: Keyword.optional().meta({
        description: "A keyword to be added to the newly-created filter group.",
    }),
    whole_word: WholeWord.optional(),
    _destroy: Flag.optional().meta({
        description: "If true, will remove the keyword with the given ID.",
    }),
});

export type KeywordAttribute = z.infer<typeof KeywordAttribute>;

// Rails reads nested attributes as an array, or as an object keyed by index, as forms send them.
export const KeywordAttributes = z.union([
    z.array(KeywordAttribute),
    z.record(z.string(), KeywordAttribute).transform((byIndex) => Object.values(byIndex)),
])
    .refine((attributes) => attributes.length <= keywordsLimit, {
        error: `Must be at most ${keywordsLimit} keywords`,
    })
    .default([]);

/**
 * What `keywords_attributes` asks to do to a filter's keywords, as Rails reads it: one with an id
 * changes or removes that keyword, and one without adds a keyword, unless it is blank or removed.
 */
export const keywordChangesOf = (attributes: readonly KeywordAttribute[]): KeywordChange[] =>
    attributes.flatMap(({ id, keyword, whole_word, _destroy }): KeywordChange[] => {
        const blank = keyword === undefined || keyword.trim() === "";

        if (id !== undefined) {
            if (_destroy) return [{ remove: id }];
            if (keyword !== undefined && blank) {
                throw new Unprocessable("Keywords keyword can't be blank");
            }

            return [{ change: id, to: { keyword, whole_word } }];
        }

        if (_destroy || (blank && whole_word !== true)) return [];
        if (blank) throw new Unprocessable("Keywords keyword can't be blank");

        return [{ add: { keyword, whole_word: whole_word ?? true } }];
    });
