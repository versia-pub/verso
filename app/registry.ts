import { userType } from "./accounts/federation.ts";
import { deleteType } from "./federation/delete.ts";
import { createRegistry } from "./federation/registry.ts";
import { followCollections, followTypes } from "./graph/federation.ts";
import { likeTypes, noteLikeCollections, userLikeCollections } from "./interactions/federation.ts";
import { noteCollections, noteType } from "./notes/federation.ts";

/** Users, with the collections other modules add. */
const user = {
    ...userType,
    collections: {
        ...userType.collections,
        ...followCollections,
        ...noteCollections,
        ...userLikeCollections,
    },
};

/** Notes, with the collections other modules add. */
const note = {
    ...noteType,
    collections: { ...noteType.collections, ...noteLikeCollections },
};

/** The types of entities Verso keeps. Extensions add theirs here. */
const types = [user, note, ...likeTypes];

/**
 * Every Versia entity type Verso knows: the ones it keeps, Delete, which deletes them, and the
 * transient ones follows are sent as.
 */
export const registry = createRegistry([...types, deleteType(types), ...followTypes]);
