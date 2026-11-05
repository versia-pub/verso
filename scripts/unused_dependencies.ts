/**
 * Fails if an import in deno.json isn't used by any TypeScript file in the repository.
 * `deno info --json` lists each file's imports exactly as written, such as "zod".
 */
import denoConfig from "../deno.json" with { type: "json" };

const skipped = new Set(["vendor", "node_modules", ".git", ".direnv"]);

const typeScriptFiles = async (directory: string): Promise<string[]> => {
    const files: string[] = [];

    for await (const entry of Deno.readDir(directory)) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory && !skipped.has(entry.name)) {
            files.push(...await typeScriptFiles(path));
        } else if (entry.isFile && entry.name.endsWith(".ts")) {
            files.push(path);
        }
    }

    return files;
};

type Info = {
    modules: { specifier: string; dependencies?: { specifier: string }[] }[];
};

const root = new URL(`file://${Deno.cwd()}/`);

const used = new Set<string>();
/** The modules whose imports are in `used`, as URLs. */
const reached = new Set<string>();

/** Adds the imports of `file` and of everything it reaches. */
const addImportsOf = async (file: string) => {
    const output = await new Deno.Command("deno", {
        args: ["info", "--json", file],
    }).output();

    if (!output.success) {
        throw new Error(
            `deno info failed for ${file}: ${new TextDecoder().decode(output.stderr)}`,
        );
    }

    const info: Info = JSON.parse(new TextDecoder().decode(output.stdout));

    for (const module of info.modules) {
        reached.add(module.specifier);
        for (const dependency of module.dependencies ?? []) used.add(dependency.specifier);
    }
};

// Tests reach most of the code, and one `deno info` covers everything a file reaches, so only files
// not reached yet need their own.
const files = (await typeScriptFiles(".")).sort((a, b) =>
    Number(b.endsWith(".test.ts")) - Number(a.endsWith(".test.ts"))
);
for (const file of files) {
    if (!reached.has(new URL(file.slice("./".length), root).href)) await addImportsOf(file);
}

const isUsed = (name: string) =>
    used.has(name) ||
    [...used].some((specifier) => specifier.startsWith(`${name}/`));

// Deno finds @types/<name> for <name> by itself, so nothing imports it directly.
const unused = Object.keys(denoConfig.imports).filter((name) =>
    !isUsed(name.startsWith("@types/") ? name.slice("@types/".length) : name)
);

if (unused.length > 0) {
    // deno-lint-ignore no-console -- this script's whole output is its report
    console.error(`Unused dependencies in deno.json: ${unused.join(", ")}`);
    Deno.exit(1);
}
