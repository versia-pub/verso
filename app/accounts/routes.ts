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
import { type AccountRow, decorationsOfAccounts, findAccount } from "./account_queries.ts";
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

/**
 * The viewer's own account, with its roles, decorations, what it may do, and who has requested to
 * follow it.
 */
const ownAccount = async (ctx: Context, viewer: RouteViewer & { readonly accountId: string }) => {
    const row = found(await findAccount(ctx, viewer.accountId));

    return renderCredentialAccount(
        ctx,
        row,
        await rolesOf(ctx, row.id),
        renderEmojis(ctx, (await emojisOfAccounts(ctx, [row.id])).get(row.id) ?? []),
        (await decorationsOfAccounts(ctx, [row.id])).get(row.id) ?? [],
        await viewer.permissions(),
        await countFollowRequests(ctx, row.id),
    );
};

/** The viewer's own profile, as they wrote it, with the hashtags they feature and decorations. */
const ownProfile = async (ctx: Context, viewer: RouteViewer & { readonly accountId: string }) =>
    renderProfile(
        ctx,
        found(await findAccount(ctx, viewer.accountId)),
        await renderFeaturedTags(ctx, await featuredTagsOf(ctx, viewer.accountId)),
        (await decorationsOfAccounts(ctx, [viewer.accountId])).get(viewer.accountId) ?? [],
    );

/** Mastodon's limit on the domains an account may name as able to credit it. */
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

/** How many images may be drawn over an avatar. */
const maxAvatarOverlays = 4;

/** The days in each month of a leap year, which a birthday without a year may be any day of. */
const leapMonthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Whether `year` has a 29th of February. */
const isLeapYear = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

/** A birthday as Versia has it: `YYYY-MM-DD` that is a real date, or `--MM-DD` without a year. */
const Birthday = z.string().refine((birthday) => {
    if (birthday === "") return true;

    const [, year, month, day] = /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/.exec(birthday) ?? [];
    if (month === undefined) return false;

    const days = leapMonthDays[Number(month) - 1];
    if (days === undefined) return false;

    const most = month === "02" && year !== undefined && !isLeapYear(Number(year)) ? 28 : days;

    return Number(day) >= 1 && Number(day) <= most;
}, { error: "Must be a date like 2000-12-31, or --12-31 without the year" });

/** The canonical form of the time zone `name`, or `undefined` if it isn't one. */
const canonicalTimeZone = (name: string) => {
    try {
        const zone = new Intl.DateTimeFormat("en", { timeZone: name }).resolvedOptions().timeZone;
        // Intl also takes offsets like "+01:00", which aren't IANA names.
        return /^[+-]/.test(zone) ? undefined : zone;
    } catch {
        return undefined;
    }
};

/** An IANA time zone in its canonical case, or empty for none. */
const Timezone = z.string().transform((name, ctx) => {
    const zone = name === "" ? "" : canonicalTimeZone(name);
    if (zone !== undefined) return zone;

    ctx.addIssue({ code: "custom", message: "Must be an IANA time zone, like America/New_York" });
    return z.NEVER;
});

/** The canonical form of the BCP 47 language tag `tag`, or `undefined` if it isn't one. */
const canonicalTag = (tag: string) => {
    try {
        return Intl.getCanonicalLocales(tag)[0];
    } catch {
        return undefined;
    }
};

/** Pronouns by BCP 47 language tag, with the tags in canonical form, within `limits`. */
const Pronouns = (limits: Limits) =>
    z.record(z.string(), Text(limits.field_name))
        // Blank values are dropped when stored, so they don't count.
        .refine(
            (pronouns) =>
                Object.values(pronouns).filter((value) => value.trim() !== "").length <=
                    limits.fields,
            {
                error: `At most ${limits.fields} languages`,
            },
        )
        .transform((pronouns, ctx) => {
            const canonical: Record<string, string> = {};

            for (const [tag, value] of Object.entries(pronouns)) {
                const language = canonicalTag(tag);
                if (language === undefined) {
                    ctx.addIssue({
                        code: "custom",
                        path: [tag],
                        message: "Must be a BCP 47 language tag, like en",
                    });
                    continue;
                }

                canonical[language] = value;
            }

            return canonical;
        });

/** Room for the form's other fields and boundaries, besides the files. */
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
    pronouns: body.pronouns,
    birthday: body.birthday,
    location: body.location,
    timezone: body.timezone,
    avatarOverlays: body.avatar_overlays,
    avatarMask: body.avatar_mask,
    background: body.background,
    audio: body.audio,
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
        pronouns: Pronouns(limits).optional(),
        birthday: Birthday.optional(),
        location: Text(limits.field_value).optional(),
        timezone: Timezone.optional(),
        avatar_overlays: z.array(Picture).min(1).max(maxAvatarOverlays, {
            error: `At most ${maxAvatarOverlays} overlays`,
        }).optional(),
        avatar_mask: Picture.optional(),
        background: Picture.optional(),
        audio: Picture.optional(),
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

/** The routes that remove a decoration, with the change `updateProfile` takes for each. */
const removableDecorations = [
    {
        path: "avatar_overlays",
        change: "avatarOverlays",
        summary: "Delete profile avatar overlays",
        description: "Deletes the images drawn over the avatar of the user's profile.",
    },
    {
        path: "avatar_mask",
        change: "avatarMask",
        summary: "Delete profile avatar mask",
        description: "Deletes the image that masks the avatar of the user's profile.",
    },
    {
        path: "background",
        change: "background",
        summary: "Delete profile background",
        description: "Deletes the background image of the user's profile.",
    },
    {
        path: "audio",
        change: "audio",
        summary: "Delete profile audio",
        description: "Deletes the sound of the user's profile.",
    },
] as const;

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
        maxBodyBytes: 9 * media.max_upload_bytes + formBytes,
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
        maxBodyBytes: 9 * media.max_upload_bytes + formBytes,
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
    ...removableDecorations.map(({ path, change, summary, description }) =>
        defineRoute({
            method: "DELETE",
            path: `/api/v1/profile/${path}`,
            summary,
            description,
            tags: ["accounts"],
            auth: {
                require: "user",
                scope: "write:accounts",
                permission: "owner:account",
                whileMoved: true,
            },
            responses: { 200: CredentialAccount },
            handler: async (ctx, { viewer }) => {
                await updateProfile(ctx, viewer.accountId, { [change]: null });
                return { status: 200, body: await ownAccount(ctx, viewer) };
            },
        })
    ),
    ...pictureRoutes(),
];
