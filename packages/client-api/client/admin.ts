import { AdminAccount, AdminReport } from "../admin.ts";
import { type CallOptions, type Http, path } from "./http.ts";
import { Page, type PageQuery } from "./pages.ts";

/**
 * Which reports to list. Unresolved ones by default, resolved ones with `resolved`, and both with
 * `resolved` and `unresolved`.
 */
export type AdminReportsQuery = PageQuery & {
    readonly resolved?: boolean;
    readonly unresolved?: boolean;
    /** Only those filed by this account. */
    readonly account_id?: string;
    /** Only those of this account. */
    readonly target_account_id?: string;
};

/** Dealing with reports, for moderators with the `reports` permission. */
export class AdminReportMethods {
    constructor(private readonly http: Http) {}

    /**
     * Reports, the latest filed first.
     * @see https://docs.joinmastodon.org/methods/admin/reports/#get
     */
    list(query: AdminReportsQuery = {}, options?: CallOptions): Promise<Page<AdminReport>> {
        return Page.get(this.http, AdminReport, "/api/v1/admin/reports", query, options);
    }

    /** @see https://docs.joinmastodon.org/methods/admin/reports/#get-one */
    get(id: string, options?: CallOptions): Promise<AdminReport> {
        return this.http.json(AdminReport, "GET", path`/api/v1/admin/reports/${id}`, options);
    }

    /**
     * Marks a report as resolved by the viewer.
     * @see https://docs.joinmastodon.org/methods/admin/reports/#resolve
     */
    resolve(id: string, options?: CallOptions): Promise<AdminReport> {
        return this.http.json(
            AdminReport,
            "POST",
            path`/api/v1/admin/reports/${id}/resolve`,
            options,
        );
    }

    /**
     * Marks a report as unresolved.
     * @see https://docs.joinmastodon.org/methods/admin/reports/#reopen
     */
    reopen(id: string, options?: CallOptions): Promise<AdminReport> {
        return this.http.json(
            AdminReport,
            "POST",
            path`/api/v1/admin/reports/${id}/reopen`,
            options,
        );
    }
}

/**
 * Which accounts to list, all of them by default. Verso doesn't keep users' emails, IP addresses or
 * invites, or have pending, disabled or sensitive accounts, so filtering by those lists none.
 */
export type AdminAccountsQuery = PageQuery & {
    readonly origin?: "local" | "remote";
    /** `active` for those not suspended. */
    readonly status?: "active" | "pending" | "disabled" | "silenced" | "suspended" | "sensitized";
    /** `staff` for those with a role that may deal with reports. */
    readonly permissions?: "staff";
    /** Only those with any of these roles. */
    readonly role_ids?: readonly string[];
    readonly invited_by?: string;
    /** Usernames that start with this, ignoring case. */
    readonly username?: string;
    /** Display names that start with this, ignoring case. */
    readonly display_name?: string;
    /** Only those on the instance with this domain. */
    readonly by_domain?: string;
    readonly email?: string;
    readonly ip?: string;
};

/** What a moderator does to an account, as `accounts.act` takes it. */
export type AdminAccountAction = {
    readonly type: "silence" | "suspend";
    /** A report to act on. Every unresolved report about the account is resolved. */
    readonly report_id?: string;
};

/** Moderating accounts, for moderators with the `accounts` permission. */
export class AdminAccountMethods {
    constructor(private readonly http: Http) {}

    /**
     * Accounts, the latest created first.
     * @see https://docs.joinmastodon.org/methods/admin/accounts/#v2
     */
    list(query: AdminAccountsQuery = {}, options?: CallOptions): Promise<Page<AdminAccount>> {
        return Page.get(this.http, AdminAccount, "/api/v2/admin/accounts", query, options);
    }

    /** @see https://docs.joinmastodon.org/methods/admin/accounts/#get-one */
    get(id: string, options?: CallOptions): Promise<AdminAccount> {
        return this.http.json(AdminAccount, "GET", path`/api/v1/admin/accounts/${id}`, options);
    }

    /**
     * Silences or suspends an account below the viewer's highest role, and resolves the reports
     * about it, which needs the `reports` permission too when there are any.
     * @see https://docs.joinmastodon.org/methods/admin/accounts/#action
     */
    async act(id: string, action: AdminAccountAction, options?: CallOptions): Promise<void> {
        await this.http.send("POST", path`/api/v1/admin/accounts/${id}/action`, {
            ...options,
            json: action,
        });
    }

    /** @see https://docs.joinmastodon.org/methods/admin/accounts/#unsilence */
    unsilence(id: string, options?: CallOptions): Promise<AdminAccount> {
        return this.http.json(
            AdminAccount,
            "POST",
            path`/api/v1/admin/accounts/${id}/unsilence`,
            options,
        );
    }

    /** @see https://docs.joinmastodon.org/methods/admin/accounts/#unsuspend */
    unsuspend(id: string, options?: CallOptions): Promise<AdminAccount> {
        return this.http.json(
            AdminAccount,
            "POST",
            path`/api/v1/admin/accounts/${id}/unsuspend`,
            options,
        );
    }

    /**
     * Deletes a suspended local user below the viewer's highest role, in the background, keeping
     * their username taken.
     * @see https://docs.joinmastodon.org/methods/admin/accounts/#delete
     */
    async delete(id: string, options?: CallOptions): Promise<void> {
        await this.http.send("DELETE", path`/api/v1/admin/accounts/${id}`, options);
    }
}

/** Moderating the instance, as the viewer's permissions allow. */
export class AdminMethods {
    /** Dealing with reports. */
    readonly reports: AdminReportMethods;
    /** Moderating accounts. */
    readonly accounts: AdminAccountMethods;

    constructor(http: Http) {
        this.reports = new AdminReportMethods(http);
        this.accounts = new AdminAccountMethods(http);
    }
}
