import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import denoConfig from "../../deno.json" with { type: "json" };

/** A single-page app: one `index.html` that renders every page in the browser. */
export default defineConfig({
    plugins: [
        sveltekit({
            adapter: adapter({ fallback: "index.html" }),
            // Where the app's scripts and styles go, under the site root.
            appDir: "_web",
            // Kit's default is the build time, which makes every build differ.
            version: { name: denoConfig.version },
        }),
    ],
});
