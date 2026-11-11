import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getLogger, type LogLevel, type LogRecord, reset } from "@logtape/logtape";
import { chooseFormat, formatterFor, setUpLogging } from "./logging.ts";

const record: LogRecord = {
    category: ["verso", "http"],
    level: "info",
    message: ["Listening on port ", 8080, ""],
    rawMessage: "Listening on port {port}",
    properties: { port: 8080 },
    timestamp: Date.UTC(2026, 10, 11, 12, 0, 0),
};

const escape = "\x1b[";

Deno.test("logs are pretty in a terminal and plain text elsewhere, unless the config says", () => {
    assertEquals(chooseFormat(undefined, true), "pretty");
    assertEquals(chooseFormat(undefined, false), "text");
    assertEquals(chooseFormat("json", true), "json");
    assertEquals(chooseFormat("pretty", false), "pretty");
});

Deno.test("pretty logs show the time and the level on a coloured background", () => {
    const labels: Record<LogLevel, string> = {
        trace: "1;38;5;231;100m TRC",
        debug: "1;38;5;231;44m DBG",
        info: "1;38;5;16;42m INF",
        warning: "1;38;5;16;43m WRN",
        error: "1;38;5;231;41m ERR",
        fatal: "1;38;5;231;45m FTL",
    };
    const pretty = formatterFor("pretty", true);

    for (const [level, label] of Object.entries(labels) as [LogLevel, string][]) {
        const line = pretty({ ...record, level });
        const start = `${escape}2m12:00:00.000${escape}0m ${escape}${label} ${escape}0m `;

        assert(line.startsWith(start), JSON.stringify(line));
    }

    assertStringIncludes(pretty(record), `${escape}2mhttp:${escape}0m`);
    assertStringIncludes(pretty(record), "8080");
});

Deno.test("pretty logs without colour are plain, with the time and a short level", () => {
    const line = formatterFor("pretty", false)(record);

    assertEquals(line, "12:00:00.000 [INF] http: Listening on port 8080\n");
});

Deno.test("pretty and text logs leave out the verso that starts each category", () => {
    const root = { ...record, category: ["verso"] };
    const nested = { ...record, category: ["verso", "jobs", "scheduler"] };

    for (const format of ["pretty", "text"] as const) {
        const formatter = formatterFor(format, false);

        assertStringIncludes(formatter(record), "] http: ");
        assertStringIncludes(formatter(root), "] verso: ");
        assertStringIncludes(formatter(nested), "] jobs·scheduler: ");
    }
});

Deno.test("pretty and text logs show strings without quotes, green in colour, and other values as they are", () => {
    const listening: LogRecord = {
        ...record,
        message: ["Listening on ", "0.0.0.0", " port ", 8080, " for ", { tls: false }, ""],
    };

    for (
        const [format, colour] of [["pretty", true], ["pretty", false], ["text", false]] as const
    ) {
        const line = formatterFor(format, colour)(listening);

        assertStringIncludes(line, "8080");
        assertStringIncludes(line, "tls:");
    }

    assertStringIncludes(formatterFor("text", false)(listening), "Listening on 0.0.0.0 port ");
    assertStringIncludes(formatterFor("pretty", false)(listening), "Listening on 0.0.0.0 port ");
    assertStringIncludes(
        formatterFor("pretty", true)(listening),
        `Listening on ${escape}32m0.0.0.0${escape}39m port ${escape}33m8080${escape}39m for `,
    );
});

Deno.test("strings from elsewhere can't start a new line or send terminal codes", () => {
    const hostile: LogRecord = {
        ...record,
        message: ["Fetched ", "a\nb\r\tc\x1b[31md\x7f\x9b\x00\x01\x0f\x1f\x80\x9f", ""],
    };

    for (
        const [format, colour] of [["pretty", true], ["pretty", false], ["text", false]] as const
    ) {
        const line = formatterFor(format, colour)(hostile);

        assertEquals(line.indexOf("\n"), line.length - 1, JSON.stringify(line));
        assertStringIncludes(
            line,
            "a\\nb\\r\\tc\\x1b[31md\\x7f\\x9b\\x00\\x01\\x0f\\x1f\\x80\\x9f",
        );
        assert(!line.includes("\x1b[31m"), JSON.stringify(line));
    }
});

Deno.test("text logs are one plain line with the date, time, level, category and message", () => {
    const line = formatterFor("text", true)(record);

    assert(!line.includes(escape));
    assertStringIncludes(line, "2026-11-11 12:00:00");
    assertStringIncludes(line, "INF");
    assertStringIncludes(line, "] http: Listening on port 8080");
});

Deno.test("JSON logs are one object per line, with the properties", () => {
    const line = formatterFor("json", true)(record);
    const parsed = JSON.parse(line);

    assertEquals(line.trimEnd().split("\n").length, 1);
    assertEquals(parsed.level, "INFO");
    assertEquals(parsed.logger, "verso.http");
    assertEquals(parsed.message, "Listening on port 8080");
    assertEquals(parsed.properties, { port: 8080 });
});

Deno.test("JSON logs show an error in the message by its name and message", () => {
    const error = new TypeError("boom");
    const line = formatterFor("json", false)({
        ...record,
        message: ["Job ", "1", " failed: ", error, ""],
        properties: { id: "1", error },
    });
    const parsed = JSON.parse(line);

    assertEquals(parsed.message, 'Job "1" failed: "TypeError: boom"');
    assertEquals(parsed.properties.error.message, "boom");
    assertStringIncludes(parsed.properties.error.stack, "TypeError: boom");
});

Deno.test("logs are in colour unless NO_COLOR is set", async () => {
    const lines: string[] = [];
    const { console: output } = globalThis;
    const info = output.info;
    output.info = (line: string) => lines.push(line);

    try {
        await setUpLogging({ level: "info", format: "pretty" });
        getLogger(["verso", "http"]).info("Listening");
    } finally {
        output.info = info;
        await reset();
    }

    assertEquals(lines.length, 1);
    assertEquals(lines[0].includes(escape), !Deno.noColor);
});

Deno.test("logs below the configured level are left out", async () => {
    const lines: string[] = [];
    const { console: output } = globalThis;
    const { info, warn } = output;
    output.info = (line: string) => lines.push(line);
    output.warn = (line: string) => lines.push(line);

    try {
        await setUpLogging({ level: "warning", format: "text" });
        getLogger(["verso", "http"]).info("Listening");
        getLogger(["verso", "http"]).warning("Slow");
    } finally {
        output.info = info;
        output.warn = warn;
        await reset();
    }

    assertEquals(lines.length, 1);
    assertStringIncludes(lines[0], "Slow");
});
