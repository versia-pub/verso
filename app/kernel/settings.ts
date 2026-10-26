/**
 * What services read from config as they run, worked out once at startup.
 * @module
 */
import type { Config } from "./config.ts";

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

export type Settings = {
    /** How long a job that failed for good is kept. */
    readonly deadLetterMs: number;
    /** How long an instance can go unreached before nothing more is sent to it. */
    readonly unreachableMs: number;
    /** How many accounts a status may mention. */
    readonly mentions: number;
    /** How long an upload no status was given is kept. */
    readonly unattachedMs: number;
    /** For how long a delivery is tried. */
    readonly deliveryMs: number;
};

/** The settings `config` gives. */
export const settingsOf = (
    config: Pick<Config, "jobs" | "federation" | "limits" | "media">,
): Settings => ({
    deadLetterMs: config.jobs.dead_letter_days * dayMs,
    unreachableMs: config.federation.unreachable_days * dayMs,
    mentions: config.limits.mentions,
    unattachedMs: config.media.unattached_hours * hourMs,
    deliveryMs: config.federation.delivery_hours * hourMs,
});

/** The settings an instance has when its config leaves them out. */
export const defaultSettings: Settings = {
    deadLetterMs: 30 * dayMs,
    unreachableMs: 7 * dayMs,
    mentions: 100,
    unattachedMs: 24 * hourMs,
    deliveryMs: 48 * hourMs,
};
