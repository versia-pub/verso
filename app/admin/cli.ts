/**
 * `verso admin …`: commands for whoever runs the instance. Each prints its result as one line of
 * JSON, so scripts can read it.
 * @module
 */
import { Command, ValidationError } from "@cliffy/command";
import { rotateInstanceKey } from "../instances/keys.ts";
import type { Context } from "../kernel/context.ts";

/** What admin commands need from whoever runs them. */
export type AdminIo = {
    /** Runs `work` with the context of the instance the config file at `path` describes. */
    readonly withContext: <T>(path: string, work: (ctx: Context) => Promise<T>) => Promise<T>;
    /** Prints one line of output. */
    readonly print: (line: string) => void;
};

/** Refuses a command run without one of its subcommands, as a usage error. */
export const missingCommand = (): never => {
    throw new ValidationError("Missing command");
};

/** The `admin` command, to add to the main one, which has the global `--config` option. */
export const adminCommand = (io: AdminIo): Command<{ config: string }> =>
    new Command<{ config: string }>()
        .description("Manage the instance.")
        .action(missingCommand)
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
        .reset();
