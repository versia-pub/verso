import type { ClaimTest } from "../kernel/config_sections.ts";
import type { Claims } from "../kernel/identity.ts";

/** Whether a login's claim equals the value, or is a list that contains it. */
export const claimContains = (claims: Claims, test: ClaimTest): boolean => {
    const value = claims[test.claim];
    return Array.isArray(value) ? value.includes(test.contains) : value === test.contains;
};
