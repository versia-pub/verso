import type { Migration } from "kysely/migration";

/**
 * Every migration, by name. Names start with a four-digit number, since they run in name order.
 * A migration never changes once released; fix mistakes in a new one.
 */
export const migrations: Record<string, Migration> = {};
