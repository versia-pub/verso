/**
 * Fails if the repository's TypeScript files import each other in a cycle, even through types.
 * `deno info --json` gives the graph as Deno resolves it, so this doesn't parse imports itself.
 */

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

type Dependency = {
    readonly code?: { readonly specifier: string };
    readonly type?: { readonly specifier: string };
};
type Info = { readonly modules: { specifier: string; dependencies?: Dependency[] }[] };

const root = new URL(`file://${Deno.cwd()}/`);

/** The repository's own files, by path from its root, leaving out dependencies. */
const ownPath = (specifier: string) => {
    if (!specifier.startsWith(root.href)) return undefined;

    const path = specifier.slice(root.href.length);
    return skipped.has(path.split("/")[0]) ? undefined : path;
};

/** Each file's imports of other files in the repository. */
const graph = new Map<string, Set<string>>();

const addGraphOf = async (file: string) => {
    const output = await new Deno.Command("deno", { args: ["info", "--json", file] }).output();
    if (!output.success) {
        throw new Error(`deno info failed for ${file}: ${new TextDecoder().decode(output.stderr)}`);
    }

    const info: Info = JSON.parse(new TextDecoder().decode(output.stdout));

    for (const module of info.modules) {
        const from = ownPath(module.specifier);
        if (from === undefined || graph.has(from)) continue;

        const imports = (module.dependencies ?? [])
            .flatMap((dependency) => [dependency.code?.specifier, dependency.type?.specifier])
            .flatMap((specifier) => specifier === undefined ? [] : [ownPath(specifier)])
            .filter((path) => path !== undefined);
        graph.set(from, new Set(imports));
    }
};

// One `deno info` covers everything a file reaches, so only files not reached yet need their own.
for (const file of await typeScriptFiles(".")) {
    if (!graph.has(file.slice("./".length))) await addGraphOf(file);
}

/**
 * Groups of files that each reach all the others: Tarjan's strongly connected components. Only
 * groups of more than one file are cycles, since nothing imports itself.
 */
const cycles = (): string[][] => {
    const index = new Map<string, number>();
    const lowest = new Map<string, number>();
    const stack: string[] = [];
    const found: string[][] = [];

    const visit = (file: string) => {
        index.set(file, index.size);
        lowest.set(file, index.get(file) ?? 0);
        stack.push(file);

        for (const imported of graph.get(file) ?? []) {
            if (!index.has(imported)) {
                visit(imported);
                lowest.set(file, Math.min(lowest.get(file) ?? 0, lowest.get(imported) ?? 0));
            } else if (stack.includes(imported)) {
                lowest.set(file, Math.min(lowest.get(file) ?? 0, index.get(imported) ?? 0));
            }
        }

        if (lowest.get(file) !== index.get(file)) return;

        const group: string[] = [];
        let member: string | undefined;
        do {
            member = stack.pop();
            if (member !== undefined) group.push(member);
        } while (member !== undefined && member !== file);

        if (group.length > 1) found.push(group.toSorted());
    };

    for (const file of graph.keys()) {
        if (!index.has(file)) visit(file);
    }

    return found;
};

const found = cycles();

if (found.length > 0) {
    const report = found.map((group) =>
        group.map((file) => {
            const imports = [...graph.get(file) ?? []].filter((path) => group.includes(path));
            return `  ${file} imports ${imports.join(", ")}`;
        }).join("\n")
    );

    // deno-lint-ignore no-console -- this script's whole output is its report
    console.error(`Import cycles:\n${report.join("\n\n")}`);
    Deno.exit(1);
}
