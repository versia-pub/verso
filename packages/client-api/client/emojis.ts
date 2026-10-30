import { z } from "zod";
import { CustomEmoji } from "../custom_emoji.ts";
import { VersiaEmoji } from "../versia_emoji.ts";
import { type CallOptions, type Http, path } from "./http.ts";

/** A new custom emoji. */
export type EmojiDraft = {
    /** Letters, digits and underscores, at least 2. */
    readonly shortcode: string;
    /** Its picture, of at most 256 KiB. */
    readonly element: Blob;
    readonly category?: string;
    /** Alt text, for those who can't see it. */
    readonly alt?: string;
    /** Whether it is for everyone, rather than the viewer's own. Needs the `emojis` permission. */
    readonly global?: boolean;
};

/** Changes to a custom emoji. What is omitted stays as it was. */
export type EmojiChanges = Partial<EmojiDraft>;

/**
 * The instance's custom emojis, and the viewer's own. Mastodon has only `list`; the others are
 * Versia Server's.
 */
export class EmojiMethods {
    constructor(private readonly http: Http) {}

    /**
     * The global custom emojis, and the viewer's own, which replace global ones of the same
     * shortcode.
     * @see https://docs.joinmastodon.org/methods/custom_emojis/#get
     */
    list(options?: CallOptions): Promise<CustomEmoji[]> {
        return this.http.json(z.array(CustomEmoji), "GET", "/api/v1/custom_emojis", options);
    }

    /** A custom emoji, if it is global or the viewer's, or the viewer has the `emojis` permission. */
    get(id: string, options?: CallOptions): Promise<VersiaEmoji> {
        return this.http.json(VersiaEmoji, "GET", path`/api/v1/emojis/${id}`, options);
    }

    /**
     * Adds a custom emoji. Its picture is processed after this returns, and until it is, its URLs
     * are `null` and statuses can't use it.
     */
    create(draft: EmojiDraft, options?: CallOptions): Promise<VersiaEmoji> {
        return this.http.json(VersiaEmoji, "POST", "/api/v1/emojis", { ...options, form: draft });
    }

    /**
     * Changes one of the viewer's custom emojis, or any with the `emojis` permission, which can
     * also make it global or not. Sent as a form if it has a picture, and as JSON if not.
     */
    update(id: string, changes: EmojiChanges, options?: CallOptions): Promise<VersiaEmoji> {
        return this.http.json(VersiaEmoji, "PATCH", path`/api/v1/emojis/${id}`, {
            ...options,
            ...changes.element === undefined ? { json: changes } : { form: changes },
        });
    }

    /**
     * Deletes one of the viewer's custom emojis, or any with the `emojis` permission. Statuses and
     * profiles stop using it, and local users' reactions with it are undone.
     */
    async delete(id: string, options?: CallOptions): Promise<void> {
        await this.http.send("DELETE", path`/api/v1/emojis/${id}`, options);
    }
}
