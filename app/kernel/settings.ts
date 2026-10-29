/**
 * What services read from config as they run, computed once at startup.
 * @module
 */
import type { Config } from "./config.ts";

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

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
};
