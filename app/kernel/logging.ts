import {
    ansiColorFormatter,
    configure,
    defaultTextFormatter,
    getConsoleSink,
    type LogLevel,
} from "@logtape/logtape";

/**
 * Sends logs to the console. They are in colour when a person is watching a terminal, and plain
 * text otherwise, such as in journald or container logs, where colour codes would show up as junk.
 * `NO_COLOR` turns colour off too.
 */
export const setUpLogging = async (
    level: LogLevel,
    colour: boolean = Deno.stdout.isTerminal() && !Deno.noColor,
): Promise<void> => {
    await configure({
        sinks: {
            console: getConsoleSink({
                formatter: colour ? ansiColorFormatter : defaultTextFormatter,
            }),
        },
        loggers: [
            { category: ["verso"], lowestLevel: level, sinks: ["console"] },
            // LogTape's own warnings, such as a misconfigured sink.
            {
                category: ["logtape", "meta"],
                lowestLevel: "warning",
                sinks: ["console"],
            },
        ],
    });
};
