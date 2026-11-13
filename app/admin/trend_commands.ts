/**
 * `verso admin trends …`.
 * @module
 */
import { Command } from "@cliffy/command";
import {
    decideAccount,
    decideDomain,
    decideLink,
    decideTag,
    trendsForAdmin,
} from "../trends/review.ts";
import { AdminError, type AdminIo, missingCommand, runAndPrint } from "./admin_io.ts";

/** Lets a hashtag trend or not, and prints the decision, or fails if there is no such hashtag. */
const decideTrendingTag = async (io: AdminIo, config: string, name: string, trendable: boolean) => {
    const tag = name.replace(/^#/, "").toLowerCase();
    if (!await io.withContext(config, (ctx) => decideTag(ctx, tag, trendable))) {
        throw new AdminError(`No status has used the hashtag ${tag}`);
    }

    io.print(JSON.stringify({ tag, trendable }));
};

/** Lets an account's statuses trend or not, and prints the decision, or fails if there is none. */
const decideTrendingAccount = async (
    io: AdminIo,
    config: string,
    account: string,
    trendable: boolean,
) => {
    const id = await io.withContext(config, (ctx) => decideAccount(ctx, account, trendable));
    if (id === undefined) throw new AdminError(`There is no account named ${account}`);

    io.print(JSON.stringify({ id, trendable }));
};

/** Lets a link trend or not, and prints the decision, or fails if Verso has no such card. */
const decideTrendingLink = async (io: AdminIo, config: string, url: string, trendable: boolean) => {
    if (!await io.withContext(config, (ctx) => decideLink(ctx, url, trendable))) {
        throw new AdminError(`Verso has no preview card at ${url}`);
    }

    io.print(JSON.stringify({ url, trendable }));
};

/** Lets a website's links trend or not, and prints the decision, or fails if it isn't a domain. */
const decideTrendingDomain = async (
    io: AdminIo,
    config: string,
    domain: string,
    trendable: boolean,
) => {
    const name = await io.withContext(config, (ctx) => decideDomain(ctx, domain, trendable));
    if (name === undefined) throw new AdminError(`${domain} is not a domain name`);

    io.print(JSON.stringify({ domain: name, trendable }));
};

/** The `trends` group of commands. */
export const trendsCommand = (io: AdminIo): Command<{ config: string }> =>
    new Command<{ config: string }>()
        .description(
            "Approve or reject the hashtags, accounts and links that trend. They wait for " +
                "approval unless `trendable_by_default` is set in the config.",
        )
        .action(missingCommand)
        .command(
            "list",
            "Print what is trending, with whether it is shown: approved, rejected or pending.",
        )
        .action(async ({ config }) => {
            await runAndPrint(
                io,
                config,
                (ctx, settings) => trendsForAdmin(ctx, settings.instance.trendable_by_default),
            );
        })
        .command("approve-tag <name:string>", "Let a hashtag trend.")
        .action(async ({ config }, name) => {
            await decideTrendingTag(io, config, name, true);
        })
        .command("reject-tag <name:string>", "Stop a hashtag from trending.")
        .action(async ({ config }, name) => {
            await decideTrendingTag(io, config, name, false);
        })
        .command(
            "approve-account <account:string>",
            "Let an account's statuses trend. A local account is its username, a remote " +
                "one username@domain.",
        )
        .action(async ({ config }, account) => {
            await decideTrendingAccount(io, config, account, true);
        })
        .command("reject-account <account:string>", "Stop an account's statuses trending.")
        .action(async ({ config }, account) => {
            await decideTrendingAccount(io, config, account, false);
        })
        .command("approve-link <url:string>", "Let a link trend. Give its url as `list` prints it.")
        .action(async ({ config }, url) => {
            await decideTrendingLink(io, config, url, true);
        })
        .command("reject-link <url:string>", "Stop a link from trending.")
        .action(async ({ config }, url) => {
            await decideTrendingLink(io, config, url, false);
        })
        .command(
            "approve-domain <domain:string>",
            "Let the links to a website and its subdomains trend, unless a link was decided.",
        )
        .action(async ({ config }, domain) => {
            await decideTrendingDomain(io, config, domain, true);
        })
        .command("reject-domain <domain:string>", "Stop a website's links from trending.")
        .action(async ({ config }, domain) => {
            await decideTrendingDomain(io, config, domain, false);
        })
        .reset();
