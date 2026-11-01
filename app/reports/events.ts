/**
 * Events about reports for the rest of Verso.
 * @module
 */
import type { DomainEvent } from "../kernel/context.ts";

/**
 * A local user filed the report `reportId` of a remote account, and asked for it to be sent on to
 * the instances at `domains`, those of the account and of the accounts its statuses reply to.
 */
export type ReportForwarded = {
    readonly type: "reports.forwarded";
    readonly reportId: string;
    readonly domains: readonly string[];
};

export const isReportForwarded = (event: DomainEvent): event is ReportForwarded =>
    event.type === "reports.forwarded";
