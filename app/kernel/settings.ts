/**
 * What services read from config as they run, worked out once at startup.
 * @module
 */
import type { Config } from "./config.ts";

const dayMs = 24 * 60 * 60 * 1000;

export type Settings = {
    /** How long a job that failed for good is kept. */
    readonly deadLetterMs: number;
};

/** The settings `config` gives. */
export const settingsOf = (config: Pick<Config, "jobs">): Settings => ({
    deadLetterMs: config.jobs.dead_letter_days * dayMs,
});

/** The settings an instance has when its config leaves them out. */
export const defaultSettings: Settings = { deadLetterMs: 30 * dayMs };
