/**
 * Where the current time comes from. Code never calls `Date.now()` itself, so tests can control
 * time.
 */
export interface Clock {
    now(): Date;
}

/** An hour and a day, in milliseconds. */
export const hourMs = 60 * 60 * 1000;
export const dayMs = 24 * hourMs;

export const systemClock: Clock = { now: () => new Date() };

/** A clock for tests. Time stands still until `advance` moves it on. */
export interface FakeClock extends Clock {
    advance(milliseconds: number): void;
}

export const fakeClock = (
    start = new Date("2026-01-01T00:00:00Z"),
): FakeClock => {
    let time = start.getTime();
    return {
        now: () => new Date(time),
        advance: (milliseconds) => {
            time += milliseconds;
        },
    };
};
