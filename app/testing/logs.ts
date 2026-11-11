import { AsyncLocalStorage } from "node:async_hooks";
import { configure, type LogRecord, reset } from "@logtape/logtape";

/**
 * Keeps every Verso log record, with the properties `withContext` gives, until disposed. Tests that
 * use it can't run alongside others in the same file that log.
 */
export const captureLogs = async (): Promise<
    { readonly records: LogRecord[] } & AsyncDisposable
> => {
    const records: LogRecord[] = [];

    await configure({
        sinks: { memory: (record) => records.push(record) },
        loggers: [
            { category: ["verso"], lowestLevel: "trace", sinks: ["memory"] },
            // LogTape's own warnings, such as a failing sink, but not its note that it is set up.
            { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["memory"] },
        ],
        contextLocalStorage: new AsyncLocalStorage(),
    });

    return { records, [Symbol.asyncDispose]: () => reset() };
};
