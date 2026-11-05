/**
 * What the routes that post, schedule and edit statuses accept: the body of each, and the limits on
 * it.
 * @module
 */
import { z } from "zod";
import { Flag, Integer, Strings, Text } from "../http/schemas.ts";
import type { Limits } from "../kernel/config_sections.ts";
import { countText } from "../kernel/markup.ts";
import { FocusPoint, MediaDescription } from "../media/routes.ts";
import { ScheduledAt } from "../schedules/routes.ts";
import type { ScheduledParams } from "../schedules/tables.ts";

/** What deleting a status takes. */
const DeleteOptions = z.object({
    delete_media: Flag.optional().meta({
        description: "Whether to delete the status's media at once, rather than keep it for a " +
            "redraft.",
    }),
});

/** What a status says, whether it is new or edited. */
const text = {
    sensitive: Flag.optional(),
    /** Empty or `null` for the author's default, or for an edit, the status's own. */
    language: z.union([z.literal(""), z.string().regex(/^[a-z]{2}$/)]).nullish(),
};

/**
 * A poll, limited by `limits`. Its options are trimmed, and blank ones left out, as on Mastodon.
 * @see https://docs.joinmastodon.org/methods/statuses/#form-data-parameters
 */
const PollDraft = (limits: Limits) =>
    z.object({
        options: Strings
            .transform((options) => options.map((option) => option.trim()).filter(Boolean))
            .pipe(
                z.array(Text(limits.poll_option))
                    .min(2, { error: "Must have at least 2 options" })
                    .max(limits.poll_options, {
                        error: `Must have at most ${limits.poll_options} options`,
                    })
                    .refine((options) => new Set(options).size === options.length, {
                        error: "Must not have the same option twice",
                    }),
            )
            .meta({
                description:
                    "Possible answers to the poll. If provided, `poll[expires_in]` must be provided.",
            }),
        expires_in: Integer.pipe(
            z.int()
                .min(limits.poll_min_seconds, {
                    error: `Must be at least ${limits.poll_min_seconds} seconds`,
                })
                .max(limits.poll_max_seconds, {
                    error: `Must be at most ${limits.poll_max_seconds} seconds`,
                }),
        ).meta({
            description: "Duration that the poll should be open, in seconds. If provided, " +
                "`poll[options]` must be provided.",
        }),
        multiple: Flag.default(false).meta({
            description: "Allow multiple choices? Defaults to false.",
        }),
        hide_totals: Flag.default(false).meta({
            description: "Hide vote counts until the poll ends? Defaults to false.",
        }),
    }).transform((poll) => ({
        options: poll.options,
        expiresIn: poll.expires_in,
        multiple: poll.multiple,
        hideTotals: poll.hide_totals,
    }));

/** The uploads attached to a status, in order, at most `limits.attachments` of them. */
const MediaIds = (limits: Limits) =>
    z.union([
        // As forms send one id, or a field left empty.
        z.string().transform((id) => id === "" ? [] : [id]),
        z.array(z.string()),
        z.null().transform(() => []),
    ])
        .pipe(
            z.array(z.string()).max(limits.attachments, {
                error: `At most ${limits.attachments} files can be attached`,
            }),
        );

/** A change to the description of media attached to a status. */
const MediaAttribute = (limits: Limits) =>
    z.object({
        id: z.string(),
        description: MediaDescription(limits).optional(),
        focus: FocusPoint.optional(),
    });

/** Who may quote a status, which Verso doesn't act on. */
const quotePolicy = z.enum(["public", "followers", "nobody"]).optional();

/** Text may be blank if media is attached, or a status is quoted. */
const blankUnlessAttached = {
    check: (body: { status: string; media_ids?: string[]; quoted_status_id?: string | null }) =>
        body.status.trim() !== "" || (body.media_ids ?? []).length > 0 ||
        Boolean(body.quoted_status_id),
    error: { error: "Can't be blank without attachments", path: ["status"] },
};

/** Limits the status text and content warning together to at most `limits.status` characters. */
const limited = (limits: Limits) => ({
    check: (body: { status: string; spoiler_text?: string }) =>
        countText(body.status) + countText(body.spoiler_text ?? "") <= limits.status,
    error: { error: `Must be at most ${limits.status} characters`, path: ["status"] },
});

/**
 * What a new status may say. It is plain text, unless `content_type` says Markdown, as on Pleroma.
 * A quote policy is accepted and ignored; Verso doesn't restrict quotes.
 * @see https://docs.joinmastodon.org/methods/statuses/#create
 */
const draft = (limits: Limits) =>
    z.object({
        ...text,
        status: z.string().default(""),
        media_ids: MediaIds(limits).default([]),
        content_type: z.enum(["text/plain", "text/markdown"]).default("text/plain"),
        spoiler_text: z.string().default(""),
        poll: PollDraft(limits).nullish(),
        visibility: z.enum(["public", "unlisted", "private", "direct"]).optional(),
        in_reply_to_id: z.string().nullish(),
        quoted_status_id: z.string().nullish(),
        quote_approval_policy: quotePolicy,
        scheduled_at: ScheduledAt,
    })
        .refine(blankUnlessAttached.check, blankUnlessAttached.error)
        .refine(limited(limits).check, limited(limits).error);

/** What a scheduled status will be posted with, as `body` asks. */
const paramsOf = (body: z.output<ReturnType<typeof draft>>): ScheduledParams => ({
    text: body.status,
    content_type: body.content_type,
    spoiler_text: body.spoiler_text,
    sensitive: body.sensitive ?? null,
    visibility: body.visibility ?? null,
    language: body.language || null,
    in_reply_to_id: body.in_reply_to_id ?? null,
    quoted_status_id: body.quoted_status_id || null,
    media_ids: body.media_ids.length > 0 ? body.media_ids : null,
    poll: body.poll
        ? {
            options: body.poll.options,
            expires_in: body.poll.expiresIn,
            multiple: body.poll.multiple,
            hide_totals: body.poll.hideTotals,
        }
        : null,
});

/**
 * What an edited status may say. Omitted fields stay as they were, including the text format. A
 * content warning left unchanged isn't counted toward the limit.
 * @see https://docs.joinmastodon.org/methods/statuses/#edit
 */
const edit = (limits: Limits) =>
    z.object({
        ...text,
        status: z.string(),
        /** Replaces the status's media. If omitted, the media stays as it was. */
        media_ids: MediaIds(limits).optional(),
        media_attributes: z.array(MediaAttribute(limits)).default([]),
        content_type: z.enum(["text/plain", "text/markdown"]).optional(),
        spoiler_text: z.string().optional(),
        /** Replaces the status's poll, or with `null`, removes it. If omitted, it stays. */
        poll: PollDraft(limits).nullable().optional(),
        /** Ignored, as is `quoted_status_id`, which can't be changed. */
        quote_approval_policy: quotePolicy,
    })
        .refine(blankUnlessAttached.check, blankUnlessAttached.error)
        .refine(limited(limits).check, limited(limits).error);

export { DeleteOptions, draft, edit, paramsOf };
