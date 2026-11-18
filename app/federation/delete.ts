/**
 * Delete, which a remote instance sends when one of its entities is gone, for any type that can be
 * deleted.
 * @see https://versia.pub/entities/delete
 * @module
 */
import { v0_7 } from "@versia/protocol";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import type { EntityType, Sender } from "./registry.ts";

/**
 * Deletes for the entities of `types`. A Delete is sent by its author's instance, or by the
 * instance that signed it if it names no author, and only deletes an entity that instance hosts.
 * Anything too large to delete in one transaction is deleted first, by the type's `prepareDelete`.
 * A Delete whose `deleted_type` isn't the type Verso stores the entity as deletes nothing.
 * @see https://versia.pub/entities/delete
 */
export const deleteType = (types: readonly EntityType[]): EntityType<v0_7.Delete> => {
    const byName = new Map(types.map((type) => [type.type, type]));
    const holds = async (
        ctx: Context,
        type: EntityType | undefined,
        id: string,
        sender: Sender,
    ): Promise<boolean> => await type?.hasRemote?.(ctx, id, sender) ?? false;

    return {
        type: "Delete",
        schema: v0_7.Delete,
        authority: (entity, origin) =>
            entity.author ? v0_7.parseReference(entity.author)?.host : origin,
        prepare: async (ctx, entity, sender) => {
            const target = v0_7.parseReference(entity.deleted);
            if (target?.host !== sender.domain) return;

            const type = byName.get(entity.deleted_type);
            // A mismatched Delete is dropped in `receive`, so it mustn't delete anything here.
            if (await holds(ctx, type, target.id, sender)) {
                await type?.prepareDelete?.(ctx, target.id, sender);
            }
        },
        receive: async (ctx, entity, sender) => {
            const target = v0_7.parseReference(entity.deleted);
            if (target?.host !== sender.domain) {
                throw new PermanentFailure(`${sender.domain} may not delete ${entity.deleted}`);
            }

            const type = byName.get(entity.deleted_type);
            if (!type?.deleteRemote) {
                throw new PermanentFailure(`A ${entity.deleted_type} can't be deleted`);
            }

            if (await holds(ctx, type, target.id, sender)) {
                await type.deleteRemote(ctx, target.id, sender);
                return;
            }

            // Ids are unique per instance, so another type holding it means it was named wrongly.
            for (const other of types) {
                if (
                    other !== type && other.deleteRemote &&
                    await holds(ctx, other, target.id, sender)
                ) {
                    throw new PermanentFailure(
                        `${entity.deleted} is a ${other.type}, not a ${entity.deleted_type}`,
                    );
                }
            }
        },
    };
};

/** A Delete by the local user `authorId` of their entity `deleted`, of `deletedType`, dated now. */
export const deleteEntity = (
    ctx: Context,
    authorId: string,
    deletedType: string,
    deleted: string,
): v0_7.Delete => ({
    type: "Delete",
    created_at: ctx.clock.now().toISOString(),
    author: v0_7.formatReference({ host: ctx.urls.domain, id: authorId }),
    deleted_type: deletedType,
    deleted: v0_7.formatReference({ host: ctx.urls.domain, id: deleted }),
});
