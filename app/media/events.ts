/**
 * Events about media for the rest of Verso: uploads processed.
 * @module
 */
import type { DomainEvent } from "../kernel/context.ts";

/**
 * A local image finished processing: it was stored, so it can be shown, or it couldn't be processed
 * and was removed.
 */
export type MediaProcessed = {
    readonly type: "media.processed";
    readonly mediaId: string;
    /** Whether it was stored. */
    readonly stored: boolean;
};

export const isMediaProcessed = (event: DomainEvent): event is MediaProcessed =>
    event.type === "media.processed";
