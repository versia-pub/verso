import type { Selectable } from "kysely";
import type { Context } from "../kernel/context.ts";
import type { InstanceKeysTable } from "./tables.ts";

/** The newest key pair, which is the current one, if there is one. */
export const newestKeyRow = (
    ctx: Pick<Context, "db">,
): Promise<Pick<Selectable<InstanceKeysTable>, "id" | "public_key" | "private_key"> | undefined> =>
    ctx.db.selectFrom("instance_keys")
        .select(["id", "public_key", "private_key"])
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst();

/** Adds a key pair. */
export const insertKeyRow = async (
    ctx: Pick<Context, "db">,
    row: InstanceKeysTable,
): Promise<void> => {
    await ctx.db.insertInto("instance_keys").values(row).execute();
};

/** Deletes every key pair except `id`. */
export const deleteKeysBut = async (ctx: Pick<Context, "db">, id: string): Promise<void> => {
    await ctx.db.deleteFrom("instance_keys").where("id", "!=", id).execute();
};

/** Whether the instance has a key pair at all. */
export const hasKeyRow = async (ctx: Pick<Context, "db">): Promise<boolean> =>
    await ctx.db.selectFrom("instance_keys").select("id").limit(1).executeTakeFirst() !==
        undefined;
