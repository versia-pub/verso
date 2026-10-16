import type { ClaimTest } from "../kernel/config.ts";
import type { Claims } from "../kernel/identity.ts";

/** Whether a login's claim is the value, or is a list that holds it. */
export const claimContains = (claims: Claims, test: ClaimTest): boolean => {
    const value = claims[test.claim];
    return Array.isArray(value) ? value.includes(test.contains) : value === test.contains;
};
