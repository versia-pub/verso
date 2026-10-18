/**
 * Delete, which another instance sends when one of its entities is gone, for any type that can be
 * deleted.
 * @see https://versia.pub/entities/delete
 * @module
 */
import { parseReference, v0_6 } from "@versia/protocol";
import { PermanentFailure } from "../jobs/worker.ts";
import type { EntityType } from "./registry.ts";

/**
 * Deletes for the entities of `types`. A Delete is sent by its author's instance, or the one that
 * signed it if it names no author, and only deletes an entity that instance hosts.
 */
export const deleteType = (types: readonly EntityType[]): EntityType<v0_6.Delete> => {
    const byName = new Map(types.map((type) => [type.type, type]));

    return {
        type: "Delete",
        schema: v0_6.Delete,
        authority: (entity, origin) =>
            entity.author ? parseReference(entity.author, origin)?.host : origin,
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
