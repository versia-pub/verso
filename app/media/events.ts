/**
 * Events about media for the rest of Verso: uploads processed.
 * @module
 */
import type { DomainEvent } from "../kernel/context.ts";

/** A local image was processed and stored, so it can be shown. */
export type MediaProcessed = {
    readonly type: "media.processed";
    readonly mediaId: string;
};

export const isMediaProcessed = (event: DomainEvent): event is MediaProcessed =>
    event.type === "media.processed";
