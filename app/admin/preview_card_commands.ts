/**
 * `verso admin preview-cards …`.
 * @module
 */
import { Command } from "@cliffy/command";
import { dayMs } from "../kernel/clock.ts";
import { pruneCards } from "../previews/pruning.ts";
import { type AdminIo, checkDays, missingCommand, runAndPrint } from "./admin_io.ts";

/** The `preview-cards` group of commands. */
export const previewCardsCommand = (io: AdminIo): Command<{ config: string }> =>
    new Command<{ config: string }>()
        .description("Prune the previews of the pages that statuses link to.")
        .action(missingCommand)
        .command(
            "prune",
            "Take the images off cards whose page was fetched more than some days ago, and " +
                "delete those that no status shows, as the `preview_card_days` config option does " +
                "each day.",
        )
        .option("--days <days:integer>", "How long ago the pages were fetched, in days.", {
            default: 180,
        })
        .action(async ({ config, days }) => {
            checkDays(days, 14);

            await runAndPrint(
                io,
                config,
                (ctx) => pruneCards(ctx, new Date(ctx.clock.now().getTime() - days * dayMs)),
            );
        })
        .reset();
