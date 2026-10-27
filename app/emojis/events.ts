/**
 * Events about custom emojis for the rest of Verso: local emojis deleted.
 * @module
 */
import type { DomainEvent } from "../kernel/context.ts";

/**
 * A local emoji is being deleted. It is emitted before the emoji is, in the same transaction, so
 * subscribers can still find what uses it.
 */
export type EmojiDeleted = {
    readonly type: "emojis.deleted";
    readonly emojiId: string;
};

export const isEmojiDeleted = (event: DomainEvent): event is EmojiDeleted =>
    event.type === "emojis.deleted";
