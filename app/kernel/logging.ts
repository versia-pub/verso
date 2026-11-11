import { AsyncLocalStorage } from "node:async_hooks";
import {
    configure,
    getAnsiColorFormatter,
    getConsoleSink,
    getTextFormatter,
    jsonLinesFormatter,
    type LogLevel,
    type TextFormatter,
} from "@logtape/logtape";

/**
 * How log lines are written: `pretty` for a person at a terminal, with the time and a coloured
 * level, `text` as plain lines, and `json` as one JSON object per line, for log collectors.
 */
export type LogFormat = "pretty" | "text" | "json";

/** `format` if the config chose one, or else `pretty` in a terminal and `text` elsewhere. */
export const chooseFormat = (format: LogFormat | undefined, terminal: boolean): LogFormat =>
    format ?? (terminal ? "pretty" : "text");

/** Each level's label in `pretty`, bold on a background of its colour. */
const levelLabels: Record<LogLevel, string> = {
    trace: "\x1b[1;38;5;231;100m TRC \x1b[0m",
    debug: "\x1b[1;38;5;231;44m DBG \x1b[0m",
    info: "\x1b[1;38;5;16;42m INF \x1b[0m",
    warning: "\x1b[1;38;5;16;43m WRN \x1b[0m",
    error: "\x1b[1;38;5;231;41m ERR \x1b[0m",
    fatal: "\x1b[1;38;5;231;45m FTL \x1b[0m",
};

const noColours: Record<LogLevel, null> = {
    trace: null,
    debug: null,
    info: null,
    warning: null,
    error: null,
    fatal: null,
};

/** A category without the `verso` that each starts with, unless it is only `verso`. */
const category = (parts: readonly string[]): string =>
    (parts.length > 1 ? parts.slice(1) : parts).join("·");

/** Control characters as escapes, so a value from elsewhere can't start a line or colour one. */
const escapeControls = (text: string): string =>
    // deno-lint-ignore no-control-regex -- matching control characters is the point
    text.replace(/[\x00-\x1f\x7f-\x9f]/g, (character) =>
        ({ "\n": "\\n", "\r": "\\r", "\t": "\\t" })[character] ??
            `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`);

/** Strings without the quotes LogTape gives them, but escaped, and anything else as it shows it. */
const value = (value: unknown, inspect: (value: unknown) => string): string =>
    typeof value === "string" ? escapeControls(value) : inspect(value);

/** As `value`, in colour: strings in green, as `inspect` shows them, and anything else as it does. */
const colouredValue = (
    value: unknown,
    inspect: (value: unknown, options?: { colors?: boolean }) => string,
): string =>
    typeof value === "string"
        ? `\x1b[32m${escapeControls(value)}\x1b[39m`
        : inspect(value, { colors: true });

/** `pretty`: LogTape's ANSI format, with only the time and the level as a coloured label. */
const prettyFormatter = (colour: boolean): TextFormatter =>
    colour
        ? getAnsiColorFormatter({
            timestamp: "time",
            level: (level) => levelLabels[level],
            levelStyle: null,
            levelColors: noColours,
            category,
            value: colouredValue,
        })
        : getTextFormatter({ timestamp: "time", level: "ABBR", category, value });

/** `text`: LogTape's plain format, with the shorter category and unquoted strings. */
const textFormatter = getTextFormatter({ category, value });

/** Writes records as `format` says. `pretty` is only in colour if `colour` is true. */
export const formatterFor = (format: LogFormat, colour: boolean): TextFormatter => {
    switch (format) {
        case "pretty":
            return prettyFormatter(colour);
        case "text":
            return textFormatter;
        case "json":
            return jsonLinesFormatter;
    }
};

/**
 * Sends logs to the console. `NO_COLOR` turns colour off. Each async task can carry properties
 * that its log lines all get, given with LogTape's `withContext`.
 */
export const setUpLogging = async (
    settings: { readonly level: LogLevel; readonly format?: LogFormat },
    terminal: boolean = Deno.stdout.isTerminal(),
): Promise<void> => {
    const format = chooseFormat(settings.format, terminal);

    await configure({
        sinks: { console: getConsoleSink({ formatter: formatterFor(format, !Deno.noColor) }) },
        loggers: [
            { category: ["verso"], lowestLevel: settings.level, sinks: ["console"] },
            // LogTape's own warnings, such as a misconfigured sink.
            {
                category: ["logtape", "meta"],
                lowestLevel: "warning",
                sinks: ["console"],
            },
        ],
        contextLocalStorage: new AsyncLocalStorage(),
    });
};
