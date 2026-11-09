/**
 * `verso admin statuses …`.
 * @module
 */
import { Command } from "@cliffy/command";
import { removeStatus } from "../moderation/statuses.ts";
import { AdminError, type AdminIo, missingCommand } from "./admin_io.ts";

/** The `statuses` group of commands. */
export const statusesCommand = (io: AdminIo): Command<{ config: string }> =>
    new Command<{ config: string }>()
        .description("Remove statuses, local or remote.")
        .action(missingCommand)
        .command("delete <id:string>", "Delete a status or boost, by its id.")
        .action(async ({ config }, id) => {
            const found = await io.withContext(config, (ctx) => removeStatus(ctx, id));
            if (!found) throw new AdminError(`There is no status ${id}`);

            io.print(JSON.stringify({ id, deleted: true }));
        })
        .reset();
