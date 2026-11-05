/**
 * `verso admin reports …`.
 * @module
 */
import { Command } from "@cliffy/command";
import { reportsForAdmin, resolve } from "../reports/reports.ts";
import { AdminError, type AdminIo, missingCommand } from "./admin_io.ts";

/** The `reports` group of commands. */
export const reportsCommand = (io: AdminIo): Command<{ config: string }> =>
    new Command<{ config: string }>()
        .description("Deal with reports of accounts, which local users file.")
        .action(missingCommand)
        .command("list", "Print the reports no one has dealt with, the first first.")
        .option("-a, --all", "Print every report, including those dealt with.")
        .action(async ({ config, all }) => {
            const reports = await io.withContext(
                config,
                (ctx) => reportsForAdmin(ctx, all === true),
            );
            io.print(JSON.stringify(reports));
        })
        .command("resolve <id:string>", "Mark a report as dealt with.")
        .action(async ({ config }, id) => {
            const found = await io.withContext(config, (ctx) => resolve(ctx, id));
            if (!found) throw new AdminError(`There is no report ${id}`);

            io.print(JSON.stringify({ id, resolved: true }));
        })
        .reset();
