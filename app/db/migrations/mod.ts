import type { Migration } from "kysely/migration";
import { jobs } from "./0001_jobs.ts";
import { keptJobs } from "./0002_kept_jobs.ts";
import { accounts } from "./0003_accounts.ts";
import { apps } from "./0004_apps.ts";
import { oauthFlows } from "./0005_oauth_flows.ts";

/**
 * Every migration, by name. Names start with a four-digit number, since they run in name order.
 * A migration never changes once released; fix mistakes in a new one.
 */
export const migrations: Record<string, Migration> = {
    "0001_jobs": jobs,
    "0002_kept_jobs": keptJobs,
    "0003_accounts": accounts,
    "0004_apps": apps,
    "0005_oauth_flows": oauthFlows,
};
