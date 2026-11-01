import type { Context } from "../kernel/context.ts";
import type { AnnouncementRow } from "./announcement_queries.ts";
import { type AnnouncementInput, createAnnouncement } from "./announcements.ts";

/** Makes an announcement saying `text`, published at once unless `input` says otherwise. */
export const announce = async (
    ctx: Context,
    text: string,
    input: Partial<AnnouncementInput> = {},
): Promise<AnnouncementRow> => {
    const made = await createAnnouncement(ctx, {
        text,
        startsAt: null,
        endsAt: null,
        allDay: false,
        scheduledAt: null,
        ...input,
    });
    if ("invalid" in made) throw new Error(made.invalid);

    return made;
};
