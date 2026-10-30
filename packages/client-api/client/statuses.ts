import { z } from "zod";
import { Account, type Visibility } from "../account.ts";
import { Context, Status, StatusEdit, StatusReaction, StatusSource } from "../status.ts";
import { type CallOptions, type Http, path } from "./http.ts";
import { Page, type PageQuery } from "./pages.ts";

/** How a status's text is written. Plain text has its links, mentions and hashtags linked. */
export type ContentType = "text/plain" | "text/markdown";

/** A new status. It needs text, media, or both. */
export type StatusDraft = {
    readonly status?: string;
    /** Uploads to attach, in order. */
    readonly media_ids?: readonly string[];
    /** Defaults to plain text. */
    readonly content_type?: ContentType;
    /** A content warning, shown in place of the text until the reader opens it. */
    readonly spoiler_text?: string;
    /** Whether the media is hidden until the reader opens it. */
    readonly sensitive?: boolean;
    /** An ISO 639-1 code, such as `en`, or the author's default if omitted. */
    readonly language?: string;
    /** Defaults to the author's. */
    readonly visibility?: Visibility;
    readonly in_reply_to_id?: string;
};

/** A change to a status. What is omitted stays as it was, but the text must always be given. */
export type StatusChanges = {
    readonly status: string;
    /** Replaces the media. */
    readonly media_ids?: readonly string[];
    /** Changes the media's descriptions or focus points, as `media.update` does. */
    readonly media_attributes?: readonly {
        readonly id: string;
        readonly description?: string;
        /** Two numbers from -1 to 1, as `x,y`. */
        readonly focus?: string;
    }[];
    readonly content_type?: ContentType;
    readonly spoiler_text?: string;
    readonly sensitive?: boolean;
    readonly language?: string;
};

/** How to share a status. */
export type ReblogOptions = {
    /** Who sees the share. Defaults to the viewer's default, or followers only if that is direct. */
    readonly visibility?: Exclude<Visibility, "direct">;
};

/** Posting, viewing, editing and deleting statuses, and liking, sharing and reacting to them. */
export class StatusMethods {
    constructor(private readonly http: Http) {}

    /**
     * A status, if the viewer may see it.
     * @see https://docs.joinmastodon.org/methods/statuses/#get
     */
    get(id: string, options?: CallOptions): Promise<Status> {
        return this.http.json(Status, "GET", path`/api/v1/statuses/${id}`, options);
    }

    /**
     * Several statuses, by their ids, in the same order, without those that don't exist or the
     * viewer may not see. Mastodon and Verso take at most 20 ids.
     * @see https://docs.joinmastodon.org/methods/statuses/#index
     */
    getMany(ids: readonly string[], options?: CallOptions): Promise<Status[]> {
        return this.http.json(z.array(Status), "GET", "/api/v1/statuses", {
            ...options,
            query: { id: ids },
        });
    }

    /**
     * Posts a status.
     * @see https://docs.joinmastodon.org/methods/statuses/#create
     */
    post(draft: StatusDraft, options?: CallOptions): Promise<Status> {
        return this.http.json(Status, "POST", "/api/v1/statuses", { ...options, json: draft });
    }

    /**
     * Edits one of the viewer's statuses.
     * @see https://docs.joinmastodon.org/methods/statuses/#edit
     */
    edit(id: string, changes: StatusChanges, options?: CallOptions): Promise<Status> {
        return this.http.json(Status, "PUT", path`/api/v1/statuses/${id}`, {
            ...options,
            json: changes,
        });
    }

    /**
     * Deletes one of the viewer's statuses or shares. Gives it back with its `text`, so it can be
     * posted again with changes.
     * @see https://docs.joinmastodon.org/methods/statuses/#delete
     */
    delete(id: string, options?: CallOptions): Promise<Status> {
        return this.http.json(Status, "DELETE", path`/api/v1/statuses/${id}`, options);
    }

    /**
     * A status as its author wrote it, for editing it.
     * @see https://docs.joinmastodon.org/methods/statuses/#source
     */
    source(id: string, options?: CallOptions): Promise<StatusSource> {
        return this.http.json(StatusSource, "GET", path`/api/v1/statuses/${id}/source`, options);
    }

    /**
     * The statuses a status replies to, and the replies under it, that the viewer may see.
     * @see https://docs.joinmastodon.org/methods/statuses/#context
     */
    context(id: string, options?: CallOptions): Promise<Context> {
        return this.http.json(Context, "GET", path`/api/v1/statuses/${id}/context`, options);
    }

    /**
     * What a status said before each edit, oldest first, and what it says now.
     * @see https://docs.joinmastodon.org/methods/statuses/#history
     */
    history(id: string, options?: CallOptions): Promise<StatusEdit[]> {
        return this.http.json(
            z.array(StatusEdit),
            "GET",
            path`/api/v1/statuses/${id}/history`,
            options,
        );
    }

    /**
     * Likes a status.
     * @see https://docs.joinmastodon.org/methods/statuses/#favourite
     */
    favourite(id: string, options?: CallOptions): Promise<Status> {
        return this.act(id, "favourite", options);
    }

    /**
     * Undoes the viewer's like of a status.
     * @see https://docs.joinmastodon.org/methods/statuses/#unfavourite
     */
    unfavourite(id: string, options?: CallOptions): Promise<Status> {
        return this.act(id, "unfavourite", options);
    }

    /**
     * The accounts that like a status, newest first.
     * @see https://docs.joinmastodon.org/methods/statuses/#favourited_by
     */
    favouritedBy(id: string, query: PageQuery = {}, options?: CallOptions): Promise<Page<Account>> {
        return Page.get(
            this.http,
            Account,
            path`/api/v1/statuses/${id}/favourited_by`,
            query,
            options,
        );
    }

    /**
     * Shares a public or unlisted status. Gives the share, with the status as its `reblog`.
     * @see https://docs.joinmastodon.org/methods/statuses/#boost
     */
    reblog(id: string, reblog: ReblogOptions = {}, options?: CallOptions): Promise<Status> {
        return this.act(id, "reblog", { ...options, json: reblog });
    }

    /**
     * Undoes the viewer's share of a status. Gives the status.
     * @see https://docs.joinmastodon.org/methods/statuses/#unreblog
     */
    unreblog(id: string, options?: CallOptions): Promise<Status> {
        return this.act(id, "unreblog", options);
    }

    /**
     * The accounts that share a status publicly, newest first.
     * @see https://docs.joinmastodon.org/methods/statuses/#reblogged_by
     */
    rebloggedBy(id: string, query: PageQuery = {}, options?: CallOptions): Promise<Page<Account>> {
        return Page.get(
            this.http,
            Account,
            path`/api/v1/statuses/${id}/reblogged_by`,
            query,
            options,
        );
    }

    /**
     * Pins one of the viewer's public, unlisted or private statuses to their profile, up to 5.
     * @see https://docs.joinmastodon.org/methods/statuses/#pin
     */
    pin(id: string, options?: CallOptions): Promise<Status> {
        return this.act(id, "pin", options);
    }

    /**
     * Unpins a status from the viewer's profile.
     * @see https://docs.joinmastodon.org/methods/statuses/#unpin
     */
    unpin(id: string, options?: CallOptions): Promise<Status> {
        return this.act(id, "unpin", options);
    }

    /**
     * Mutes the thread of a status for the viewer, who then isn't notified about it.
     * @see https://docs.joinmastodon.org/methods/statuses/#mute
     */
    mute(id: string, options?: CallOptions): Promise<Status> {
        return this.act(id, "mute", options);
    }

    /**
     * Unmutes the thread of a status for the viewer.
     * @see https://docs.joinmastodon.org/methods/statuses/#unmute
     */
    unmute(id: string, options?: CallOptions): Promise<Status> {
        return this.act(id, "unmute", options);
    }

    /**
     * Bookmarks a status, or the status a boost boosts, for the viewer alone.
     * @see https://docs.joinmastodon.org/methods/statuses/#bookmark
     */
    bookmark(id: string, options?: CallOptions): Promise<Status> {
        return this.act(id, "bookmark", options);
    }

    /**
     * Removes the viewer's bookmark of a status.
     * @see https://docs.joinmastodon.org/methods/statuses/#unbookmark
     */
    unbookmark(id: string, options?: CallOptions): Promise<Status> {
        return this.act(id, "unbookmark", options);
    }

    /**
     * The reactions to a status, by emoji, with how many made each. Mastodon has no reactions to
     * statuses.
     */
    reactions(id: string, options?: CallOptions): Promise<StatusReaction[]> {
        return this.http.json(
            z.array(StatusReaction),
            "GET",
            path`/api/v1/statuses/${id}/reactions`,
            options,
        );
    }

    /**
     * Reacts to a status with an emoji: a Unicode one, or one of the instance's custom ones, by its
     * shortcode in colons, such as `:blobcat:`. Another instance's custom emojis can't be used.
     */
    react(id: string, emoji: string, options?: CallOptions): Promise<Status> {
        return this.http.json(
            Status,
            "PUT",
            path`/api/v1/statuses/${id}/reactions/${emoji}`,
            options,
        );
    }

    /** Undoes the viewer's reaction to a status with an emoji, named as `react` names it. */
    unreact(id: string, emoji: string, options?: CallOptions): Promise<Status> {
        return this.http.json(
            Status,
            "DELETE",
            path`/api/v1/statuses/${id}/reactions/${emoji}`,
            options,
        );
    }

    /**
     * The accounts that reacted to a status with an emoji, newest first. The emoji is named as the
     * status's reactions name it, which for another instance's custom one adds its domain, such as
     * `:blob@b.example:`.
     */
    reactedBy(
        id: string,
        emoji: string,
        query: PageQuery = {},
        options?: CallOptions,
    ): Promise<Page<Account>> {
        return Page.get(
            this.http,
            Account,
            path`/api/v1/statuses/${id}/reactions/${emoji}`,
            query,
            options,
        );
    }

    /** Does `action` to a status, and gives it. */
    private act(
        id: string,
        action: string,
        options?: CallOptions & { readonly json?: unknown },
    ): Promise<Status> {
        return this.http.json(Status, "POST", path`/api/v1/statuses/${id}/${action}`, options);
    }
}

/** The statuses the viewer likes. Like and unlike them with `statuses`. */
export class FavouriteMethods {
    constructor(private readonly http: Http) {}

    /**
     * The statuses the viewer likes and may still see, the latest liked first.
     * @see https://docs.joinmastodon.org/methods/favourites/#get
     */
    list(query: PageQuery = {}, options?: CallOptions): Promise<Page<Status>> {
        return Page.get(this.http, Status, "/api/v1/favourites", query, options);
    }
}

/** The statuses the viewer bookmarked. Bookmark and unbookmark them with `statuses`. */
export class BookmarkMethods {
    constructor(private readonly http: Http) {}

    /**
     * The statuses the viewer bookmarked and may still see, the latest bookmarked first.
     * @see https://docs.joinmastodon.org/methods/bookmarks/#get
     */
    list(query: PageQuery = {}, options?: CallOptions): Promise<Page<Status>> {
        return Page.get(this.http, Status, "/api/v1/bookmarks", query, options);
    }
}
