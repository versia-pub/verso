import { assertEquals } from "@std/assert";
import { interpolate, type Sources } from "./interpolate.ts";

const sources = (
    env: Record<string, string>,
    files: Record<string, string> = {},
): Sources => ({
    env: (name) => Object.hasOwn(env, name) ? env[name] : undefined,
    readFile: (path) =>
        Object.hasOwn(files, path)
            ? Promise.resolve(files[path])
            : Promise.reject(new Error(`No such file: ${path}`)),
});

Deno.test("references in strings are filled in, anywhere in the config", async () => {
    const config = {
        database: { postgres: "postgresql://verso:${env:PGPASS}@db/verso" },
        auth: { issuers: [{ client_secret: "${file:/run/secrets/id}" }] },
        http: { port: 8080 },
        mode: "plain $text {with} braces",
    };

    const result = await interpolate(
        config,
        sources({ PGPASS: "hunter2" }, { "/run/secrets/id": "s3cret\n" }),
    );

    assertEquals(result, {
        ok: true,
        data: {
            database: { postgres: "postgresql://verso:hunter2@db/verso" },
            auth: { issuers: [{ client_secret: "s3cret" }] },
            http: { port: 8080 },
            mode: "plain $text {with} braces",
        },
    });
});

Deno.test("$${ is a literal ${, and what a reference reads isn't searched again", async () => {
    const result = await interpolate(
        { a: "$${env:A}", b: "${env:B}", c: "${file:/c}" },
        sources({ A: "no", B: "${env:A}" }, { "/c": "two\n\n" }),
    );

    assertEquals(result, { ok: true, data: { a: "${env:A}", b: "${env:A}", c: "two\n" } });
});

Deno.test("keys and values that aren't strings are left alone", async () => {
    const when = new Date("2026-10-15T00:00:00Z");
    const result = await interpolate({ "${env:A}": [1, true, when] }, sources({ A: "x" }));

    assertEquals(result, { ok: true, data: { "${env:A}": [1, true, when] } });
});

Deno.test("every problem is named by its place in the config, without any value", async () => {
    const result = await interpolate(
        {
            database: { postgres: "${env:MISSING}" },
            auth: { issuers: [{ client_secret: "${file:/missing}" }] },
            a: "${env:NOT-A-NAME}",
            b: "${secret}",
            c: "${env:SET",
            d: "${file:}",
        },
        sources({ SET: "do not show" }),
    );

    assertEquals(result, {
        ok: false,
        error: [
            "✖ The environment variable MISSING isn't set\n  → at database.postgres",
            "✖ Can't read /missing: No such file: /missing\n  → at auth.issuers[0].client_secret",
            '✖ "NOT-A-NAME" isn\'t a variable name\n  → at a',
            '✖ Unknown reference "${secret}"; use ${env:NAME} or ${file:PATH}\n  → at b',
            '✖ Unclosed "${"; write "$${" for a literal one\n  → at c',
            '✖ Unknown reference "${file:}"; use ${env:NAME} or ${file:PATH}\n  → at d',
        ].join("\n"),
    });
});
