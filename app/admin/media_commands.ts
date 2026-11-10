/**
 * `verso admin media …`.
 * @module
 */
import { Command } from "@cliffy/command";
import { dayMs } from "../kernel/clock.ts";
import { pruneRemoteMedia } from "../media/pruning.ts";
import { AdminError, type AdminIo, missingCommand } from "./admin_io.ts";

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
            if (days < 1) throw new AdminError("--days must be at least 1");

            const cleared = await io.withContext(
                config,
                (ctx) => pruneRemoteMedia(ctx, new Date(ctx.clock.now().getTime() - days * dayMs)),
            );
            io.print(JSON.stringify({ cleared }));
        })
        .reset();
