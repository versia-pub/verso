/**
 * `verso admin statuses …`.
 * @module
 */
import { Command } from "@cliffy/command";
import { dayMs } from "../kernel/clock.ts";
import { removeStatus } from "../moderation/statuses.ts";
import { pruneRemoteNotes } from "../notes/pruning.ts";
import { AdminError, type AdminIo, checkDays, missingCommand, runAndPrint } from "./admin_io.ts";

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
        .reset()
        .command(
            "prune",
            "Delete statuses from other instances older than some days, unless something here " +
                "needs them, as the `remote_status_days` config option does each day.",
        )
        .option("--days <days:integer>", "How old the statuses are, in days.", { default: 90 })
        .option("--clean-followed", "Also delete those by accounts local users follow.")
        .action(async ({ config, days, cleanFollowed }) => {
            checkDays(days);

            await runAndPrint(io, config, async (ctx) => ({
                deleted: await pruneRemoteNotes(ctx, {
                    before: new Date(ctx.clock.now().getTime() - days * dayMs),
                    keepFollowed: cleanFollowed !== true,
                }),
            }));
        })
        .reset();
