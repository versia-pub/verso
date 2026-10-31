import { Conversation } from "../conversation.ts";
import { type CallOptions, type Http, path } from "./http.ts";
import { Page, type PageQuery } from "./pages.ts";

/** The viewer's direct conversations. */
export class ConversationMethods {
    constructor(private readonly http: Http) {}

    /**
     * The viewer's conversations, the one with the latest status first. Pages are by their latest
     * statuses' ids.
     * @see https://docs.joinmastodon.org/methods/conversations/#get
     */
    list(query: PageQuery = {}, options?: CallOptions): Promise<Page<Conversation>> {
        return Page.get(this.http, Conversation, "/api/v1/conversations", query, options);
    }

    /**
     * Removes a conversation from the viewer's list, until a new status is posted in it.
     * @see https://docs.joinmastodon.org/methods/conversations/#delete
     */
    async delete(id: string, options?: CallOptions): Promise<void> {
        await this.http.send("DELETE", path`/api/v1/conversations/${id}`, options);
    }

    /**
     * Marks a conversation read.
     * @see https://docs.joinmastodon.org/methods/conversations/#read
     */
    read(id: string, options?: CallOptions): Promise<Conversation> {
        return this.http.json(
            Conversation,
            "POST",
            path`/api/v1/conversations/${id}/read`,
            options,
        );
    }

    /** Marks a conversation unread. */
    unread(id: string, options?: CallOptions): Promise<Conversation> {
        return this.http.json(
            Conversation,
            "POST",
            path`/api/v1/conversations/${id}/unread`,
            options,
        );
    }
}
