import type { Migration } from "kysely/migration";
import { jobs } from "./0001_jobs.ts";
import { keptJobs } from "./0002_kept_jobs.ts";
import { accounts } from "./0003_accounts.ts";
import { apps } from "./0004_apps.ts";
import { oauthFlows } from "./0005_oauth_flows.ts";
import { accessTokens } from "./0006_access_tokens.ts";
import { flowFormTokens } from "./0007_flow_form_tokens.ts";
import { rateLimits } from "./0008_rate_limits.ts";
import { instances } from "./0009_instances.ts";
import { instanceKeys } from "./0010_instance_keys.ts";
import { accountProfiles } from "./0011_account_profiles.ts";

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
    "0006_access_tokens": accessTokens,
    "0007_flow_form_tokens": flowFormTokens,
    "0008_rate_limits": rateLimits,
    "0009_instances": instances,
    "0010_instance_keys": instanceKeys,
    "0011_account_profiles": accountProfiles,
};
