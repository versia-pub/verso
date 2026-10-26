/**
 * Delete, which a remote instance sends when one of its entities is gone, for any type that can be
 * deleted.
 * @see https://versia.pub/entities/delete
 * @module
 */
import { parseReference, v0_6 } from "@versia/protocol";
import { PermanentFailure } from "../jobs/worker.ts";
import type { Context } from "../kernel/context.ts";
import type { EntityType } from "./registry.ts";

/**
 * Deletes for the entities of `types`. A Delete is sent by its author's instance, or by the
 * instance that signed it if it names no author, and only deletes an entity that instance hosts.
 * Anything too large to delete in one transaction is deleted first, by the type's `prepareDelete`.
 */
export const deleteType = (types: readonly EntityType[]): EntityType<v0_6.Delete> => {
    const byName = new Map(types.map((type) => [type.type, type]));

    return {
        type: "Delete",
        schema: v0_6.Delete,
        authority: (entity, origin) =>
            entity.author ? parseReference(entity.author, origin)?.host : origin,
        prepare: async (ctx, entity, sender) => {
            const target = parseReference(entity.deleted, sender.domain);
            if (target?.host !== sender.domain) return;

            await byName.get(entity.deleted_type)?.prepareDelete?.(ctx, target.id, sender);
        },
        receive: async (ctx, entity, sender) => {
            const target = parseReference(entity.deleted, sender.domain);
            if (target?.host !== sender.domain) {
                throw new PermanentFailure(`${sender.domain} may not delete ${entity.deleted}`);
            }

            const deleteRemote = byName.get(entity.deleted_type)?.deleteRemote;
            if (!deleteRemote) {
                throw new PermanentFailure(`A ${entity.deleted_type} can't be deleted`);
            }

            await deleteRemote(ctx, target.id, sender);
        },
    };
};

/** A Delete by the local user `authorId` of their entity `deleted`, of `deletedType`, dated now. */
export const deleteEntity = (
    ctx: Context,
    authorId: string,
    deletedType: string,
    deleted: string,
): v0_6.Delete => ({
    type: "Delete",
    created_at: ctx.clock.now().toISOString(),
    author: authorId,
    deleted_type: deletedType,
    deleted,
});
