/** Where the current time comes from. Code never calls `Date.now()` itself, so tests can control time. */
export interface Clock {
    now(): Date;
}

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
