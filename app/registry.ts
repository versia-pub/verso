import { userType } from "./accounts/federation.ts";
import { createRegistry } from "./federation/registry.ts";

/** Every Versia entity type Verso knows. Extensions add theirs here. */
export const registry = createRegistry([userType]);
