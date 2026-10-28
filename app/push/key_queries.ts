import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { VapidKeysTable } from "./tables.ts";

/** The key pair, if there is one. */
export const findVapidKeyRow = (
    ctx: Pick<Context, "db">,
): Promise<Pick<Selectable<VapidKeysTable>, "public_key" | "private_key"> | undefined> =>
    ctx.db.selectFrom("vapid_keys").select(["public_key", "private_key"]).executeTakeFirst();

/** Adds the key pair. */
export const insertVapidKeyRow = async (
    ctx: Pick<Context, "db">,
    row: VapidKeysTable,
): Promise<void> => {
    await ctx.db.insertInto("vapid_keys").values(row).execute();
};
