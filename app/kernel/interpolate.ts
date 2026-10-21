/** Where `${env:…}` and `${file:…}` references in the config are read from. */
export type Sources = {
    readonly env: (name: string) => string | undefined;
    readonly readFile: (path: string) => Promise<string>;
};

/** The process's own environment and files. */
export const systemSources: Sources = {
    env: (name) => Deno.env.get(name),
    readFile: (path) => Deno.readTextFile(path),
};

export type Interpolated =
    | { readonly ok: true; readonly data: unknown }
    | { readonly ok: false; readonly error: string };

type Path = readonly (string | number)[];
type Problem = { readonly path: Path; readonly message: string };

// `$${` is a literal `${`, `${…}` is a reference, and a `${` left over was never closed.
const tokens = /\$\$\{|\$\{([^}]*)\}|\$\{/g;
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What one token stands for, or a problem explaining why it can't be read. */
const resolve = async (
    token: RegExpExecArray,
    sources: Sources,
): Promise<{ value: string } | { problem: string }> => {
    const [text, reference] = token;
    if (text === "$${") return { value: "${" };
    if (reference === undefined) return { problem: 'Unclosed "${"; write "$${" for a literal one' };

    const [kind, ...rest] = reference.split(":");
    const name = rest.join(":");

    if (kind === "env") {
        if (!envName.test(name)) return { problem: `"${name}" isn't a variable name` };

        const value = sources.env(name);
        return value === undefined
            ? { problem: `The environment variable ${name} isn't set` }
            : { value };
    }

    if (kind === "file" && name !== "") {
        try {
            // Files written by editors and `echo` end with a newline that isn't part of the value.
            return { value: (await sources.readFile(name)).replace(/\r?\n$/, "") };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { problem: `Can't read ${name}: ${message}` };
        }
    }

    return { problem: `Unknown reference "${text}"; use \${env:NAME} or \${file:PATH}` };
};

/** `text` with each reference replaced. What a reference reads isn't searched for more. */
const fill = async (
    text: string,
    path: Path,
    sources: Sources,
    problems: Problem[],
): Promise<string> => {
    let filled = "";
    let end = 0;

    for (const token of text.matchAll(tokens)) {
        const resolved = await resolve(token, sources);
        if ("problem" in resolved) problems.push({ path, message: resolved.problem });

        filled += text.slice(end, token.index) + ("value" in resolved ? resolved.value : "");
        end = token.index + token[0].length;
    }

    return filled + text.slice(end);
};

const walk = async (
    value: unknown,
    path: Path,
    sources: Sources,
    problems: Problem[],
): Promise<unknown> => {
    if (typeof value === "string") return await fill(value, path, sources, problems);

    // One at a time, so problems are listed in the order they appear in the config.
    if (Array.isArray(value)) {
        const items = [];
        for (const [index, item] of value.entries()) {
            items.push(await walk(item, [...path, index], sources, problems));
        }
        return items;
    }

    // TOML tables. Dates are objects too, but have nothing to fill in.
    if (typeof value === "object" && value !== null && !(value instanceof Date)) {
        const entries = [];
        for (const [key, item] of Object.entries(value)) {
            entries.push([key, await walk(item, [...path, key], sources, problems)]);
        }
        return Object.fromEntries(entries);
    }

    return value;
};

/** `a.b[0].c`, as Zod writes paths in its errors. */
const pathText = (path: Path) =>
    path.map((part, index) =>
        typeof part === "number" ? `[${part}]` : index === 0 ? part : `.${part}`
    ).join("");

/**
 * Replaces `${env:NAME}` and `${file:PATH}` in every string value with that environment variable or
 * file, so secrets can be kept out of the config file. Keys are left as they are. Problems name
 * where they are in the config, never what a variable or file holds.
 */
export const interpolate = async (data: unknown, sources: Sources): Promise<Interpolated> => {
    const problems: Problem[] = [];
    const filled = await walk(data, [], sources, problems);

    if (problems.length === 0) return { ok: true, data: filled };

    const error = problems
        .map(({ path, message }) => `✖ ${message}\n  → at ${pathText(path)}`)
        .join("\n");
    return { ok: false, error };
};
