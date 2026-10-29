/**
 * Who can see a status: everyone; everyone but not in public timelines; followers; or mentioned
 * users. Statuses have one, and accounts have one their statuses get by default.
 * @module
 */
export type Visibility = "public" | "unlisted" | "private" | "direct";
