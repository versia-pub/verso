/**
 * Accounts as Versia renders them: local ones for remote instances, and remote users for Verso.
 * @module
 */
import { formatReference, type Reference, type v0_6, v0_7 } from "@versia/protocol";
import type { EntityType, Known } from "../federation/registry.ts";
import type { Context } from "../kernel/context.ts";
import { sanitizeHtml, sanitizerVersion, textOfHtml } from "../kernel/html.ts";
import { emojisOfAccounts, type ShownEmoji } from "../emojis/emoji_queries.ts";
import { emojiExtensionsV07, remoteEmojisOfV07 } from "../emojis/versia.ts";
import { findMedia } from "../media/media_queries.ts";
import type { RemoteMedia } from "../media/media_queries.ts";
import { isPlayable, pictureTypes } from "../media/uploads.ts";
import { maxUrlLength, remoteMediaV07, versiaMediaV07 } from "../media/versia.ts";
import {
    type AccountRow,
    findAccount,
    findAccountDecorations,
    findAccounts,
    findRemoteAccount,
    findRemoteAccountAt,
} from "./account_queries.ts";
import { prepareUserMove, receiveUserMove, referenceOf, savePrevious } from "./moves.ts";
import { profileUrl } from "./render.ts";
import {
    deleteRemoteAccount,
    type RemoteAccount,
    type RemoteDecoration,
    saveRemoteAccount,
} from "./remote.ts";
import type { DecorationKind, ProfileField, TextFormat } from "./tables.ts";

/**
 * Whether the local account `id` has an avatar or header still being processed, so it isn't
 * finished changing and isn't sent to remote instances yet.
 */
export const hasPicturesProcessing = async (ctx: Context, id: string): Promise<boolean> => {
    const row = await localUser(ctx, id);
    const pictures = [row?.avatar_id ?? null, row?.header_id ?? null];

    for (const picture of pictures) {
        if (picture === null) continue;
        if ((await findMedia(ctx, picture))?.processed_at === null) return true;
    }

    return false;
};

/** A local account's picture `id`, once processed, or else its default one at `fallback`. */
const ownPicture = async (
    ctx: Context,
    id: string | null,
    fallback: string,
): Promise<v0_7.Media> => {
    const row = id === null ? undefined : await findMedia(ctx, id);
    return (row && versiaMediaV07(ctx, row)) ?? { url: fallback, media_type: "image/png" };
};

/**
 * The migration extension of the local account `row`, with `movedTo` as the reference to the
 * account it moved to, if it says it moved from an account, or to one.
 */
const migrationExtension = (
    row: AccountRow,
    movedTo: string | undefined,
): v0_7.Entity["extensions"] => {
    const { previous_host: host, previous_id: id } = row;
    const previous = host === null || id === null ? undefined : v0_7.formatReference({ host, id });
    if (previous === undefined && movedTo === undefined) return undefined;

    const extension: v0_7.MigrationExtension = {
        ...previous !== undefined && { previous },
        ...movedTo !== undefined && { destination: movedTo },
    };
    return { [v0_7.migrationKey]: extension };
};

/** `extensions`, or `undefined` if there are none. */
const someExtensions = (extensions: NonNullable<v0_7.Entity["extensions"]>) =>
    Object.keys(extensions).length === 0 ? undefined : extensions;

/** The Profile extension of the local account `row`, or none if its profile is empty. */
const profileExtension = (row: AccountRow): v0_7.Entity["extensions"] => {
    const profile: v0_7.Profile = {
        bio: row.note === "" ? undefined : row.note_html,
        fields: row.fields.length === 0
            ? undefined
            : row.fields.map((field) => ({ key: field.name_html, value: field.value_html })),
        pronouns: Object.keys(row.pronouns).length === 0 ? undefined : row.pronouns,
        birthday: row.birthday ?? undefined,
        location: row.location ?? undefined,
        timezone: row.timezone ?? undefined,
    };

    return Object.values(profile).every((value) => value === undefined)
        ? undefined
        : { [v0_7.profileKey]: profile };
};

/** What a local account has to show as decorations: its header and its processed others. */
type OwnDecorations = {
    readonly header: v0_7.Media;
    readonly decorations: readonly { kind: DecorationKind; media: v0_7.Media }[];
};

/** The Decorations extension of a local account: its header and other decorations. */
const decorationsExtension = (
    { header, decorations }: OwnDecorations,
): v0_7.Entity["extensions"] => {
    const of = (kind: DecorationKind) =>
        decorations.filter((decoration) => decoration.kind === kind).map(({ media }) => media);
    const overlays = of("avatar_overlay");

    const extension: v0_7.Decorations = {
        header,
        avatar_overlays: overlays.length === 0 ? undefined : overlays,
        avatar_mask: of("avatar_mask")[0],
        background: of("background")[0],
        audio: of("audio")[0],
    };

    return { [v0_7.decorationsKey]: extension };
};

/**
 * A local account as a Versia User, with its profile, the custom emojis it uses, its pictures and
 * decorations, and the reference to the account it moved to, if it did.
 */
const renderVersiaUser = (
    ctx: Context,
    row: AccountRow,
    emojis: readonly ShownEmoji[],
    avatar: v0_7.Media,
    decorations: OwnDecorations,
    movedTo: string | undefined,
): v0_7.User => ({
    type: "User",
    id: row.id,
    created_at: row.created_at.toISOString(),
    username: row.username,
    display_name: row.display_name === "" ? undefined : row.display_name,
    avatar,
    manually_approves_subscribers: row.locked,
    indexable: row.indexable,
    url: profileUrl(ctx, row),
    extensions: someExtensions({
        ...profileExtension(row),
        ...decorationsExtension(decorations),
        ...emojiExtensionsV07(ctx, emojis),
        ...migrationExtension(row, movedTo),
    }),
});

/** The local user with this id, or `undefined` if there is none. */
const localUser = async (ctx: Context, id: string) => {
    const row = await findAccount(ctx, id);
    return row?.domain === null ? row : undefined;
};

/** The user that `reference` points at, local or remote, if Verso has it, without fetching it. */
export const knownUser = async (ctx: Context, reference: Reference): Promise<Known | undefined> => {
    if (reference.host === ctx.urls.domain) {
        const row = await localUser(ctx, reference.id);
        return row && { id: row.id, fetchedAt: null };
    }

    const row = await findRemoteAccountAt(ctx, reference.host, reference.id);
    // A remote account is always saved with the time it was fetched.
    return row && { id: row.id, fetchedAt: row.fetched_at ?? new Date(0) };
};

/** The local user with this id as a Versia User, or `undefined` if there is none. */
export const localVersiaUser = async (
    ctx: Context,
    id: string,
): Promise<v0_7.User | undefined> => {
    const row = await localUser(ctx, id);
    if (row === undefined) return undefined;

    const emojis = (await emojisOfAccounts(ctx, [row.id])).get(row.id) ?? [];
    // Versia v0.7 writes the host of every reference, even to a local account.
    const destination = row.moved_to_account_id === null
        ? undefined
        : await findAccount(ctx, row.moved_to_account_id);
    const movedTo = destination && v0_7.formatReference(referenceOf(ctx, destination));

    const decorations = [];
    for (const { kind, media_id } of await findAccountDecorations(ctx, row.id)) {
        const media = await findMedia(ctx, media_id);
        const shown = media && versiaMediaV07(ctx, media);
        if (shown) decorations.push({ kind, media: shown });
    }

    return renderVersiaUser(
        ctx,
        row,
        emojis,
        await ownPicture(ctx, row.avatar_id, ctx.urls.url`/accounts/${row.id}/avatar.png`),
        {
            header: await ownPicture(
                ctx,
                row.header_id,
                ctx.urls.url`/accounts/${row.id}/header.png`,
            ),
            decorations,
        },
        movedTo,
    );
};

/**
 * Users: remote ones, stored as remote accounts, and local ones, fetched by remote instances. Their
 * collections are added by the modules that own them: who follows whom by the graph module, and
 * what they wrote and pinned by the notes module.
 * @see https://versia.pub/entities/user
 */
export const userType: EntityType<v0_7.User> = {
    type: "User",
    schema: v0_7.User,
    // A profile can change back to what it was.
    resendable: true,
    // A user has no author, and lives where it came from.
    authority: (_, origin) => origin,
    // A user that moved has the account it moved to fetched again.
    prepare: (ctx, user, sender, budget) => prepareUserMove(ctx, user, sender.domain, budget),
    receive: async (ctx, user, sender) => {
        // Verso chooses which users it stores, so an instance can't fill it with users nobody
        // requested: a user sent unsolicited only updates a user Verso already has.
        if (!sender.fetched && !await findRemoteAccount(ctx, sender.instanceId, user.id)) return;

        const id = await saveRemoteAccount(ctx, remoteAccountOf(sender.instanceId, user));
        await savePrevious(ctx, id, user, sender.domain);
        await receiveUserMove(ctx, user, sender.domain);
    },
    deleteRemote: (ctx, id, sender) => deleteRemoteAccount(ctx, sender.instanceId, id),
    known: knownUser,
    find: (ctx, id) => localVersiaUser(ctx, id),
};

/**
 * References to the users of `ids` that exist, by id, as Verso puts them in what it sends: a bare
 * id for local users, and the host and id for remote ones.
 */
export const userReferenceMap = async (
    ctx: Context,
    ids: readonly string[],
): Promise<Map<string, string>> => {
    const references = new Map<string, string>();

    for (const row of await findAccounts(ctx, ids)) {
        if (row.domain === null) {
            references.set(row.id, row.id);
            continue;
        }

        if (row.remote_id === null) throw new Error(`Remote account ${row.id} has no remote id`);
        references.set(
            row.id,
            formatReference({ host: row.domain, id: row.remote_id }, ctx.urls.domain),
        );
    }

    return references;
};

/** References to the users of `ids` that exist, in the order of `ids`. */
export const userReferences = async (ctx: Context, ids: readonly string[]): Promise<string[]> => {
    const references = await userReferenceMap(ctx, ids);
    return ids.flatMap((id) => references.get(id) ?? []);
};

/** Text as written, in the first format Verso supports that contains it, or none. */
const writtenText = (formats: v0_6.ContentFormat): { format: TextFormat; text: string } => {
    for (const format of ["text/plain", "text/markdown"] as const) {
        const entry = formats[format];
        if (entry && !entry.remote) return { format, text: entry.content };
    }

    return { format: "text/plain", text: "" };
};

/**
 * Text as Verso stores it: as written, and as sanitised HTML. The HTML is the remote instance's own
 * if it gave one, or else generated by `html` from what was written.
 */
export const remoteText = (
    formats: v0_6.ContentFormat | null | undefined,
    html: (text: string, format: TextFormat) => string,
): { format: TextFormat; text: string; html: string } => {
    const written = writtenText(formats ?? {});
    const given = formats?.["text/html"];

    return {
        ...written,
        html: sanitizeHtml(
            given && !given.remote ? given.content : html(written.text, written.format),
        ),
    };
};

/** How many avatar overlays Verso stores for a user, which bounds what a peer can make it store. */
const maxOverlays = 10;

/** The extension `key` of `user`, if it is one that `schema` accepts, or else an empty one. */
const extensionOf = <T extends v0_7.Profile | v0_7.Decorations>(
    schema: { safeParse: (data: unknown) => { data?: T } },
    user: v0_7.User,
    key: string,
): Partial<T> => schema.safeParse(user.extensions?.[key]).data ?? {};

/** The image `media`, if clients can display its type. */
const remoteImage = (media: v0_7.Media | null | undefined): RemoteMedia | null =>
    remoteMediaV07(media, (mediaType) => pictureTypes.has(mediaType));

/** The decorations of a user that Verso stores: the header isn't one, and is stored apart. */
const remoteDecorationsOf = (decorations: v0_7.Decorations): RemoteDecoration[] => {
    const single = (kind: DecorationKind, media: RemoteMedia | null): RemoteDecoration[] =>
        media === null ? [] : [{ kind, position: 0, media }];

    const overlays = (decorations.avatar_overlays ?? []).flatMap((overlay) =>
        remoteImage(overlay) ?? []
    )
        .slice(0, maxOverlays);

    return [
        ...overlays.map((media, position): RemoteDecoration => ({
            kind: "avatar_overlay",
            position,
            media,
        })),
        ...single("avatar_mask", remoteImage(decorations.avatar_mask)),
        ...single("background", remoteImage(decorations.background)),
        ...single("audio", remoteMediaV07(decorations.audio, isPlayable)),
    ];
};

/**
 * Rich text from a peer as Verso stores it: as sanitised HTML, and as the text of that, without the
 * spaces `textOfHtml` puts around blocks.
 */
const remoteRichText = (html: string | null | undefined) => {
    const sanitised = sanitizeHtml(html ?? "");
    return { html: sanitised, text: textOfHtml(sanitised).trim() };
};

/**
 * A user on the instance `instanceId`, as Verso stores it. An extension that doesn't match what
 * Versia defines is treated as absent, as custom emojis are, so it can't make Verso reject the
 * user.
 */
export const remoteAccountOf = (instanceId: string, user: v0_7.User): RemoteAccount => {
    const profile = extensionOf(v0_7.Profile, user, v0_7.profileKey);
    const decorations = extensionOf(v0_7.Decorations, user, v0_7.decorationsKey);

    const bio = remoteRichText(profile.bio);
    const fields = (profile.fields ?? []).map((field): ProfileField => {
        const name = remoteRichText(field.key);
        const value = remoteRichText(field.value);

        return {
            // Clients display a field's name as text.
            name: name.text.replaceAll(/\s+/g, " ").trim(),
            value: value.text,
            format: "text/plain",
            name_html: name.html,
            value_html: value.html,
        };
    });

    return {
        instanceId,
        remoteId: user.id,
        createdAt: new Date(user.created_at),
        profile: {
            username: user.username,
            display_name: user.display_name ?? "",
            note: bio.text,
            note_format: "text/plain",
            note_html: bio.html,
            fields,
            pronouns: profile.pronouns ?? {},
            birthday: profile.birthday ?? null,
            location: profile.location ?? null,
            timezone: profile.timezone ?? null,
            url: user.url && user.url.length <= maxUrlLength ? user.url : null,
            html_version: sanitizerVersion,
            locked: user.manually_approves_subscribers,
            indexable: user.indexable,
        },
        avatar: remoteImage(user.avatar),
        header: remoteImage(decorations.header),
        decorations: remoteDecorationsOf(decorations),
        emojis: remoteEmojisOfV07(user.extensions),
    };
};
