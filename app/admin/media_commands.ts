/**
 * `verso admin media …`.
 * @module
 */
import { Command } from "@cliffy/command";
import { dayMs } from "../kernel/clock.ts";
import { pruneRemoteMedia } from "../media/pruning.ts";
import { type AdminIo, checkDays, missingCommand, runAndPrint } from "./admin_io.ts";

/** The `media` group of commands. */
export const mediaCommand = (io: AdminIo): Command<{ config: string }> =>
    new Command<{ config: string }>()
        .description("Prune the files cached for media from other instances.")
        .action(missingCommand)
        .command(
            "prune",
            "Remove the files cached for remote statuses' attachments more than some days ago, as " +
                "the `remote_media_days` config option does each day. They are fetched again if " +
                "anyone asks for them.",
        )
        .option("--days <days:integer>", "How long ago the files were cached, in days.", {
            default: 7,
        })
        .action(async ({ config, days }) => {
            checkDays(days);

            await runAndPrint(io, config, async (ctx) => ({
                cleared: await pruneRemoteMedia(
                    ctx,
                    new Date(ctx.clock.now().getTime() - days * dayMs),
                ),
            }));
        })
        .reset();
