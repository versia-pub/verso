/**
 * Instances Verso doesn't federate with: it drops what they send and sends them nothing. Blocking a
 * domain blocks its subdomains too, so a blocked operator can't get around it with new ones.
 * @module
 */
import { forgetEverywhere } from "../federation/caches.ts";
import type { Context } from "../kernel/context.ts";
import {
    deleteDomainBlock,
    type DomainBlock,
    type DomainBlockNotes,
    insertDomainBlock,
    listBlockedDomains,
} from "./domain_block_queries.ts";

/** `domain` and the domains it is under, such as `b.example` and `example` for `a.b.example`. */
const domainAndParents = (domain: string) =>
    domain.split(".").map((_, index, labels) => labels.slice(index).join("."));

/**
 * Blocks a domain, saying why, unless it is already blocked. Returns the block if it wasn't; an
 * existing block keeps its notes. Every process applies it once it commits.
 */
export const blockDomain = async (
    ctx: Context,
    domain: string,
    notes: DomainBlockNotes = {},
): Promise<DomainBlock | undefined> => {
    const inserted = await insertDomainBlock(ctx, domain, notes);
    await forgetEverywhere(ctx);

    return inserted;
};

/**
 * Unblocks a domain blocked with `blockDomain`. Returns whether it was blocked. Every process
 * applies it once it commits.
 */
export const unblockDomain = async (ctx: Context, domain: string): Promise<boolean> => {
    const deleted = await deleteDomainBlock(ctx, domain);
    await forgetEverywhere(ctx);

    return deleted;
};

/** The SHA-256 hash of `domain`, in hex, which lets clients match blocked domains. */
export const domainDigest = async (domain: string): Promise<string> =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(domain)))
        .toHex();

/** Whether config blocks an instance, by its domain or a domain it is under. */
export const blockedByConfig = (configured: readonly string[], domain: string): boolean =>
    domainAndParents(domain.toLowerCase()).some((candidate) => configured.includes(candidate));

/** A blocked domain as the public list shows it, before it is masked. */
export type PublicDomainBlock = {
    readonly domain: string;
    /** Why it was blocked, or empty. */
    readonly reason: string;
    readonly obfuscate: boolean;
};

/**
 * Every blocked domain, with why it was blocked, or an empty reason: the ones config blocks, and
 * the ones admins blocked, by domain.
 */
export const allDomainBlocks = async (
    ctx: Context,
    configured: readonly string[],
): Promise<PublicDomainBlock[]> => {
    const blocks = new Map<string, PublicDomainBlock>(
        configured.map((domain) => [domain, { domain, reason: "", obfuscate: false }]),
    );
    for (const { domain, reason, obfuscate } of await listBlockedDomains(ctx)) {
        blocks.set(domain, { domain, reason, obfuscate });
    }

    return [...blocks.values()].sort((a, b) => a.domain < b.domain ? -1 : 1);
};

/**
 * `domain` with its middle masked by `*`, keeping dots and a quarter of its length at each end, as
 * Mastodon shows obfuscated blocks.
 * @see https://github.com/mastodon/mastodon/blob/v4.7.0/app/models/domain_block.rb
 */
export const obfuscateDomain = (domain: string): string => {
    const visible = Math.floor(domain.length / 4);

    return [...domain].map((character, index) =>
        index > visible && index < domain.length - visible && character !== "." ? "*" : character
    ).join("");
};

/** Whether an instance is blocked, by config or by an admin. */
export type IsBlocked = (ctx: Context, domain: string) => Promise<boolean>;

/**
 * Checks domains against the ones config blocks, and the ones admins blocked, as `blocked` returns
 * them.
 */
export const domainBlocks = (
    configured: readonly string[],
    blocked: (ctx: Context) => Promise<ReadonlySet<string>>,
): IsBlocked =>
async (ctx, domain) => {
    if (blockedByConfig(configured, domain)) return true;

    const names = await blocked(ctx);
    return domainAndParents(domain.toLowerCase()).some((candidate) => names.has(candidate));
};
