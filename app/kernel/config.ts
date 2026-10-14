import { parse } from "@std/toml";
import { z } from "zod";

/** Everything an instance can be configured with. Unknown keys are errors, so typos don't go unnoticed. */
export const Config = z.strictObject({
    /** The instance's domain, without a port. https://versia.pub/api/basics#domain */
    domain: z.hostname().transform((domain) => domain.toLowerCase()),
    /** Exactly one of a libpq connection string for PostgreSQL, or the path of a SQLite file. */
    database: z.union([
        z.strictObject({ postgres: z.string().min(1) }),
        z.strictObject({ sqlite: z.string().min(1) }),
    ], { error: 'Set exactly one of "postgres" or "sqlite"' }),
    http: z.strictObject({
        port: z.int().min(1).max(65535).default(8080),
    }).prefault({}),
    logging: z.strictObject({
        level: z.enum(["trace", "debug", "info", "warning", "error", "fatal"])
            .default("info"),
    }).prefault({}),
});
export type Config = z.infer<typeof Config>;

export type ConfigResult =
    | { readonly ok: true; readonly config: Config }
    | { readonly ok: false; readonly error: string };

/** Parses and checks the text of a TOML config file. */
export const parseConfig = (toml: string): ConfigResult => {
    let data: unknown;
    try {
        data = parse(toml);
    } catch (error) {
        return {
            ok: false,
            error: `Invalid TOML: ${(error as Error).message}`,
        };
    }
    const result = Config.safeParse(data);
    return result.success
        ? { ok: true, config: result.data }
        : { ok: false, error: z.prettifyError(result.error) };
};

/** Reads the config file at `path`. */
export const readConfig = async (path: string): Promise<ConfigResult> => {
    let text: string;
    try {
        text = await Deno.readTextFile(path);
    } catch (error) {
        return { ok: false, error: (error as Error).message };
    }
    return parseConfig(text);
};
