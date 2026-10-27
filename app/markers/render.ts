/**
 * Markers as the client API renders them.
 * @module
 */
import type { Marker, Markers } from "@versia/client-api";
import type { MarkerRow } from "./marker_queries.ts";

const renderMarker = (row: MarkerRow): Marker => ({
    last_read_id: row.last_read_id,
    version: row.version,
    updated_at: row.updated_at.toISOString(),
});

/** Markers, by their timelines. */
export const renderMarkers = (rows: readonly MarkerRow[]): Markers =>
    Object.fromEntries(rows.map((row) => [row.timeline, renderMarker(row)]));
