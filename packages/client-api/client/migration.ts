import { AccountMigration } from "../account_migration.ts";
import type { CallOptions, Http } from "./http.ts";

/**
 * Moving the viewer from another account to theirs. Verso's own, as Mastodon only has settings
 * pages for it.
 */
export class MigrationMethods {
    constructor(private readonly http: Http) {}

    /** Where the viewer's account moved from, and to. */
    get(options?: CallOptions): Promise<AccountMigration> {
        return this.http.json(AccountMigration, "GET", "/api/v1/migration", options);
    }

    /**
     * Says the viewer moved from the account at `acct`, such as `alice@example.com`, so it can then
     * move to theirs.
     */
    setPrevious(acct: string, options?: CallOptions): Promise<AccountMigration> {
        return this.http.json(AccountMigration, "PUT", "/api/v1/migration/previous", {
            ...options,
            json: { acct },
        });
    }

    /** Says the viewer moved from no account. */
    removePrevious(options?: CallOptions): Promise<AccountMigration> {
        return this.http.json(AccountMigration, "DELETE", "/api/v1/migration/previous", options);
    }

    /**
     * Moves the viewer to the account at `acct`, which must say it moved from theirs, at most once
     * a month. Their followers then follow it instead.
     */
    move(acct: string, options?: CallOptions): Promise<AccountMigration> {
        return this.http.json(AccountMigration, "POST", "/api/v1/migration/move", {
            ...options,
            json: { acct },
        });
    }

    /** Says the viewer no longer moved. Their followers that moved stay where they are. */
    cancelMove(options?: CallOptions): Promise<AccountMigration> {
        return this.http.json(AccountMigration, "DELETE", "/api/v1/migration/move", options);
    }
}
