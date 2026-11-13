/** Resolves after `ms` milliseconds. */
export const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `done` resolves true, or long enough that it won't. */
export const until = async (done: () => boolean | Promise<boolean>): Promise<void> => {
    const started = Date.now();
    while (!await done() && Date.now() - started < 5_000) await delay(5);
};
