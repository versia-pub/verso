/**
 * The pages Verso renders itself for addresses such as `/@alice`, for visitors who aren't logged
 * in, link previews and search engines. Each is the web app's page with the view put into it, so
 * the app still starts on top.
 * @module
 */
import type { Child } from "@hono/hono/jsx";
import type { WebApp } from "../http/web.ts";

/** What a view shows: tags for the page's `<head>`, such as its title, and its content. */
export type View = { readonly head: Child; readonly body: Child };

/** The page a view is put into when the web app isn't built. */
const bare = `<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
    </head>
    <body></body>
</html>
`;

/** The few styles a view needs to be readable before the web app starts, light or dark. */
const styles = `
    :root { color-scheme: light dark; }
    .verso-view { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 0 auto; padding: 1rem; }
    .verso-view img { max-width: 100%; }
    .verso-view .avatar { width: 6rem; height: 6rem; border-radius: 0.75rem; }
    .verso-view .status { border-top: 1px solid #8886; padding: 0.75rem 0; }
    .verso-view .status .avatar { width: 2rem; height: 2rem; border-radius: 0.5rem; vertical-align: middle; }
    .verso-view .status.focus .content { font-size: 1.2em; }
    .verso-view .media img { max-height: 24rem; }
    .verso-view .emoji { height: 1.2em; vertical-align: middle; }
`;

/** What a view's page may load and run: the web app's own, with framing never allowed. */
export const viewPolicy = (web: WebApp | undefined): string =>
    `${
        web?.policy ??
            "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; base-uri 'none'"
    }; frame-ancestors 'none'`;

/**
 * The page for `view`: the web app's, or a bare one if it isn't built, with the view's head tags at
 * the end of its `<head>` and its content first in its `<body>`, outside where the app starts.
 */
export const viewPage = async (web: WebApp | undefined, view: View): Promise<string> => {
    const template = web ? new TextDecoder().decode(web.page) : bare;
    const head = await (
        <>
            {view.head}
            <style dangerouslySetInnerHTML={{ __html: styles }} />
        </>
    ).toString();
    const body = await (<main class="verso-view">{view.body}</main>).toString();

    return template
        .replace("</head>", () => `${head}</head>`)
        .replace(/<body[^>]*>/, (open) => `${open}${body}`);
};
