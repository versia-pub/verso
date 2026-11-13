/**
 * `verso admin announcements …`.
 * @module
 */
import { type ArgumentValue, Command, ValidationError } from "@cliffy/command";
import {
    announcementForAdmin,
    type AnnouncementResult,
    announcementsForAdmin,
    changeAnnouncement,
    createAnnouncement,
    publishAnnouncement,
    removeAnnouncement,
    unpublishAnnouncement,
} from "../announcements/announcements.ts";
import { AdminError, type AdminIo, missingCommand } from "./admin_io.ts";

/** A time in ISO 8601, like `2026-11-01T18:00:00Z`, or `none` for none. */
const timeArgument = ({ label, name, value }: ArgumentValue): Date | null => {
    if (value === "none") return null;

    const time = /^\d{4}-\d{2}-\d{2}(T|$)/.test(value) ? new Date(value) : undefined;
    if (time === undefined || Number.isNaN(time.getTime())) {
        throw new ValidationError(`${label} "${name}" must be a time, such as 2026-11-01T18:00Z`);
    }
    return time;
};

/** The announcement an admin command changed, printed, or an error saying why it wasn't. */
const announcementOutcome = (id: string, result: AnnouncementResult) => {
    if (result === "missing") throw new AdminError(`There is no announcement ${id}`);
    if ("invalid" in result) throw new AdminError(result.invalid);

    return JSON.stringify(announcementForAdmin(result));
};

/** The `announcements` group of commands. */
export const announcementsCommand = (io: AdminIo): Command<{ config: string }> =>
    new Command<{ config: string }>()
        .description(
            "Make announcements to local users, which their apps show. Times are ISO 8601, " +
                "such as 2026-11-01T18:00Z.",
        )
        .globalType("time", timeArgument)
        .action(missingCommand)
        .command("list", "Print every announcement, published or not, the first first.")
        .action(async ({ config }) => {
            io.print(JSON.stringify(await io.withContext(config, announcementsForAdmin)));
        })
        .command(
            "create <text:string>",
            "Make an announcement, in plain text, published at once unless scheduled.",
        )
        .option("--starts-at <time:time>", "When the event it announces starts.")
        .option("--ends-at <time:time>", "When it ends, and the announcement is taken down.")
        .option("--all-day", "Whether the event lasts whole days.")
        .option("--scheduled-at <time:time>", "When to publish it.")
        .action(async ({ config, startsAt, endsAt, allDay, scheduledAt }, text) => {
            const result = await io.withContext(config, (ctx) =>
                createAnnouncement(ctx, {
                    text,
                    startsAt: startsAt ?? null,
                    endsAt: endsAt ?? null,
                    allDay: allDay === true,
                    scheduledAt: scheduledAt ?? null,
                }));
            if ("invalid" in result) throw new AdminError(result.invalid);

            io.print(JSON.stringify(announcementForAdmin(result)));
        })
        .command(
            "update <id:string>",
            "Change an announcement, leaving out what isn't given. A time of none removes it.",
        )
        .option("--text <text:string>", "What it says, in plain text.")
        .option("--starts-at <time:time>", "When the event it announces starts.")
        .option("--ends-at <time:time>", "When it ends, and the announcement is taken down.")
        .option("--all-day [all-day:boolean]", "Whether the event lasts whole days.")
        .option("--scheduled-at <time:time>", "When to publish it, if it isn't yet.")
        .action(async ({ config, text, startsAt, endsAt, allDay, scheduledAt }, id) => {
            const result = await io.withContext(
                config,
                (ctx) =>
                    changeAnnouncement(ctx, id, { text, startsAt, endsAt, allDay, scheduledAt }),
            );
            io.print(announcementOutcome(id, result));
        })
        .command("publish <id:string>", "Publish an announcement now.")
        .action(async ({ config }, id) => {
            const result = await io.withContext(config, (ctx) => publishAnnouncement(ctx, id));
            io.print(announcementOutcome(id, result));
        })
        .command("unpublish <id:string>", "Take an announcement down, until published.")
        .action(async ({ config }, id) => {
            const result = await io.withContext(config, (ctx) => unpublishAnnouncement(ctx, id));
            io.print(announcementOutcome(id, result));
        })
        .command("delete <id:string>", "Delete an announcement.")
        .action(async ({ config }, id) => {
            const found = await io.withContext(config, (ctx) => removeAnnouncement(ctx, id));
            if (!found) throw new AdminError(`There is no announcement ${id}`);

            io.print(JSON.stringify({ id, deleted: true }));
        })
        .reset();
