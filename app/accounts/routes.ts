import { Account, CredentialAccount, Preferences, Profile } from "@versia/client-api";
import { z } from "zod";
import { emojisOfAccounts } from "../emojis/emoji_queries.ts";
import { renderEmojis } from "../emojis/render.ts";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route, type RouteViewer } from "../http/route.ts";
import { Flag, Ids, Strings, Text } from "../http/schemas.ts";
import { DomainName, type Limits, type MediaLimits } from "../kernel/config_sections.ts";
import { countFollowRequests } from "../graph/follows.ts";
import type { Context } from "../kernel/context.ts";
import { MediaDescription } from "../media/routes.ts";
import { featuredTagsOf } from "../tags/featured_tag_queries.ts";
import { renderFeaturedTags } from "../tags/render.ts";
import { type AccountRow, findAccount } from "./account_queries.ts";
import { findAccountByAddress, parseAddress } from "./addresses.ts";
import { pictureRoutes } from "./picture_routes.ts";
import { type ProfileChanges, updateProfile } from "./profile.ts";
import { publicAccount, publicAccounts } from "./public.ts";
import { renderCredentialAccount, renderPreferences, renderProfile } from "./render.ts";
import { rolesOf } from "./role_queries.ts";

const found = (row: AccountRow | undefined) => {
    if (row === undefined) throw new NotFound();
    return row;
};

/** The viewer's own account, with its roles, what it may do, and who has requested to follow it. */
const ownAccount = async (ctx: Context, viewer: RouteViewer & { readonly accountId: string }) => {
    const row = found(await findAccount(ctx, viewer.accountId));
    return renderCredentialAccount(
        ctx,
        row,
        await rolesOf(ctx, row.id),
        renderEmojis(ctx, (await emojisOfAccounts(ctx, [row.id])).get(row.id) ?? []),
        await viewer.permissions(),
        await countFollowRequests(ctx, row.id),
    );
};

/** The viewer's own profile, as they wrote it, with the hashtags they feature. */
const ownProfile = async (ctx: Context, viewer: RouteViewer & { readonly accountId: string }) =>
    renderProfile(
        ctx,
        found(await findAccount(ctx, viewer.accountId)),
        await renderFeaturedTags(ctx, await featuredTagsOf(ctx, viewer.accountId)),
    );

/** The most domains an account may name as able to credit it, as Mastodon allows. */
const maxAttributionDomains = 100;

/**
 * Domains as Mastodon reads them: without a leading `http://`, `https://` or `*.`, and without
 * blank ones or repeats. Domains are lowercase, which Mastodon doesn't enforce.
 */
const AttributionDomains = Strings
    .transform((entries) =>
        entries
            .map((entry) =>
                entry.trim().replace(/^http:\/\//, "").replace(/^https:\/\//, "").replace(
                    /^\*\./,
                    "",
                )
            )
            .filter((entry) => entry !== "")
    )
    .pipe(z.array(DomainName))
    .transform((domains) => [...new Set(domains)])
    .pipe(
        z.array(z.string()).max(maxAttributionDomains, {
            error: `At most ${maxAttributionDomains} domains`,
        }),
    );

/** Room for the form's other fields and boundaries, besides the pictures. */
const formBytes = 64 * 1024;

/** What `update_credentials` or `PATCH /api/v1/profile` sets, as `updateProfile` takes it. */
const profileUpdate = (
    body: Omit<z.output<ReturnType<typeof credentialChanges>>, "source">,
): ProfileChanges => ({
    displayName: body.display_name,
    note: body.note,
    fields: body.fields_attributes,
    locked: body.locked,
    bot: body.bot,
    discoverable: body.discoverable,
    indexable: body.indexable,
    hideCollections: body.hide_collections,
    attributionDomains: body.attribution_domains,
    avatar: { file: body.avatar, description: body.avatar_description },
    header: { file: body.header, description: body.header_description },
});

/**
 * What `update_credentials` changes, within `limits`, with pictures at most as large as `media`
 * allows uploads to be. Quote policies are accepted but not stored; Verso doesn't restrict quotes.
 * @see https://docs.joinmastodon.org/methods/accounts/#update_credentials
 */
const credentialChanges = (media: MediaLimits, limits: Limits) => {
    const Picture = z.file().max(media.max_upload_bytes, {
        error: `Must be at most ${media.max_upload_bytes} bytes`,
    });

    const ProfileField = z.object({
        name: Text(limits.field_name).default(""),
        value: Text(limits.field_value).default(""),
    });

    return z.object({
        display_name: Text(limits.display_name).optional(),
        note: Text(limits.note).optional(),
        locked: Flag.optional(),
        bot: Flag.optional(),
        discoverable: Flag.optional(),
        indexable: Flag.optional(),
        hide_collections: Flag.optional(),
        attribution_domains: AttributionDomains.optional(),
        avatar: Picture.optional(),
        avatar_description: MediaDescription(limits).optional(),
        header: Picture.optional(),
        header_description: MediaDescription(limits).optional(),
        /** An array, or an object by index, as forms send it; either way in order. */
        fields_attributes: z.union([
            z.array(ProfileField),
            z.record(z.string().regex(/^\d+$/), ProfileField).transform(Object.values),
        ])
            .refine((fields) => fields.length <= limits.fields, {
                error: `At most ${limits.fields} fields`,
            })
            .optional(),
        source: z.object({
            privacy: z.enum(["public", "unlisted", "private"]).optional(),
            sensitive: Flag.optional(),
            language: z.union([z.literal(""), z.string().regex(/^[a-z]{2}$/)]).optional(),
        }).optional(),
    });
};

/**
 * What `PATCH /api/v1/profile` changes: what `update_credentials` does, except the defaults for new
 * statuses, and which tabs the profile shows.
 * @see https://docs.joinmastodon.org/methods/profile/#update
 */
const profileChanges = (media: MediaLimits, limits: Limits) =>
    credentialChanges(media, limits).omit({ source: true }).extend({
        show_media: Flag.optional(),
        show_media_replies: Flag.optional(),
        show_featured: Flag.optional(),
    });

/**
 * Accounts, and the default pictures of accounts without their own, with profiles held to `limits`
 * and pictures to `media`.
 */
export const accountRoutes = (media: MediaLimits, limits: Limits): readonly Route[] => [
    // Before `/api/v1/accounts/:id`, which would otherwise match these paths.
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/verify_credentials",
        summary: "Verify account credentials",
        description: "Test to make sure that the user token works.",
        docs: "https://docs.joinmastodon.org/methods/accounts/#verify_credentials",
        tags: ["accounts"],
        auth: { require: "user", scope: "profile", whileMoved: true },
        responses: { 200: CredentialAccount },
        handler: async (ctx, { viewer }) => ({ status: 200, body: await ownAccount(ctx, viewer) }),
    }),
    defineRoute({
        method: "PATCH",
        path: "/api/v1/accounts/update_credentials",
        summary: "Update account credentials",
        description: "Update the user's display and preferences.",
        docs: "https://docs.joinmastodon.org/methods/accounts/#update_credentials",
        tags: ["accounts"],
        auth: {
            require: "user",
            scope: "write:accounts",
            permission: "owner:account",
            whileMoved: true,
        },
        maxBodyBytes: 2 * media.max_upload_bytes + formBytes,
        body: credentialChanges(media, limits),
        responses: { 200: CredentialAccount },
        handler: async (ctx, { viewer, body }) => {
            await updateProfile(ctx, viewer.accountId, {
                ...profileUpdate(body),
                defaultVisibility: body.source?.privacy,
                defaultSensitive: body.source?.sensitive,
                defaultLanguage: body.source?.language,
            });

            return { status: 200, body: await ownAccount(ctx, viewer) };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/lookup",
        summary: "Lookup account ID from WebFinger address",
        description:
            "Quickly lookup a username to see if it is available, skipping WebFinger resolution.",
        docs: "https://docs.joinmastodon.org/methods/accounts/#lookup",
        tags: ["accounts"],
        auth: { require: "optional", permission: "read:account" },
        query: z.object({ acct: z.string() }),
        responses: { 200: Account },
        handler: async (ctx, { query, viewer }) => {
            const address = parseAddress(ctx, query.acct);
            if (address === undefined) throw new NotFound();

            // Anyone else could make Verso fetch from wherever they liked.
            const fetch = typeof viewer?.accountId === "string";
            const row = await findAccountByAddress(ctx, address, { fetch });

            return { status: 200, body: await publicAccount(ctx, found(row)) };
        },
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts",
        summary: "Get multiple accounts",
        description: "View information about multiple profiles.",
        docs: "https://docs.joinmastodon.org/methods/accounts/#index",
        tags: ["accounts"],
        auth: { require: "optional", permission: "read:account" },
        query: z.object({
            id: Ids(40).default([]).meta({ description: "The IDs of the accounts." }),
        }),
        responses: { 200: z.array(Account) },
        handler: async (ctx, { query }) => ({
            status: 200,
            body: await publicAccounts(ctx, query.id),
        }),
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/accounts/:id",
        summary: "Get account",
        description: "View information about a profile.",
        docs: "https://docs.joinmastodon.org/methods/accounts/#get",
        tags: ["accounts"],
        auth: { require: "optional", permission: "read:account" },
        params: z.object({ id: z.string() }),
        responses: { 200: Account },
        handler: async (ctx, { params }) => ({
            status: 200,
            body: await publicAccount(ctx, found(await findAccount(ctx, params.id))),
        }),
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/preferences",
        summary: "View user preferences",
        description: "Preferences defined by the user in their account settings.",
        docs: "https://docs.joinmastodon.org/methods/preferences/#get",
        tags: ["accounts"],
        auth: { require: "user", scope: "read:accounts", whileMoved: true },
        responses: { 200: Preferences },
        handler: async (ctx, { viewer }) => ({
            status: 200,
            body: renderPreferences(found(await findAccount(ctx, viewer.accountId))),
        }),
    }),
    defineRoute({
        method: "GET",
        path: "/api/v1/profile",
        summary: "View profile",
        description: "Get the user's own profile, as they wrote it, for editing.",
        docs: "https://docs.joinmastodon.org/methods/profile/#get",
        tags: ["accounts"],
        auth: { require: "user", scope: "profile", whileMoved: true },
        responses: { 200: Profile },
        handler: async (ctx, { viewer }) => ({ status: 200, body: await ownProfile(ctx, viewer) }),
    }),
    defineRoute({
        method: "PATCH",
        path: "/api/v1/profile",
        summary: "Update profile",
        description: "Update the user's own profile.",
        docs: "https://docs.joinmastodon.org/methods/profile/#update",
        tags: ["accounts"],
        auth: {
            require: "user",
            scope: "write:accounts",
            permission: "owner:account",
            whileMoved: true,
        },
        maxBodyBytes: 2 * media.max_upload_bytes + formBytes,
        body: profileChanges(media, limits),
        responses: { 200: Profile },
        handler: async (ctx, { viewer, body }) => {
            await updateProfile(ctx, viewer.accountId, {
                ...profileUpdate(body),
                showMedia: body.show_media,
                showMediaReplies: body.show_media_replies,
                showFeatured: body.show_featured,
            });

            return { status: 200, body: await ownProfile(ctx, viewer) };
        },
    }),
    ...(["avatar", "header"] as const).map((picture) =>
        defineRoute({
            method: "DELETE",
            path: `/api/v1/profile/${picture}`,
            summary: `Delete profile ${picture}`,
            description: picture === "avatar"
                ? "Deletes the avatar associated with the user's profile."
                : "Deletes the header image associated with the user's profile.",
            docs: `https://docs.joinmastodon.org/methods/profile/#delete-profile-${picture}`,
            tags: ["accounts"],
            auth: {
                require: "user",
                scope: "write:accounts",
                permission: "owner:account",
                whileMoved: true,
            },
            responses: { 200: CredentialAccount },
            handler: async (ctx, { viewer }) => {
                await updateProfile(ctx, viewer.accountId, { [picture]: null });
                return { status: 200, body: await ownAccount(ctx, viewer) };
            },
        })
    ),
    ...pictureRoutes(),
];
