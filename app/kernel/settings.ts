/**
 * What services read from config as they run, computed once at startup.
 * @module
 */
import { dayMs, hourMs } from "./clock.ts";
import type { Config } from "./config.ts";

export type Settings = {
    /** How long a job that failed for good is retained. */
    readonly deadLetterMs: number;
    /** How long an instance can go unreached before nothing more is sent to it. */
    readonly unreachableMs: number;
    /** How many accounts a status may mention. */
    readonly mentions: number;
    /** How many media attachments a status may have. */
    readonly attachments: number;
    /** How long a media attachment's description may be, in code points. */
    readonly mediaDescription: number;
    /**
     * How long an upload that was never attached to a status is retained, and unused remote media.
     */
    readonly unattachedMs: number;
    /** For how long a delivery is retried. */
    readonly deliveryMs: number;
    /** How long a push service has to respond. */
    readonly pushTimeoutMs: number;
    /** How old statuses from other instances are pruned at, or `null` to keep them. */
    readonly remoteStatusMs: number | null;
    /** How old preview cards are pruned at, or `null` to keep them. */
    readonly previewCardMs: number | null;
    /** Whether the files of remote media are cached, to be served by Verso. */
    readonly cacheRemoteMedia: boolean;
    /** How long ago the files of remote attachments were cached when they are removed. */
    readonly remoteMediaMs: number;
    /** How many bytes an uploaded file may have, and a remote image that is cached. */
    readonly maxUploadBytes: number;
};

/** The settings `config` produces. */
export const settingsOf = (
    config: Pick<Config, "jobs" | "federation" | "limits" | "media" | "push">,
): Settings => ({
    deadLetterMs: config.jobs.dead_letter_days * dayMs,
    unreachableMs: config.federation.unreachable_days * dayMs,
    mentions: config.limits.mentions,
    attachments: config.limits.attachments,
    mediaDescription: config.limits.media_description,
    unattachedMs: config.media.unattached_hours * hourMs,
    deliveryMs: config.federation.delivery_hours * hourMs,
    pushTimeoutMs: config.push.timeout_seconds * 1000,
    remoteStatusMs: config.federation.remote_status_days === undefined
        ? null
        : config.federation.remote_status_days * dayMs,
    previewCardMs: config.media.preview_card_days === undefined
        ? null
        : config.media.preview_card_days * dayMs,
    cacheRemoteMedia: config.media.cache_remote_media,
    remoteMediaMs: config.media.remote_media_days * dayMs,
    maxUploadBytes: config.media.max_upload_bytes,
});

/** The settings an instance has when its config leaves them out. */
export const defaultSettings: Settings = {
    deadLetterMs: 30 * dayMs,
    unreachableMs: 7 * dayMs,
    mentions: 100,
    attachments: 16,
    mediaDescription: 4000,
    unattachedMs: 24 * hourMs,
    deliveryMs: 48 * hourMs,
    pushTimeoutMs: 10_000,
    remoteStatusMs: null,
    previewCardMs: null,
    cacheRemoteMedia: true,
    remoteMediaMs: 30 * dayMs,
    maxUploadBytes: 16 * 1024 * 1024,
};
