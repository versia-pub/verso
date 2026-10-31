import { Filter, FilterKeyword, FilterStatus } from "@versia/client-api";
import { z } from "zod";
import { NotFound, Unprocessable } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Flag, Integer, Strings, Text } from "../http/schemas.ts";
import {
    filtersOf,
    filterStatusesOf,
    findFilter,
    findFilterStatus,
    findKeyword,
    keywordsOf,
} from "./filter_queries.ts";
import {
    addFilterStatus,
    addKeyword,
    changeFilter,
    changeKeyword,
    createFilter,
    type KeywordChange,
    removeFilter,
    removeFilterStatus,
    removeKeyword,
} from "./filters.ts";
import { renderFilter, renderFilters, renderFilterStatus, renderKeyword } from "./render.ts";
import { filterActions, filterContexts } from "./tables.ts";

/** The longest title or keyword a filter may have. Mastodon has no limit. */
const textLimit = 256;

/** The most keywords one request may add to a filter or change. */
const keywordsLimit = 100;

/** The furthest off a filter may expire, a hundred years from now, in seconds. */
const expiryLimit = 100 * 365 * 24 * 60 * 60;

const notBlank = (name: string) =>
    [
        (text: string) => text.trim() !== "",
        { error: `${name} can't be blank` },
    ] as const;

const FilterId = z.object({
    id: z.string().meta({ description: "The ID of the Filter in the database." }),
});

const ParentId = z.object({
    filter_id: z.string().meta({ description: "The ID of the Filter in the database." }),
});

const KeywordId = z.object({
    id: z.string().meta({ description: "The ID of the FilterKeyword in the database." }),
});

const FilterStatusId = z.object({
    id: z.string().meta({ description: "The ID of the FilterStatus in the database." }),
});

const Title = Text(textLimit).refine(...notBlank("Title")).meta({
    description: "The name of the filter group.",
});

// Mastodon drops blank contexts before checking them.
const Context = Strings
    .transform((contexts) => contexts.map((each) => each.trim()).filter((each) => each !== ""))
    .pipe(
        z.array(z.enum(filterContexts, { error: "None or invalid context supplied" }))
            .min(1, { error: "Context can't be blank" }),
    )
    .meta({
        description: "Where the filter should be applied. Specify at least one of `home`, " +
            "`notifications`, `public`, `thread`, `account`.",
    });

const FilterAction = z.enum(filterActions).meta({
    description: "The policy to be applied when the filter is matched. Specify `warn` or `hide`.",
});

// Mastodon reads a blank value as never expiring.
const ExpiresIn = z.union([
    Integer.pipe(z.int().min(0).max(expiryLimit)),
    z.literal("").transform(() => null),
    z.null(),
]);

const Keyword = Text(textLimit);

const WholeWord = Flag.meta({
    description: "Whether the keyword should consider word boundaries.",
});

const KeywordAttribute = z.object({
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

type KeywordAttribute = z.infer<typeof KeywordAttribute>;

// Rails reads nested attributes as an array, or as an object keyed by index, as forms send them.
const KeywordAttributes = z.union([
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
const keywordChangesOf = (attributes: readonly KeywordAttribute[]): KeywordChange[] =>
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

const auth = {
    read: { require: "user", scope: "read:filters", permission: "owner:filter" },
    write: { require: "user", scope: "write:filters", permission: "owner:filter" },
} as const;

const docs = "https://docs.joinmastodon.org/methods/filters";

/** The v2 filters, Mastodon's since 4.0, which Verso matches statuses with. */
export const filterRoutes: readonly Route[] = [
    defineRoute({
        method: "GET",
        path: "/api/v2/filters",
        summary: "View all filters",
        description: "Obtain a list of all filter groups for the current user.",
        docs: `${docs}/#get`,
        tags: ["filters"],
        auth: auth.read,
        responses: { 200: z.array(Filter) },
        handler: async (ctx, { viewer }) => ({
            status: 200,
            body: await renderFilters(ctx, await filtersOf(ctx, viewer.accountId)),
        }),
    }),
    // Before the routes with a filter's id, so that `keywords` and `statuses` aren't read as one.
    defineRoute({
        method: "GET",
        path: "/api/v2/filters/keywords/:id",
        summary: "View a single keyword",
        description: "Get one filter keyword by the given id.",
        docs: `${docs}/#keywords-get-one`,
        tags: ["filters"],
        auth: auth.read,
        params: KeywordId,
        responses: { 200: FilterKeyword },
        handler: async (ctx, { params, viewer }) => {
            const keyword = await findKeyword(ctx, viewer.accountId, params.id);
            if (keyword === undefined) throw new NotFound();

            return { status: 200, body: renderKeyword(keyword) };
        },
    }),
    defineRoute({
        method: "PUT",
        path: "/api/v2/filters/keywords/:id",
        summary: "Edit a keyword within a filter",
        description: "Update the given filter keyword.",
        docs: `${docs}/#keywords-update`,
        tags: ["filters"],
        auth: auth.write,
        params: KeywordId,
        body: z.object({
            keyword: Keyword.refine(...notBlank("Keyword")).optional().meta({
                description: "The keyword to be added to the filter group.",
            }),
            whole_word: WholeWord.optional(),
        }),
        responses: { 200: FilterKeyword },
        handler: async (ctx, { body, params, viewer }) => {
            const keyword = await changeKeyword(ctx, viewer.accountId, params.id, body);
            if (keyword === undefined) throw new NotFound();

            return { status: 200, body: renderKeyword(keyword) };
        },
    }),
    defineRoute({
        method: "DELETE",
        path: "/api/v2/filters/keywords/:id",
        summary: "Remove keywords from a filter",
        description: "Deletes the given filter keyword.",
        docs: `${docs}/#keywords-delete`,
        tags: ["filters"],
        auth: auth.write,
        params: KeywordId,
        responses: { 200: z.object({}) },
        handler: async (ctx, { params, viewer }) => {
            if (!await removeKeyword(ctx, viewer.accountId, params.id)) throw new NotFound();
            return { status: 200, body: {} };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v2/filters/statuses/:id",
        summary: "View a single status filter",
        description: "Obtain a single status filter.",
        docs: `${docs}/#statuses-get-one`,
        tags: ["filters"],
        auth: auth.read,
        params: FilterStatusId,
        responses: { 200: FilterStatus },
        handler: async (ctx, { params, viewer }) => {
            const status = await findFilterStatus(ctx, viewer.accountId, params.id);
            if (status === undefined) throw new NotFound();

            return { status: 200, body: renderFilterStatus(status) };
        },
    }),
    defineRoute({
        method: "DELETE",
        path: "/api/v2/filters/statuses/:id",
        summary: "Remove a status from a filter group",
        description: "Remove a status filter from the current filter group.",
        docs: `${docs}/#statuses-remove`,
        tags: ["filters"],
        auth: auth.write,
        params: FilterStatusId,
        responses: { 200: z.object({}) },
        handler: async (ctx, { params, viewer }) => {
            if (!await removeFilterStatus(ctx, viewer.accountId, params.id)) throw new NotFound();
            return { status: 200, body: {} };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v2/filters/:id",
        summary: "View a specific filter",
        description: "Obtain a single filter group owned by the current user.",
        docs: `${docs}/#get-one`,
        tags: ["filters"],
        auth: auth.read,
        params: FilterId,
        responses: { 200: Filter },
        handler: async (ctx, { params, viewer }) => {
            const filter = await findFilter(ctx, viewer.accountId, params.id);
            if (filter === undefined) throw new NotFound();

            return { status: 200, body: await renderFilter(ctx, filter) };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v2/filters",
        summary: "Create a filter",
        description: "Create a filter group with the given parameters.",
        docs: `${docs}/#create`,
        tags: ["filters"],
        auth: auth.write,
        body: z.object({
            title: Title,
            context: Context,
            filter_action: FilterAction.default("warn"),
            expires_in: ExpiresIn.default(null).meta({
                description: "How many seconds from now should the filter expire? Defaults to " +
                    "never expire.",
            }),
            keywords_attributes: KeywordAttributes,
        }),
        responses: { 200: Filter },
        handler: async (ctx, { body, viewer }) => {
            const keywords = keywordChangesOf(body.keywords_attributes).map((change) => {
                // Mastodon finds no keyword with that id in a filter that has none yet.
                if (!("add" in change)) throw new NotFound();
                return change.add;
            });
            const filter = await createFilter(ctx, viewer.accountId, {
                title: body.title,
                context: body.context,
                action: body.filter_action,
                expiresIn: body.expires_in,
            }, keywords);

            return { status: 200, body: await renderFilter(ctx, filter) };
        },
    }),
    defineRoute({
        method: "PUT",
        path: "/api/v2/filters/:id",
        summary: "Update a filter",
        description: "Update a filter group with the given parameters.",
        docs: `${docs}/#update`,
        tags: ["filters"],
        auth: auth.write,
        params: FilterId,
        body: z.object({
            title: Title.optional(),
            context: Context.optional(),
            filter_action: FilterAction.optional(),
            expires_in: ExpiresIn.optional().meta({
                description: "How many seconds from now should the filter expire?",
            }),
            keywords_attributes: KeywordAttributes,
        }),
        responses: { 200: Filter },
        handler: async (ctx, { body, params, viewer }) => {
            const filter = await changeFilter(ctx, viewer.accountId, params.id, {
                title: body.title,
                context: body.context,
                action: body.filter_action,
                expiresIn: body.expires_in,
            }, keywordChangesOf(body.keywords_attributes));
            if (typeof filter === "string") throw new NotFound();

            return { status: 200, body: await renderFilter(ctx, filter) };
        },
    }),
    defineRoute({
        method: "DELETE",
        path: "/api/v2/filters/:id",
        summary: "Delete a filter",
        description: "Delete a filter group with the given id.",
        docs: `${docs}/#delete`,
        tags: ["filters"],
        auth: auth.write,
        params: FilterId,
        responses: { 200: z.object({}) },
        handler: async (ctx, { params, viewer }) => {
            if (!await removeFilter(ctx, viewer.accountId, params.id)) throw new NotFound();
            return { status: 200, body: {} };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v2/filters/:filter_id/keywords",
        summary: "View keywords added to a filter",
        description: "List all keywords attached to the current filter group.",
        docs: `${docs}/#keywords-get`,
        tags: ["filters"],
        auth: auth.read,
        params: ParentId,
        responses: { 200: z.array(FilterKeyword) },
        handler: async (ctx, { params, viewer }) => {
            if (await findFilter(ctx, viewer.accountId, params.filter_id) === undefined) {
                throw new NotFound();
            }

            return {
                status: 200,
                body: (await keywordsOf(ctx, [params.filter_id])).map(renderKeyword),
            };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v2/filters/:filter_id/keywords",
        summary: "Add a keyword to a filter",
        description: "Add the given keyword to the specified filter group",
        docs: `${docs}/#keywords-create`,
        tags: ["filters"],
        auth: auth.write,
        params: ParentId,
        body: z.object({
            keyword: Keyword.refine(...notBlank("Keyword")).meta({
                description: "The keyword to be added to the filter group.",
            }),
            whole_word: WholeWord.default(true),
        }),
        responses: { 200: FilterKeyword },
        handler: async (ctx, { body, params, viewer }) => {
            const keyword = await addKeyword(ctx, viewer.accountId, params.filter_id, body);
            if (keyword === undefined) throw new NotFound();

            return { status: 200, body: renderKeyword(keyword) };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v2/filters/:filter_id/statuses",
        summary: "View all status filters",
        description: "Obtain a list of all status filters within this filter group.",
        docs: `${docs}/#statuses-get`,
        tags: ["filters"],
        auth: auth.read,
        params: ParentId,
        responses: { 200: z.array(FilterStatus) },
        handler: async (ctx, { params, viewer }) => {
            if (await findFilter(ctx, viewer.accountId, params.filter_id) === undefined) {
                throw new NotFound();
            }

            return {
                status: 200,
                body: (await filterStatusesOf(ctx, [params.filter_id])).map(renderFilterStatus),
            };
        },
    }),
    defineRoute({
        method: "POST",
        path: "/api/v2/filters/:filter_id/statuses",
        summary: "Add a status to a filter group",
        description: "Add a status filter to the current filter group.",
        docs: `${docs}/#statuses-add`,
        tags: ["filters"],
        auth: auth.write,
        params: ParentId,
        body: z.object({
            status_id: z.string().meta({
                description: "The status ID to be added to the filter group.",
            }),
        }),
        responses: { 200: FilterStatus },
        handler: async (ctx, { body, params, viewer }) => {
            const status = await addFilterStatus(
                ctx,
                viewer.accountId,
                params.filter_id,
                body.status_id,
            );
            if (status === "no_filter") throw new NotFound();
            if (status === "missing") throw new Unprocessable("Status must exist");
            if (status === "taken") throw new Unprocessable("Status has already been taken");

            return { status: 200, body: renderFilterStatus(status) };
        },
    }),
];
