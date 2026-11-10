/**
 * `verso admin …`: commands for whoever runs the instance. Each prints its result as one line of
 * JSON, so scripts can read it. A file per group of commands composes into the one command here.
 * @module
 */
import { Command } from "@cliffy/command";
import { accountsCommand } from "./account_commands.ts";
import { announcementsCommand } from "./announcement_commands.ts";
import { type AdminIo, missingCommand } from "./admin_io.ts";
import { backUpSqlite } from "./backup_commands.ts";
import { domainsCommand } from "./domain_commands.ts";
import { jobsCommand } from "./job_commands.ts";
import { keysCommand } from "./key_commands.ts";
import { mediaCommand } from "./media_commands.ts";
import { previewCardsCommand } from "./preview_card_commands.ts";
import { reportsCommand } from "./report_commands.ts";
import { rolesCommand } from "./role_commands.ts";
import { statusesCommand } from "./status_commands.ts";
import { trendsCommand } from "./trend_commands.ts";
import { usersCommand } from "./user_commands.ts";

export { AdminError, type AdminIo, missingCommand } from "./admin_io.ts";

/** The `admin` command, to add to the main one, which has the global `--config` option. */
export const adminCommand = (io: AdminIo): Command<{ config: string }> =>
    new Command<{ config: string }>()
        .description("Manage the instance.")
        .action(missingCommand)
        .command("accounts", accountsCommand(io))
        .command("announcements", announcementsCommand(io))
        .command(
            "backup <path:string>",
            "Copy the SQLite database to a new file while Verso runs. On PostgreSQL, use pg_dump.",
        )
        .action(async ({ config }, path) => {
            const bytes = await io.withContext(
                config,
                (_ctx, { database }) => backUpSqlite(database, path),
            );
            io.print(JSON.stringify({ path, bytes }));
        })
        .command("trends", trendsCommand(io))
        .command("domains", domainsCommand(io))
        .command("jobs", jobsCommand(io))
        .command("keys", keysCommand(io))
        .command("media", mediaCommand(io))
        .command("preview-cards", previewCardsCommand(io))
        .command("reports", reportsCommand(io))
        .command("roles", rolesCommand(io))
        .command("statuses", statusesCommand(io))
        .command("users", usersCommand(io))
        .reset();
