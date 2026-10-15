import type { Scope } from "./scopes.ts";

/** A client app, registered through `POST /api/v1/apps`. */
export type AppsTable = {
    id: string;
    name: string;
    website: string | null;
    redirect_uris: string[];
    /** The most an app may ask for when it logs a user in. */
    scopes: Scope[];
    /** Public: clients send it in the browser's address bar. */
    client_id: string;
    /** The secret is shown once, when the app registers, and only its hash is kept. */
    client_secret_hash: string;
    created_at: Date;
};
