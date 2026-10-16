/**
 * `verso admin …`: commands for whoever runs the instance. Each prints its result as one line of
 * JSON, so scripts can read it.
 * @module
 */
import { rotateInstanceKey } from "../instances/keys.ts";
import type { Context } from "../kernel/context.ts";

export type AdminCommand = {
    /** One line for the usage message. */
    readonly summary: string;
    readonly run: (ctx: Context) => Promise<unknown>;
};

/** Every admin command, by the words that name it. */
export const adminCommands: Readonly<Record<string, AdminCommand>> = {
    "keys rotate": {
        summary: "Replace the instance's key pair, and print the new public key",
        run: async (ctx) => ({ public_key: await rotateInstanceKey(ctx) }),
    },
};

/** The command `words` name, such as `["keys", "rotate"]`, if there is one. */
export const findAdminCommand = (words: readonly unknown[]): AdminCommand | undefined =>
    Object.hasOwn(adminCommands, words.join(" ")) ? adminCommands[words.join(" ")] : undefined;

export const adminUsage: string = [
    "usage: verso admin <command> [--config <path>]",
    "",
    ...Object.entries(adminCommands).map(([name, command]) =>
        `  ${name.padEnd(16)}${command.summary}`
    ),
].join("\n");

/** Runs `command` and returns the line of JSON to print. */
export const runAdminCommand = async (ctx: Context, command: AdminCommand): Promise<string> =>
    JSON.stringify(await command.run(ctx));
