import { userType } from "./accounts/federation.ts";
import { deleteType } from "./federation/delete.ts";
import { createRegistry } from "./federation/registry.ts";
import { followCollections, followTypes } from "./graph/federation.ts";
import { noteCollections, noteType } from "./notes/federation.ts";

/** Users, with the collections other modules add. */
const user = {
    ...userType,
    collections: { ...userType.collections, ...followCollections, ...noteCollections },
};

/** The types of entities Verso keeps. Extensions add theirs here. */
const types = [user, noteType];

/**
 * Every Versia entity type Verso knows: the ones it keeps, Delete, which deletes them, and the
 * transient ones follows are sent as.
 */
export const registry = createRegistry([...types, deleteType(types), ...followTypes]);
