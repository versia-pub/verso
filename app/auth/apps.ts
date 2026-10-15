import type { Context } from "../kernel/context.ts";
import type { Scope } from "./scopes.ts";
import { hashToken, randomToken } from "./secrets.ts";
import type { AppsTable } from "./tables.ts";

export type AppRegistration = {
    readonly name: string;
    readonly website: string | null;
    readonly redirectUris: string[];
    readonly scopes: Scope[];
};

/** Registers a client app. The secret is returned here and never again. */
export const registerApp = async (
    ctx: Context,
    registration: AppRegistration,
): Promise<{ app: AppsTable; clientSecret: string }> => {
    const clientSecret = randomToken();

    const app: AppsTable = {
        id: ctx.ids(),
        name: registration.name,
        website: registration.website,
        redirect_uris: registration.redirectUris,
        scopes: registration.scopes,
        client_id: randomToken(),
        client_secret_hash: await hashToken(clientSecret),
        created_at: ctx.clock.now(),
    };

    await ctx.db.insertInto("apps").values(app).execute();

    return { app, clientSecret };
};

/** An app by its id, which must exist, as it does for a viewer's token. */
export const getApp = (ctx: Context, id: string): Promise<AppsTable> =>
    ctx.db.selectFrom("apps").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
