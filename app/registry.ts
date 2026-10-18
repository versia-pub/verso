import { userType } from "./accounts/federation.ts";
import { deleteType } from "./federation/delete.ts";
import { createRegistry } from "./federation/registry.ts";

/** The types of entities Verso keeps. Extensions add theirs here. */
const types = [userType];

/** Every Versia entity type Verso knows: the ones it keeps, and Delete, which deletes them. */
export const registry = createRegistry([...types, deleteType(types)]);
