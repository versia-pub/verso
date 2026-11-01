import { Report, type ReportCategory } from "../report.ts";
import type { CallOptions, Http } from "./http.ts";

/** A report, as `reports.create` files it. */
export type NewReport = {
    readonly account_id: string;
    readonly status_ids?: readonly string[];
    /** At most 1,000 characters. */
    readonly comment?: string;
    /** Whether to send it on to the account's instance, if it is remote. */
    readonly forward?: boolean;
    /** The instances to send it on to; the account's own by default. */
    readonly forward_to_domains?: readonly string[];
    /** `violation` if `rule_ids` are given, and otherwise `other` by default. */
    readonly category?: ReportCategory;
    readonly rule_ids?: readonly string[];
};

/** Reporting accounts to the instance's moderators. */
export class ReportMethods {
    constructor(private readonly http: Http) {}

    /**
     * Reports an account, and some of its statuses, to the instance's moderators.
     * @see https://docs.joinmastodon.org/methods/reports/#post
     */
    create(report: NewReport, options?: CallOptions): Promise<Report> {
        return this.http.json(Report, "POST", "/api/v1/reports", { ...options, json: report });
    }
}
