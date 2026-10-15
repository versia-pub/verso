import { html } from "@hono/hono/html";
import type { Html } from "./route.ts";

/** Verso's one page layout: a heading and its content, readable on any screen, light or dark. */
export const layout = (title: string, content: Html): Html =>
    html`
<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="color-scheme" content="light dark">
        <title>${title}</title>
        <style>
            body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; }
            button { font: inherit; padding: 0.5rem 1rem; }
        </style>
    </head>
    <body>
        <h1>${title}</h1>
        ${content}
    </body>
</html>
    `;
