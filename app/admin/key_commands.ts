/**
 * `verso admin keys …`.
 * @module
 */
import { Command } from "@cliffy/command";
import { rotateInstanceKey } from "../instances/keys.ts";
import { type AdminIo, missingCommand } from "./admin_io.ts";

/** The `keys` group of commands. */
export const keysCommand = (io: AdminIo): Command<{ config: string }> =>
    new Command<{ config: string }>()
        .description("Manage the instance's key pair.")
        .action(missingCommand)
        .command("rotate", "Replace the instance's key pair, and print the new public key.")
        .action(async ({ config }) => {
            const publicKey = await io.withContext(config, rotateInstanceKey);
            io.print(JSON.stringify({ public_key: publicKey }));
        })
        .reset();
