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
import { accountRichText } from "./0012_account_rich_text.ts";
import { roles } from "./0013_roles.ts";
import { media } from "./0014_media.ts";
import { remoteAccounts } from "./0015_remote_accounts.ts";
import { domainBlocks } from "./0016_domain_blocks.ts";
import { jobGroups } from "./0017_job_groups.ts";
import { instanceReachability } from "./0018_instance_reachability.ts";

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
    "0012_account_rich_text": accountRichText,
    "0013_roles": roles,
    "0014_media": media,
    "0015_remote_accounts": remoteAccounts,
    "0016_domain_blocks": domainBlocks,
    "0017_job_groups": jobGroups,
    "0018_instance_reachability": instanceReachability,
};
