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
import { jobClaims } from "./0019_job_claims.ts";
import { usedCodes } from "./0020_used_codes.ts";
import { follows } from "./0021_follows.ts";
import { notes } from "./0022_notes.ts";
import { remoteNotes } from "./0023_remote_notes.ts";
import { noteVersions } from "./0024_note_versions.ts";
import { notesByQuote } from "./0025_notes_by_quote.ts";
import { moreIndexes } from "./0026_more_indexes.ts";
import { likes } from "./0027_likes.ts";
import { remoteLikes } from "./0028_remote_likes.ts";
import { shares } from "./0029_shares.ts";
import { emojis } from "./0030_emojis.ts";
import { localEmojis } from "./0031_local_emojis.ts";
import { reactions } from "./0032_reactions.ts";
import { remoteReactions } from "./0033_remote_reactions.ts";
import { instanceMessaging } from "./0034_instance_messaging.ts";
import { blocks } from "./0035_blocks.ts";
import { mutes } from "./0036_mutes.ts";

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
    "0019_job_claims": jobClaims,
    "0020_used_codes": usedCodes,
    "0021_follows": follows,
    "0022_notes": notes,
    "0023_remote_notes": remoteNotes,
    "0024_note_versions": noteVersions,
    "0025_notes_by_quote": notesByQuote,
    "0026_more_indexes": moreIndexes,
    "0027_likes": likes,
    "0028_remote_likes": remoteLikes,
    "0029_shares": shares,
    "0030_emojis": emojis,
    "0031_local_emojis": localEmojis,
    "0032_reactions": reactions,
    "0033_remote_reactions": remoteReactions,
    "0034_instance_messaging": instanceMessaging,
    "0035_blocks": blocks,
    "0036_mutes": mutes,
};
