import { z } from "zod";
import { Announcement } from "../announcement.ts";
import { type CallOptions, type Http, path } from "./http.ts";

/** The announcements the instance's admins make. */
export class AnnouncementMethods {
    constructor(private readonly http: Http) {}

    /**
     * The announcements that are up, the one that starts first first, with dismissed ones too.
     * @see https://docs.joinmastodon.org/methods/announcements/#get
     */
    list(options?: CallOptions): Promise<Announcement[]> {
        return this.http.json(z.array(Announcement), "GET", "/api/v1/announcements", options);
    }

    /**
     * Marks an announcement read.
     * @see https://docs.joinmastodon.org/methods/announcements/#dismiss
     */
    async dismiss(id: string, options?: CallOptions): Promise<void> {
        await this.http.send("POST", path`/api/v1/announcements/${id}/dismiss`, options);
    }
}
