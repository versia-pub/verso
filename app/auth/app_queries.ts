import type { Context } from "../kernel/context.ts";
import type { AppsTable } from "./tables.ts";

/** An app by the client id it sends, if it is registered. */
export const findAppByClientId = async (
    ctx: Pick<Context, "db">,
    clientId: string | undefined,
): Promise<AppsTable | undefined> =>
    clientId === undefined
        ? undefined
        : await ctx.db.selectFrom("apps").selectAll().where("client_id", "=", clientId)
            .executeTakeFirst();

/** An app by its id, which must exist, as it does for a viewer's token. */
export const getApp = (ctx: Context, id: string): Promise<AppsTable> =>
    ctx.db.selectFrom("apps").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

/** Adds a registered app. */
export const insertApp = async (ctx: Pick<Context, "db">, app: AppsTable): Promise<void> => {
    await ctx.db.insertInto("apps").values(app).execute();
};

/** Changes a registered app. */
export const updateApp = async (
    ctx: Pick<Context, "db">,
    id: string,
    changes: Partial<Omit<AppsTable, "id" | "client_id" | "created_at">>,
): Promise<void> => {
    await ctx.db.updateTable("apps").set(changes).where("id", "=", id).execute();
};
