import { Hono } from "@hono/hono";

/** Every route the server answers. Tests call its `fetch` directly, with no network in between. */
export const createApp = (): Hono => {
    const app = new Hono();
    app.get("/health/live", (c) => c.text("ok"));
    return app;
};
