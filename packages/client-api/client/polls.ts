import { Poll } from "../poll.ts";
import { type CallOptions, type Http, path } from "./http.ts";

/** Viewing and voting in the polls attached to statuses. */
export class PollMethods {
    constructor(private readonly http: Http) {}

    /**
     * A poll, if the viewer may see its status.
     * @see https://docs.joinmastodon.org/methods/polls/#get
     */
    get(id: string, options?: CallOptions): Promise<Poll> {
        return this.http.json(Poll, "GET", path`/api/v1/polls/${id}`, options);
    }

    /**
     * Votes for the options `choices`, by index from 0, returning the poll with the vote counted.
     * @see https://docs.joinmastodon.org/methods/polls/#vote
     */
    vote(id: string, choices: readonly number[], options?: CallOptions): Promise<Poll> {
        return this.http.json(Poll, "POST", path`/api/v1/polls/${id}/votes`, {
            ...options,
            json: { choices },
        });
    }
}
