import { z } from "zod";
import { VersiaRole } from "../versia_role.ts";
import { type CallOptions, type Http, path } from "./http.ts";

/** A new role. */
export type RoleDraft = {
    readonly name: string;
    /** Permission names, such as `roles` or `owner:account`, each of which the viewer has. */
    readonly permissions?: readonly string[];
    /** Lower than the viewer's highest role's. Defaults to 0. */
    readonly priority?: number;
    readonly description?: string;
    /** Whether it is shown on the profiles of accounts that have it. */
    readonly visible?: boolean;
    /** A hex colour in lower case, such as `#ff3838`, or empty for none. */
    readonly color?: string;
    /** The URL of an image for it, or `null` for none. */
    readonly icon?: string | null;
};

/** Changes to a role. What is omitted stays as it was. */
export type RoleChanges = Partial<RoleDraft>;

/**
 * Roles, which grant permissions to the accounts that have them. Versia Server's, which Mastodon
 * doesn't have. A manager changes only roles below their highest, and accounts below them.
 */
export class RoleMethods {
    constructor(private readonly http: Http) {}

    /** Every role, highest priority first. */
    list(options?: CallOptions): Promise<VersiaRole[]> {
        return this.http.json(z.array(VersiaRole), "GET", "/api/v1/roles", options);
    }

    get(id: string, options?: CallOptions): Promise<VersiaRole> {
        return this.http.json(VersiaRole, "GET", path`/api/v1/roles/${id}`, options);
    }

    /** Creates a role. Needs the `roles` permission. */
    create(draft: RoleDraft, options?: CallOptions): Promise<VersiaRole> {
        return this.http.json(VersiaRole, "POST", "/api/v1/roles", { ...options, json: draft });
    }

    /** Changes a role, keeping it below the viewer's highest. Needs the `roles` permission. */
    update(id: string, changes: RoleChanges, options?: CallOptions): Promise<VersiaRole> {
        return this.http.json(VersiaRole, "PATCH", path`/api/v1/roles/${id}`, {
            ...options,
            json: changes,
        });
    }

    /** Deletes a role, taking it from everyone who has it. Needs the `roles` permission. */
    async delete(id: string, options?: CallOptions): Promise<void> {
        await this.http.send("DELETE", path`/api/v1/roles/${id}`, options);
    }

    /** An account's roles, highest priority first. */
    ofAccount(accountId: string, options?: CallOptions): Promise<VersiaRole[]> {
        return this.http.json(
            z.array(VersiaRole),
            "GET",
            path`/api/v1/accounts/${accountId}/roles`,
            options,
        );
    }

    /** Gives an account a role, with permissions the viewer has. Needs the `roles` permission. */
    async give(accountId: string, roleId: string, options?: CallOptions): Promise<void> {
        await this.http.send("POST", path`/api/v1/accounts/${accountId}/roles/${roleId}`, options);
    }

    /**
     * Takes a role from an account, if an admin gave it, rather than the account's identity
     * provider. Needs the `roles` permission.
     */
    async take(accountId: string, roleId: string, options?: CallOptions): Promise<void> {
        await this.http.send(
            "DELETE",
            path`/api/v1/accounts/${accountId}/roles/${roleId}`,
            options,
        );
    }
}
