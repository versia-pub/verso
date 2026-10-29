/**
 * Verso's command line: serving, working, migrating and the admin commands.
 * @module
 */
import { Command } from "@cliffy/command";
import denoConfig from "../deno.json" with { type: "json" };
import { adminCommand, AdminError, missingCommand } from "./admin/cli.ts";
import { openDatabase } from "./db/database.ts";
import { type Config, readConfig } from "./kernel/config.ts";
import type { Context } from "./kernel/context.ts";
import { setUpLogging } from "./kernel/logging.ts";
import { contextFor, pubSubFor, run, runMigrations } from "./run.ts";

/** Reads the config, or exits saying what is wrong with it. */
const configOrExit = async (path: string): Promise<Config> => {
    const result = await readConfig(path);
    if (result.ok) return result.config;

    // deno-lint-ignore no-console -- there is no logger before the config is read
    console.error(`Can't load ${path}:\n${result.error}`);
    Deno.exit(1);
};

/** Reads the config at `path` and sets up logging, before any command that needs them. */
const setUp = async (path: string): Promise<Config> => {
    const config = await configOrExit(path);
    await setUpLogging(config.logging.level);
    return config;
};

/** Runs `work` with the config at `path` and its context, for admin commands. */
const withContext = async <T>(
    path: string,
    work: (ctx: Context, config: Config) => Promise<T>,
): Promise<T> => {
    const config = await setUp(path);
    await using db = openDatabase(config.database);
    await using pubsub = pubSubFor(config, db);
    return await work(contextFor(config, db, pubsub).ctx, config);
};

const version = `verso ${denoConfig.version}`;

const cli = new Command()
    .name("verso")
    .version(denoConfig.version)
    .versionOption("-V, --version", "Show Verso's version.", {
        action: () => {
            // deno-lint-ignore no-console -- the version is command output, not a log line
            console.log(version);
            Deno.exit(0);
        },
    })
    .description("A Versia server, with a Mastodon-compatible API.")
    .globalOption("-c, --config <path:string>", "The config file.", { default: "config.toml" })
    .action(missingCommand)
    .command("serve", "Answer HTTP requests, until stopped.")
    .action(async ({ config }) => Deno.exit(await run("serve", await setUp(config))))
    .command(
        "work",
        "Run jobs, until stopped. Each worker runs as many jobs at once as its queues allow, " +
            "including per instance, so more workers send more to each instance at once.",
    )
    .action(async ({ config }) => Deno.exit(await run("work", await setUp(config))))
    .command("all", "Answer HTTP requests and run jobs, until stopped.")
    .action(async ({ config }) => Deno.exit(await run("all", await setUp(config))))
    .command("migrate", "Bring the database up to date, and make the instance's key pair.")
    .action(async ({ config }) => Deno.exit(await runMigrations(await setUp(config))))
    .command(
        "admin",
        adminCommand({
            withContext,
            // deno-lint-ignore no-console -- the result is command output, not a log line
            print: (line) => console.log(line),
        }),
    );

if (import.meta.main) {
    try {
        await cli.parse(Deno.args);
    } catch (error) {
        if (!(error instanceof AdminError)) throw error;

        // deno-lint-ignore no-console -- the failure is command output, not a log line
        console.error(error.message);
        Deno.exit(1);
    }
}
