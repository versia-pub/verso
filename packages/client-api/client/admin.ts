import { AdminReport } from "../admin.ts";
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

/** Moderating the instance, as the viewer's permissions allow. */
export class AdminMethods {
    /** Dealing with reports. */
    readonly reports: AdminReportMethods;

    constructor(http: Http) {
        this.reports = new AdminReportMethods(http);
    }
}
