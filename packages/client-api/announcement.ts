import { z } from "zod";
import { CustomEmoji } from "./custom_emoji.ts";
import { Status, StatusMention, StatusTag } from "./status.ts";

/**
 * The reactions to an announcement with one emoji.
 * @see https://docs.joinmastodon.org/entities/Announcement/#Reaction
 */
export const AnnouncementReaction = z.object({
    /** A Unicode emoji, or a custom emoji's shortcode, without colons. */
    name: z.string(),
    count: z.int().min(1),
    /** Whether the viewer reacted with it, for a viewer. */
    me: z.boolean().optional(),
    /** For a custom emoji, its picture, and the same picture not animated. */
    url: z.url().optional(),
    static_url: z.url().optional(),
});
export type AnnouncementReaction = z.infer<typeof AnnouncementReaction>;

/**
 * A change in the reactions to an announcement with one emoji, as the user stream sends it. Unlike
 * the reactions in an announcement, it has none of them if the last was undone, and it never says
 * whether the viewer made one.
 */
export const AnnouncementReactionChange = z.object({
    announcement_id: z.string(),
    name: z.string(),
    count: z.int().min(0),
    url: z.url().optional(),
    static_url: z.url().optional(),
});
export type AnnouncementReactionChange = z.infer<typeof AnnouncementReactionChange>;

/**
 * An announcement the instance's admins make to its users.
 * @see https://docs.joinmastodon.org/entities/Announcement/
 */
export const Announcement = z.object({
    id: z.string(),
    /** As HTML. */
    content: z.string(),
    /** When the event it announces starts and ends, if it is about one. */
    starts_at: z.iso.datetime().nullable(),
    ends_at: z.iso.datetime().nullable(),
    /** Whether the event lasts whole days, so its times can be left out. */
    all_day: z.boolean(),
    published_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    /** Whether the viewer dismissed it, for a viewer. */
    read: z.boolean().optional(),
    mentions: z.array(StatusMention),
    /** The statuses it links to. */
    statuses: z.array(Status),
    tags: z.array(StatusTag),
    emojis: z.array(CustomEmoji),
    reactions: z.array(AnnouncementReaction),
});
export type Announcement = z.infer<typeof Announcement>;
