/**
 * `verso admin …`: commands for whoever runs the instance. Each prints its result as one line of
 * JSON, so scripts can read it.
 * @module
 */
import { type ArgumentValue, Command, EnumType, ValidationError } from "@cliffy/command";
import { canonicalizeDomain } from "@versia/protocol";
import { permissions } from "../kernel/permissions.ts";
import { findLocalAccount } from "../accounts/account_queries.ts";
import {
    announcementForAdmin,
    type AnnouncementResult,
    announcementsForAdmin,
    changeAnnouncement,
    createAnnouncement,
    publishAnnouncement,
    removeAnnouncement,
    unpublishAnnouncement,
} from "../announcements/announcements.ts";
import { createRole, findRole, listRoles } from "../accounts/role_queries.ts";
import { grantRoleTo, revokeRoleFrom, RoleName } from "../accounts/roles.ts";
import { rotateInstanceKey } from "../instances/keys.ts";
import type { Config } from "../kernel/config.ts";
import type { Context } from "../kernel/context.ts";
import { blockDomain, blockedByConfig, unblockDomain } from "../moderation/domain_blocks.ts";
import { listBlockedDomains } from "../moderation/domain_block_queries.ts";
import { reportsForAdmin, resolve } from "../reports/reports.ts";

/** What admin commands need from whoever runs them. */
export type AdminIo = {
    /** Runs `work` with the context of the instance described by the config file at `path`. */
    readonly withContext: <T>(
        path: string,
        work: (ctx: Context, config: Config) => Promise<T>,
    ) => Promise<T>;
    /** Prints one line of output. */
    readonly print: (line: string) => void;
};

/** Why a command, used correctly, failed. The caller prints it and exits with 1. */
export class AdminError extends Error {}

/** A local account and a role, both by name, or an error saying which one doesn't exist. */
const accountAndRole = async (ctx: Context, username: string, roleName: string) => {
    const account = await findLocalAccount(ctx, username);
    if (!account) throw new AdminError(`There is no local account named ${username}`);

    const role = await findRole(ctx, roleName);
    if (!role) throw new AdminError(`There is no role named ${roleName}`);

    return { account, role };
};

/** A domain as signatures name it, or a usage error. */
const domainArgument = (domain: string) => {
    const canonical = canonicalizeDomain(domain);
    if (canonical === undefined) throw new ValidationError(`${domain} isn't a domain name`);
    return canonical;
};

/** A time, as ISO 8601 writes it, such as `2026-11-01T18:00:00Z`, or `none` for none. */
const timeArgument = ({ label, name, value }: ArgumentValue): Date | null => {
    if (value === "none") return null;

    const time = /^\d{4}-\d{2}-\d{2}(T|$)/.test(value) ? new Date(value) : undefined;
    if (time === undefined || Number.isNaN(time.getTime())) {
        throw new ValidationError(`${label} "${name}" must be a time, such as 2026-11-01T18:00Z`);
    }
    return time;
};

/** The announcement an admin command changed, printed, or an error saying why it wasn't. */
const announcementOutcome = (id: string, result: AnnouncementResult) => {
    if (result === "missing") throw new AdminError(`There is no announcement ${id}`);
    if ("invalid" in result) throw new AdminError(result.invalid);

    return JSON.stringify(announcementForAdmin(result));
};

/** Rejects a command run without one of its subcommands, as a usage error. */
export const missingCommand = (): never => {
    throw new ValidationError("Missing command");
};

/** The `admin` command, to add to the main one, which has the global `--config` option. */
export const adminCommand = (io: AdminIo): Command<{ config: string }> =>
    new Command<{ config: string }>()
        .description("Manage the instance.")
        .action(missingCommand)
        .command(
            "announcements",
            new Command<{ config: string }>()
                .description(
                    "Make announcements to local users, which their apps show. Times are ISO 8601, " +
                        "such as 2026-11-01T18:00Z.",
                )
                .globalType("time", timeArgument)
                .action(missingCommand)
                .command("list", "Print every announcement, published or not, the first first.")
                .action(async ({ config }) => {
                    io.print(JSON.stringify(await io.withContext(config, announcementsForAdmin)));
                })
                .command(
                    "create <text:string>",
                    "Make an announcement, in plain text, published at once unless scheduled.",
                )
                .option("--starts-at <time:time>", "When the event it announces starts.")
                .option(
                    "--ends-at <time:time>",
                    "When it ends, and the announcement is taken down.",
                )
                .option("--all-day", "Whether the event lasts whole days.")
                .option("--scheduled-at <time:time>", "When to publish it.")
                .action(async ({ config, startsAt, endsAt, allDay, scheduledAt }, text) => {
                    const result = await io.withContext(config, (ctx) =>
                        createAnnouncement(ctx, {
                            text,
                            startsAt: startsAt ?? null,
                            endsAt: endsAt ?? null,
                            allDay: allDay === true,
                            scheduledAt: scheduledAt ?? null,
                        }));
                    if ("invalid" in result) throw new AdminError(result.invalid);

                    io.print(JSON.stringify(announcementForAdmin(result)));
                })
                .command(
                    "update <id:string>",
                    "Change an announcement, leaving out what isn't given. A time of none removes it.",
                )
                .option("--text <text:string>", "What it says, in plain text.")
                .option("--starts-at <time:time>", "When the event it announces starts.")
                .option(
                    "--ends-at <time:time>",
                    "When it ends, and the announcement is taken down.",
                )
                .option("--all-day [all-day:boolean]", "Whether the event lasts whole days.")
                .option("--scheduled-at <time:time>", "When to publish it, if it isn't yet.")
                .action(async ({ config, text, startsAt, endsAt, allDay, scheduledAt }, id) => {
                    const result = await io.withContext(
                        config,
                        (ctx) =>
                            changeAnnouncement(ctx, id, {
                                text,
                                startsAt,
                                endsAt,
                                allDay,
                                scheduledAt,
                            }),
                    );
                    io.print(announcementOutcome(id, result));
                })
                .command("publish <id:string>", "Publish an announcement now.")
                .action(async ({ config }, id) => {
                    const result = await io.withContext(
                        config,
                        (ctx) => publishAnnouncement(ctx, id),
                    );
                    io.print(announcementOutcome(id, result));
                })
                .command("unpublish <id:string>", "Take an announcement down, until published.")
                .action(async ({ config }, id) => {
                    const result = await io.withContext(
                        config,
                        (ctx) => unpublishAnnouncement(ctx, id),
                    );
                    io.print(announcementOutcome(id, result));
                })
                .command("delete <id:string>", "Delete an announcement.")
                .action(async ({ config }, id) => {
                    const found = await io.withContext(
                        config,
                        (ctx) => removeAnnouncement(ctx, id),
                    );
                    if (!found) throw new AdminError(`There is no announcement ${id}`);

                    io.print(JSON.stringify({ id, deleted: true }));
                }),
        )
        .command(
            "domains",
            new Command<{ config: string }>()
                .description(
                    "Manage the instances Verso doesn't federate with, with their subdomains. " +
                        "Instances blocked in the config file can only be changed there.",
                )
                .action(missingCommand)
                .command("block <domain:string>", "Block an instance.")
                .option("-r, --reason <reason:string>", "Why the instance is blocked.", {
                    default: "",
                })
                .action(async ({ config, reason }, domain) => {
                    const name = domainArgument(domain);
                    const result = await io.withContext(config, async (ctx, settings) => ({
                        domain: name,
                        changed: await blockDomain(ctx, name, reason),
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
                        ...(await listBlockedDomains(ctx)).map((block) => ({
                            ...block,
                            source: "admin",
                        })),
                    ]);
                    io.print(JSON.stringify(blocks));
                }),
        )
        .command(
            "keys",
            new Command<{ config: string }>()
                .description("Manage the instance's key pair.")
                .action(missingCommand)
                .command("rotate", "Replace the instance's key pair, and print the new public key.")
                .action(async ({ config }) => {
                    const publicKey = await io.withContext(config, rotateInstanceKey);
                    io.print(JSON.stringify({ public_key: publicKey }));
                }),
        )
        .command(
            "reports",
            new Command<{ config: string }>()
                .description("Deal with reports of accounts, which local users file.")
                .action(missingCommand)
                .command("list", "Print the reports no one has dealt with, the first first.")
                .option("-a, --all", "Print every report, including those dealt with.")
                .action(async ({ config, all }) => {
                    const reports = await io.withContext(
                        config,
                        (ctx) => reportsForAdmin(ctx, all === true),
                    );
                    io.print(JSON.stringify(reports));
                })
                .command("resolve <id:string>", "Mark a report as dealt with.")
                .action(async ({ config }, id) => {
                    const found = await io.withContext(config, (ctx) => resolve(ctx, id));
                    if (!found) throw new AdminError(`There is no report ${id}`);

                    io.print(JSON.stringify({ id, resolved: true }));
                }),
        )
        .command(
            "roles",
            new Command<{ config: string }>()
                .description("Manage roles, which give accounts permissions.")
                .action(missingCommand)
                .command("create <name:string>", "Create a role, and print it.")
                .type("permission", new EnumType(permissions))
                .option("-p, --permissions <permissions:permission[]>", "What it allows.", {
                    default: [],
                })
                .option("--priority <priority:integer>", "Higher roles manage lower ones.", {
                    default: 0,
                })
                .action(async ({ config, permissions, priority }, name) => {
                    // The same rules as the API's, so a role created here can be changed there.
                    const checked = RoleName.safeParse(name);
                    if (!checked.success) {
                        throw new ValidationError(
                            checked.error.issues[0]?.message ?? "Invalid name",
                        );
                    }

                    const role = await io.withContext(
                        config,
                        (ctx) => createRole(ctx, { name: checked.data, permissions, priority }),
                    );
                    if (!role) throw new AdminError(`There is already a role named ${name}`);

                    io.print(JSON.stringify(role));
                })
                .command("list", "Print every role, highest priority first.")
                .action(async ({ config }) => {
                    io.print(JSON.stringify(await io.withContext(config, listRoles)));
                }),
        )
        .command(
            "users",
            new Command<{ config: string }>()
                .description("Manage local accounts.")
                .action(missingCommand)
                .command("grant-role <username:string> <role:string>", "Give an account a role.")
                .action(async ({ config }, username, roleName) => {
                    const result = await io.withContext(config, async (ctx) => {
                        const { account, role } = await accountAndRole(ctx, username, roleName);
                        const changed = await grantRoleTo(ctx, account.id, role.id);
                        return { username: account.username, role: role.name, changed };
                    });
                    io.print(JSON.stringify(result));
                })
                .command(
                    "revoke-role <username:string> <role:string>",
                    "Take away a role an admin gave an account.",
                )
                .action(async ({ config }, username, roleName) => {
                    const result = await io.withContext(config, async (ctx) => {
                        const { account, role } = await accountAndRole(ctx, username, roleName);
                        const changed = await revokeRoleFrom(ctx, account.id, role.id);
                        return { username: account.username, role: role.name, changed };
                    });
                    io.print(JSON.stringify(result));
                }),
        )
        .reset();
