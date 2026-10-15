import { z } from "zod";

/**
 * Every scope Mastodon defines. As in Mastodon, apps can't register any other.
 * @see https://docs.joinmastodon.org/api/oauth-scopes/
 */
export const scopes = [
    "profile",
    "read",
    "read:accounts",
    "read:blocks",
    "read:bookmarks",
    "read:collections",
    "read:favourites",
    "read:filters",
    "read:follows",
    "read:lists",
    "read:mutes",
    "read:notifications",
    "read:search",
    "read:statuses",
    "write",
    "write:accounts",
    "write:blocks",
    "write:bookmarks",
    "write:collections",
    "write:conversations",
    "write:favourites",
    "write:filters",
    "write:follows",
    "write:lists",
    "write:media",
    "write:mutes",
    "write:notifications",
    "write:reports",
    "write:statuses",
    "follow",
    "push",
    "admin:read",
    "admin:read:accounts",
    "admin:read:canonical_email_blocks",
    "admin:read:domain_allows",
    "admin:read:domain_blocks",
    "admin:read:email_domain_blocks",
    "admin:read:ip_blocks",
    "admin:read:reports",
    "admin:write",
    "admin:write:accounts",
    "admin:write:canonical_email_blocks",
    "admin:write:domain_allows",
    "admin:write:domain_blocks",
    "admin:write:email_domain_blocks",
    "admin:write:ip_blocks",
    "admin:write:reports",
] as const;

export type Scope = typeof scopes[number];

/** A space-separated list of scopes, as clients send it, without repeats. It may be empty. */
export const ScopeList = z.string()
    .transform((text) => [...new Set(text.split(/\s+/).filter((scope) => scope !== ""))])
    .pipe(z.array(z.enum(scopes, { error: "Unknown scope" })));
