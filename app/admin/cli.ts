/**
 * `verso admin …`: commands for whoever runs the instance. Each prints its result as one line of
 * JSON, so scripts can read it.
 * @module
 */
import { Command, EnumType, ValidationError } from "@cliffy/command";
import { permissions } from "../accounts/permissions.ts";
import { createRole, listRoles } from "../accounts/roles.ts";
import { rotateInstanceKey } from "../instances/keys.ts";
import type { Context } from "../kernel/context.ts";

/** What admin commands need from whoever runs them. */
export type AdminIo = {
    /** Runs `work` with the context of the instance the config file at `path` describes. */
    readonly withContext: <T>(path: string, work: (ctx: Context) => Promise<T>) => Promise<T>;
    /** Prints one line of output. */
    readonly print: (line: string) => void;
};

/** Why a command, used correctly, failed. The caller prints it and exits with 1. */
export class AdminError extends Error {}

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
                    if (name.trim() === "") throw new ValidationError("A role needs a name");

                    const role = await io.withContext(
                        config,
                        (ctx) => createRole(ctx, { name: name.trim(), permissions, priority }),
                    );
                    if (!role) throw new AdminError(`There is already a role named ${name}`);

                    io.print(JSON.stringify(role));
                })
                .command("list", "Print every role, highest priority first.")
                .action(async ({ config }) => {
                    io.print(JSON.stringify(await io.withContext(config, listRoles)));
                }),
        )
        .reset();
