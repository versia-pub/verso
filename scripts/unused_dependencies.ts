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

const importsOf = async (file: string): Promise<string[]> => {
    const output = await new Deno.Command("deno", {
        args: ["info", "--json", file],
    }).output();
    if (!output.success) {
        throw new Error(
            `deno info failed for ${file}: ${new TextDecoder().decode(output.stderr)}`,
        );
    }
    const info: { modules: { dependencies?: { specifier: string }[] }[] } = JSON
        .parse(
            new TextDecoder().decode(output.stdout),
        );
    return info.modules.flatMap((module) => module.dependencies ?? []).map((
        dependency,
    ) => dependency.specifier);
};

const used = new Set<string>();
for (const file of await typeScriptFiles(".")) {
    for (const specifier of await importsOf(file)) used.add(specifier);
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
