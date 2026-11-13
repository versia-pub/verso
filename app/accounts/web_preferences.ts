/**
 * Each local user's settings for the web app, kept as one JSON object, so they follow the user from
 * browser to browser. Verso doesn't read them. Each write bumps a version, which is the ETag, so
 * two tabs can't overwrite each other's changes unknowingly.
 * @module
 */
import type { Context } from "../kernel/context.ts";

/** A user's web app settings, and the ETag of this version of them. */
export type WebPreferences = {
    readonly data: Record<string, unknown>;
    readonly etag: string;
};

/** The ETag of `version`. Users with no settings yet have version 0. */
const etagOf = (version: number) => `"${version}"`;

/**
 * The versions an `If-Match` header names, or `"any"` for `*`. Only strong ETags in Verso's form
 * count, so a weak or unquoted one names no version.
 * @see https://www.rfc-editor.org/rfc/rfc9110#section-13.1.1
 */
const versionsIn = (ifMatch: string): readonly number[] | "any" => {
    if (ifMatch.trim() === "*") return "any";

    return ifMatch.split(",")
        .map((tag) => /^"(\d+)"$/.exec(tag.trim())?.[1])
        .filter((version) => version !== undefined)
        .map(Number);
};

/** The web app settings of `accountId`: an empty object until it saves some. */
export const webPreferencesOf = async (
    ctx: Context,
    accountId: string,
): Promise<WebPreferences> => {
    const row = await ctx.db.selectFrom("web_preferences").select(["data", "version"])
        .where("account_id", "=", accountId)
        .executeTakeFirst();

    return row === undefined
        ? { data: {}, etag: etagOf(0) }
        : { data: JSON.parse(row.data), etag: etagOf(row.version) };
};

/**
 * Replaces the web app settings of `accountId` with `data`, if `ifMatch` is missing or names their
 * current version. Each check and write is one statement, so two at once can't both pass. Returns
 * the new ETag, or `undefined` if `ifMatch` names another version.
 */
export const saveWebPreferences = async (
    ctx: Context,
    accountId: string,
    data: Record<string, unknown>,
    ifMatch: string | undefined,
): Promise<string | undefined> => {
    const now = ctx.clock.now();
    const values = {
        account_id: accountId,
        data: JSON.stringify(data),
        version: 1,
        updated_at: now,
    };
    const versions = ifMatch === undefined ? "any" : versionsIn(ifMatch);

    if (versions === "any") {
        const row = await ctx.db.insertInto("web_preferences").values(values)
            .onConflict((conflict) =>
                conflict.column("account_id").doUpdateSet((eb) => ({
                    data: values.data,
                    version: eb("web_preferences.version", "+", 1),
                    updated_at: now,
                }))
            )
            .returning("version")
            .executeTakeFirstOrThrow();

        return etagOf(row.version);
    }

    if (versions.includes(0)) {
        const row = await ctx.db.insertInto("web_preferences").values(values)
            .onConflict((conflict) => conflict.column("account_id").doNothing())
            .returning("version")
            .executeTakeFirst();
        if (row !== undefined) return etagOf(row.version);
    }

    const current = versions.filter((version) => version > 0);
    if (current.length === 0) return undefined;

    const row = await ctx.db.updateTable("web_preferences")
        .set((eb) => ({
            data: values.data,
            version: eb("version", "+", 1),
            updated_at: now,
        }))
        .where("account_id", "=", accountId)
        .where("version", "in", current)
        .returning("version")
        .executeTakeFirst();

    return row === undefined ? undefined : etagOf(row.version);
};
