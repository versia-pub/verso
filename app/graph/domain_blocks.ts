/**
 * Domain blocks: an account blocking every account on a domain, and on its subdomains, as blocking
 * each of them would. As with blocks, and unlike on Mastodon, it is the blocker's alone: it ends no
 * follows, stops none, and nothing about it is sent to remote instances.
 * @see https://docs.joinmastodon.org/methods/domain_blocks/
 * @module
 */
import type { Context } from "../kernel/context.ts";
import { deleteDomainBlock, insertDomainBlock } from "./domain_block_queries.ts";

/** Has `accountId` block `domain`, a canonical domain name. */
export const blockDomainFor = (ctx: Context, accountId: string, domain: string): Promise<void> =>
    insertDomainBlock(ctx, accountId, domain);

/** Has `accountId` unblock `domain`. Returns whether it blocked it. */
export const unblockDomainFor = (
    ctx: Context,
    accountId: string,
    domain: string,
): Promise<boolean> => deleteDomainBlock(ctx, accountId, domain);
