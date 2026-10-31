import { assertEquals } from "@std/assert";
import { createLocalAccount } from "../accounts/testing.ts";
import { tokenFor } from "../auth/testing.ts";
import { createLocalEmoji } from "../emojis/testing.ts";
import { block } from "../graph/blocks.ts";
import { defaultSettings } from "../instances/testing.ts";
import { noteRoutes } from "../notes/routes.ts";
import { createTestApp } from "../testing/app.ts";
import { createTestContext } from "../testing/context.ts";
import { pollRoutes } from "./routes.ts";

/** alice, bob and carol, local users, with the default poll limits. */
const open = async () => {
    const test = await createTestContext();
    const app = createTestApp(test.ctx, [...noteRoutes(defaultSettings().limits), ...pollRoutes], {
        checkResponses: true,
    });
    for (const id of ["alice", "bob", "carol"]) await createLocalAccount(test.ctx, id);

    /** Sends a request as `as`, or as nobody if it is `null`, in JSON, or as a form if a string. */
    const request = async (
        method: string,
        path: string,
        body?: Record<string, unknown> | string,
        as: string | null = "alice",
    ) => {
        const response = await app.request(path, {
            method,
            headers: {
                ...as === null ? {} : { authorization: `Bearer ${await tokenFor(test.ctx, as)}` },
                "content-type": typeof body === "string"
                    ? "application/x-www-form-urlencoded"
                    : "application/json",
            },
            body: typeof body === "string" ? body : JSON.stringify(body),
        });

        return { status: response.status, body: await response.json() };
    };

    /** Posts a public status with a poll as alice, returning the poll's id. */
    const ask = async (poll: Record<string, unknown> = {}) => {
        const posted = await request("POST", "/api/v1/statuses", {
            status: "Which?",
            poll: { options: ["Red", "Blue", "Green"], expires_in: 3600, ...poll },
        });
        if (posted.status !== 200) throw new Error(JSON.stringify(posted.body));
        return { statusId: posted.body.id as string, pollId: posted.body.poll.id as string };
    };

    /** Votes as `as` for `choices`, returning the status and what was voted for. */
    const vote = (pollId: string, choices: unknown, as = "bob") =>
        request("POST", `/api/v1/polls/${pollId}/votes`, { choices }, as);

    /** The poll as `as` sees it, or as anyone does if `null`. */
    const poll = async (pollId: string, as: string | null = "alice") =>
        (await request("GET", `/api/v1/polls/${pollId}`, undefined, as)).body;

    return { ...test, request, ask, vote, poll };
};

/** Each option's title and votes. */
const tally = (poll: { options: { title: string; votes_count: number | null }[] }) =>
    poll.options.map((option) => `${option.title} ${option.votes_count}`);

Deno.test("a status is posted with a poll, which anyone who may see it can view", async () => {
    await using test = await open();

    const posted = await test.request(
        "POST",
        "/api/v1/statuses",
        "status=Which?&poll[options][]= Red &poll[options][]=&poll[options][]=Blue" +
            "&poll[expires_in]=600&poll[multiple]=true",
    );
    assertEquals(posted.status, 200);
    const { poll } = posted.body;
    assertEquals(
        [poll.expires_at, poll.expired, poll.multiple, poll.votes_count, poll.voters_count],
        [new Date(test.ctx.clock.now().getTime() + 600_000).toISOString(), false, true, 0, 0],
    );
    assertEquals(tally(poll), ["Red 0", "Blue 0"]);
    // Its author counts as having voted, as on Mastodon.
    assertEquals([poll.voted, poll.own_votes], [true, []]);

    assertEquals(await test.poll(poll.id), poll);
    const anyone = await test.poll(poll.id, null);
    assertEquals([anyone.voted, anyone.own_votes, anyone.options], [
        undefined,
        undefined,
        poll.options,
    ]);
    assertEquals((await test.request("GET", "/api/v1/polls/nope")).status, 404);

    const hidden = await test.request("POST", "/api/v1/statuses", {
        status: "Secret?",
        visibility: "private",
        poll: { options: ["Yes", "No"], expires_in: 600 },
    });
    assertEquals(
        (await test.request("GET", `/api/v1/polls/${hidden.body.poll.id}`, undefined, "bob"))
            .status,
        404,
    );
    assertEquals((await test.vote(hidden.body.poll.id, [0])).status, 404);
    assertEquals((await test.poll(hidden.body.poll.id)).votes_count, 0);
});

Deno.test("polls are limited as the instance says, and can't come with media", async () => {
    await using test = await open();
    const rejected = async (poll: Record<string, unknown>, extra = {}) => {
        const posted = await test.request("POST", "/api/v1/statuses", {
            status: "Which?",
            poll: { options: ["a", "b"], expires_in: 600, ...poll },
            ...extra,
        });
        return posted.body.details ?? posted.body.error_description ?? posted.status;
    };

    assertEquals(await rejected({ options: ["a", " "] }), {
        "body.poll.options": ["Must have at least 2 options"],
    });
    assertEquals(await rejected({ options: Array.from({ length: 21 }, (_, i) => `${i}`) }), {
        "body.poll.options": ["Must have at most 20 options"],
    });
    assertEquals(await rejected({ options: ["a", "a "] }), {
        "body.poll.options": ["Must not have the same option twice"],
    });
    assertEquals(await rejected({ options: ["a", "b".repeat(61)] }), {
        "body.poll.options.1": ["Must be at most 60 characters"],
    });
    assertEquals(await rejected({ expires_in: 299 }), {
        "body.poll.expires_in": ["Must be at least 300 seconds"],
    });
    assertEquals(await rejected({ expires_in: 2_629_747 }), {
        "body.poll.expires_in": ["Must be at most 2629746 seconds"],
    });
    assertEquals(
        await rejected({}, { media_ids: ["1"] }),
        "A status can't have both media and a poll",
    );
    assertEquals(
        await rejected({
            options: Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(60, "x")),
            expires_in: 2_629_746,
        }),
        200,
    );
});

Deno.test("a vote is counted once per account, and once per option in a poll of several", async () => {
    await using test = await open();
    const single = await test.ask();

    const voted = await test.vote(single.pollId, [1]);
    assertEquals(voted.status, 200);
    assertEquals(tally(voted.body), ["Red 0", "Blue 1", "Green 0"]);
    assertEquals([voted.body.voted, voted.body.own_votes], [true, [1]]);
    assertEquals((await test.poll(single.pollId)).voted, true);
    assertEquals((await test.poll(single.pollId, "carol")).voted, false);

    // As Mastodon words its errors.
    const refused = async (pollId: string, choices: unknown, as = "bob") =>
        (await test.vote(pollId, choices, as)).body.error_description;
    assertEquals(await refused(single.pollId, [0]), "You have already voted on this poll");
    assertEquals(
        await refused(single.pollId, [0, 1], "carol"),
        "You have already voted on this poll",
    );
    assertEquals(
        await refused(single.pollId, [3], "carol"),
        "The chosen vote option does not exist",
    );
    assertEquals(
        await refused(single.pollId, [-1], "carol"),
        "The chosen vote option does not exist",
    );
    assertEquals(await refused(single.pollId, [0], "alice"), "You cannot vote in your own polls");
    assertEquals((await test.vote(single.pollId, [])).status, 422);

    const several = await test.ask({ multiple: true });
    // As a form sends one choice.
    const form = await test.request(
        "POST",
        `/api/v1/polls/${several.pollId}/votes`,
        "choices[]=0",
        "bob",
    );
    assertEquals(form.body.own_votes, [0]);
    assertEquals(await refused(several.pollId, [0]), "You have already voted on this poll");
    assertEquals(await refused(several.pollId, [1, 1]), "You have already voted on this poll");
    assertEquals((await test.vote(several.pollId, [2, 1])).body.own_votes, [0, 1, 2]);
    const both = await test.vote(several.pollId, [0, 2], "carol");
    assertEquals(tally(both.body), ["Red 2", "Blue 1", "Green 2"]);
    assertEquals([both.body.votes_count, both.body.voters_count], [5, 2]);
});

Deno.test("a vote is refused once the poll has ended, or between accounts that block", async () => {
    await using test = await open();
    const { pollId } = await test.ask();

    await block(test.ctx, "alice", "carol");
    assertEquals((await test.vote(pollId, [0], "carol")).status, 403);
    await block(test.ctx, "bob", "alice");
    assertEquals((await test.vote(pollId, [0], "bob")).status, 403);

    await createLocalAccount(test.ctx, "dave");
    test.clock.advance(3600_000);
    const ended = await test.vote(pollId, [0], "dave");
    assertEquals([ended.status, ended.body.error_description], [422, "The poll has already ended"]);
    assertEquals((await test.poll(pollId)).expired, true);
});

Deno.test("a poll that hides its totals shows them only once it ends", async () => {
    await using test = await open();
    const { pollId } = await test.ask({ hide_totals: true });

    const voted = await test.vote(pollId, [2]);
    assertEquals(tally(voted.body), ["Red null", "Blue null", "Green null"]);
    assertEquals([voted.body.votes_count, voted.body.voters_count], [1, 1]);
    assertEquals(tally(await test.poll(pollId)), ["Red null", "Blue null", "Green null"]);

    test.clock.advance(3600_000);
    assertEquals(tally(await test.poll(pollId)), ["Red 0", "Blue 0", "Green 1"]);
});

Deno.test("editing a poll keeps its votes unless it asks something else", async () => {
    await using test = await open();
    const { statusId, pollId } = await test.ask();
    await test.vote(pollId, [0]);
    const edit = (body: Record<string, unknown>) =>
        test.request("PUT", `/api/v1/statuses/${statusId}`, { status: "Which?", ...body });

    // Left out, it stays as it was.
    const text = await edit({ status: "Which one?" });
    assertEquals([text.body.poll.id, tally(text.body.poll)], [pollId, [
        "Red 1",
        "Blue 0",
        "Green 0",
    ]]);

    test.clock.advance(60_000);
    const later = await edit({
        status: "Which one?",
        poll: { options: ["Red", "Blue", "Green"], expires_in: 600 },
    });
    assertEquals(tally(later.body.poll), ["Red 1", "Blue 0", "Green 0"]);
    assertEquals(
        later.body.poll.expires_at,
        new Date(test.ctx.clock.now().getTime() + 600_000).toISOString(),
    );

    const multiple = await edit({
        poll: { options: ["Red", "Blue", "Green"], expires_in: 600, multiple: true },
    });
    assertEquals(
        [tally(multiple.body.poll), multiple.body.poll.voters_count],
        [["Red 0", "Blue 0", "Green 0"], 0],
    );
    await test.vote(pollId, [1]);
    const other = await edit({
        poll: { options: ["Red", "Blue"], expires_in: 600, multiple: true },
    });
    assertEquals(tally(other.body.poll), ["Red 0", "Blue 0"]);
    assertEquals((await test.poll(pollId, "bob")).own_votes, []);

    assertEquals(
        (await edit({ media_ids: ["1"] })).body.error_description,
        "A status can't have both media and a poll",
    );
    const removed = await edit({ poll: null });
    assertEquals(removed.body.poll, null);
    assertEquals((await test.request("GET", `/api/v1/polls/${pollId}`)).status, 404);

    const history = await test.request("GET", `/api/v1/statuses/${statusId}/history`);
    assertEquals(
        history.body.map((version: { poll?: { options: { title: string }[] } }) =>
            version.poll?.options.map((option) => option.title).join()
        ),
        [
            "Red,Blue,Green",
            "Red,Blue,Green",
            "Red,Blue,Green",
            "Red,Blue,Green",
            "Red,Blue",
            undefined,
        ],
    );
});

Deno.test("a poll that is sent again unchanged doesn't edit its status", async () => {
    await using test = await open();
    const { statusId } = await test.ask();

    const same = await test.request("PUT", `/api/v1/statuses/${statusId}`, {
        status: "Which?",
        poll: { options: ["Red", "Blue", "Green"], expires_in: 3600 },
    });
    assertEquals(same.body.edited_at, null);
    const hidden = await test.request("PUT", `/api/v1/statuses/${statusId}`, {
        status: "Which?",
        poll: { options: ["Red", "Blue", "Green"], expires_in: 3600, hide_totals: true },
    });
    assertEquals(tally(hidden.body.poll), ["Red null", "Blue null", "Green null"]);

    const history = await test.request("GET", `/api/v1/statuses/${statusId}/history`);
    assertEquals(history.body.at(-1).poll, {
        options: [{ title: "Red" }, { title: "Blue" }, { title: "Green" }],
    });
});

Deno.test("a poll's options may use custom emojis, which it lists", async () => {
    await using test = await open();
    for (const shortcode of ["red", "blue"]) await createLocalEmoji(test.ctx, shortcode);

    const posted = await test.request("POST", "/api/v1/statuses", {
        status: "Which? :blue:",
        poll: { options: [":red: Red", "Green"], expires_in: 600 },
    });
    assertEquals(
        posted.body.emojis.map((emoji: { shortcode: string }) => emoji.shortcode).sort(),
        ["blue", "red"],
    );
    assertEquals(
        posted.body.poll.emojis.map((emoji: { shortcode: string }) => emoji.shortcode),
        ["red"],
    );
});
