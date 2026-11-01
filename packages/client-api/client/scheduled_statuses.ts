import { ScheduledStatus } from "../scheduled_status.ts";
import { type CallOptions, type Http, path } from "./http.ts";
import { Page, type PageQuery } from "./pages.ts";

/** The viewer's statuses that will be posted later, which `statuses.schedule` schedules. */
export class ScheduledStatusMethods {
    constructor(private readonly http: Http) {}

    /**
     * The viewer's scheduled statuses, the last scheduled first.
     * @see https://docs.joinmastodon.org/methods/scheduled_statuses/#get
     */
    list(query: PageQuery = {}, options?: CallOptions): Promise<Page<ScheduledStatus>> {
        return Page.get(this.http, ScheduledStatus, "/api/v1/scheduled_statuses", query, options);
    }

    /**
     * One of the viewer's scheduled statuses.
     * @see https://docs.joinmastodon.org/methods/scheduled_statuses/#get-one
     */
    get(id: string, options?: CallOptions): Promise<ScheduledStatus> {
        return this.http.json(
            ScheduledStatus,
            "GET",
            path`/api/v1/scheduled_statuses/${id}`,
            options,
        );
    }

    /**
     * Moves when a scheduled status is posted, an ISO 8601 time at least 5 minutes from now.
     * @see https://docs.joinmastodon.org/methods/scheduled_statuses/#update
     */
    update(id: string, scheduledAt: string, options?: CallOptions): Promise<ScheduledStatus> {
        return this.http.json(
            ScheduledStatus,
            "PUT",
            path`/api/v1/scheduled_statuses/${id}`,
            { ...options, json: { scheduled_at: scheduledAt } },
        );
    }

    /**
     * Cancels a scheduled status, so it is never posted.
     * @see https://docs.joinmastodon.org/methods/scheduled_statuses/#cancel
     */
    async delete(id: string, options?: CallOptions): Promise<void> {
        await this.http.send("DELETE", path`/api/v1/scheduled_statuses/${id}`, options);
    }
}
