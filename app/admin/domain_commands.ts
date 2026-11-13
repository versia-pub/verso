/**
 * `verso admin domains …`.
 * @module
 */
import { Command, ValidationError } from "@cliffy/command";
import { canonicalizeDomain } from "@versia/protocol";
import { deliverQueue } from "../federation/deliver.ts";
import { findInstanceId } from "../instances/instance_queries.ts";
import { recordReached } from "../instances/reachability.ts";
import { resumeGroup } from "../jobs/job_pause_queries.ts";
import { listBlockedDomains } from "../moderation/domain_block_queries.ts";
import { blockDomain, blockedByConfig, unblockDomain } from "../moderation/domain_blocks.ts";
import { AdminError, type AdminIo, missingCommand } from "./admin_io.ts";

/** A domain as signatures name it, or a usage error. */
const domainArgument = (domain: string) => {
    const canonical = canonicalizeDomain(domain);
    if (canonical === undefined) throw new ValidationError(`${domain} isn't a domain name`);

    return canonical;
};

/** The `domains` group of commands. */
export const domainsCommand = (io: AdminIo): Command<{ config: string }> =>
    new Command<{ config: string }>()
        .description(
            "Manage the instances Verso doesn't federate with, with their subdomains, and " +
                "deliveries waiting for an instance. Instances blocked in the config file can " +
                "only be changed there.",
        )
        .action(missingCommand)
        .command("block <domain:string>", "Block an instance.")
        .option("-r, --reason <reason:string>", "Why the instance is blocked.", { default: "" })
        .action(async ({ config, reason }, domain) => {
            const name = domainArgument(domain);
            const result = await io.withContext(config, async (ctx, settings) => ({
                domain: name,
                changed: await blockDomain(ctx, name, { reason }) !== undefined,
                by_config: blockedByConfig(settings.federation.blocked_domains, name),
            }));
            io.print(JSON.stringify(result));
        })
        .command("unblock <domain:string>", "Unblock an instance.")
        .action(async ({ config }, domain) => {
            const name = domainArgument(domain);
            const result = await io.withContext(config, async (ctx, settings) => ({
                domain: name,
                changed: await unblockDomain(ctx, name),
                // Still blocked, until it is removed from the config file.
                by_config: blockedByConfig(settings.federation.blocked_domains, name),
            }));
            io.print(JSON.stringify(result));
        })
        .command("list", "Print every blocked domain: the config file's, then the rest.")
        .action(async ({ config }) => {
            const blocks = await io.withContext(config, async (ctx, settings) => [
                ...settings.federation.blocked_domains.map((domain) => ({
                    domain,
                    source: "config",
                })),
                ...(await listBlockedDomains(ctx)).map((block) => ({ ...block, source: "admin" })),
            ]);
            io.print(JSON.stringify(blocks));
        })
        .command(
            "unpark <domain:string>",
            "Send the deliveries waiting for an instance now: those left alone after it failed " +
                "too often, or because it asked to wait.",
        )
        .action(async ({ config }, domain) => {
            const name = domainArgument(domain);
            const result = await io.withContext(config, (ctx) =>
                ctx.transaction(async (tx) => {
                    if (!await findInstanceId(tx, name)) {
                        throw new AdminError(`${name} isn't an instance Verso knows`);
                    }

                    const wasFailing = await recordReached(tx, name);
                    await resumeGroup(tx, deliverQueue, name);

                    return { domain: name, was_failing: wasFailing };
                }));
            io.print(JSON.stringify(result));
        })
        .reset();
