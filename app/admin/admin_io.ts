/**
 * What every `verso admin …` command group shares: how it reaches the instance, how it fails, and
 * how a missing subcommand is rejected.
 * @module
 */
import { ValidationError } from "@cliffy/command";
import type { Config } from "../kernel/config.ts";
import type { Context } from "../kernel/context.ts";

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

/** Rejects a command run without one of its subcommands, as a usage error. */
export const missingCommand = (): never => {
    throw new ValidationError("Missing command");
};
