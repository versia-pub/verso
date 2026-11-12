/**
 * What tests of views share: a built web app, and an app with a few accounts to request pages of.
 * @module
 */
import { createLocalAccount, createRemoteAccount } from "../accounts/testing.ts";
import type { WebApp } from "../http/web.ts";
import { createInstance } from "../instances/testing.ts";
import type { Permissions } from "../kernel/config_sections.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext, type TestContext } from "../testing/context.ts";

/** A built web app's page, with an inline script the app starts with. */
export const web: WebApp = {
    files: new Map(),
    page: new TextEncoder().encode(
        "<!doctype html>\n<html><head><link rel=modulepreload></head>" +
            '<body class="app"><div><script>start()</script></div></body></html>\n',
    ),
    policy: "default-src 'none'; script-src 'self' 'sha256-start'",
};

/** A test's context, and what its app answers to a request for `path`. */
export type ViewTest = TestContext & {
    readonly request: (
        path: string,
        init?: RequestInit,
    ) => Promise<{ status: number; headers: Headers; body: string }>;
};

/** An app with the accounts alice, and bob on b.example, to request pages of. */
export const open = async (
    options: { readonly web?: WebApp; readonly permissions?: Permissions } = {},
): Promise<ViewTest> => {
    const test = await createTestContext();
    await createLocalAccount(test.ctx, "alice");
    await createInstance(test.ctx, "b.example");
    await createRemoteAccount(test.ctx, "bob", "b.example");
    const app = createTestApp(test.ctx, [], options);

    const request = async (path: string, init: RequestInit = {}) => {
        const response = await app.request(path, init);
        return { status: response.status, headers: response.headers, body: await response.text() };
    };

    return { ...test, request, [Symbol.asyncDispose]: () => test[Symbol.asyncDispose]() };
};
