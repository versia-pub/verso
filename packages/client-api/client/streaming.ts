/**
 * Events as they happen, over one WebSocket for any number of streams.
 * @see https://docs.joinmastodon.org/methods/streaming/
 * @module
 */
import { z } from "zod";
import { Conversation } from "../conversation.ts";
import { Notification } from "../notification.ts";
import { Status } from "../status.ts";
import { ApiError, type CallOptions, type Http, UnexpectedResponse } from "./http.ts";

/** The streams Verso has, which are Mastodon's. */
export type StreamName =
    | "user"
    | "user:notification"
    | "public"
    | "public:media"
    | "public:local"
    | "public:local:media"
    | "public:remote"
    | "public:remote:media"
    | "hashtag"
    | "hashtag:local"
    | "list"
    | "direct";

/**
 * A stream to subscribe to, with its hashtag, without the `#`, if it is a hashtag's, or its list's
 * id, if it is a list's.
 */
export type Subscription = {
    readonly stream: StreamName;
    readonly tag?: string;
    readonly list?: string;
};

/**
 * What happened, and in which stream, as its name and, for a hashtag's or a list's, the hashtag or
 * the list's id. An event in
 * several streams the client subscribed to comes once for each.
 */
export type StreamEvent =
    | {
        /** A status, or a share, was posted, or for `status.update`, edited. */
        readonly event: "update" | "status.update";
        readonly stream: readonly string[];
        readonly status: Status;
    }
    | {
        /** A status, or a share, was deleted. */
        readonly event: "delete";
        readonly stream: readonly string[];
        readonly id: string;
    }
    | {
        readonly event: "notification";
        readonly stream: readonly string[];
        readonly notification: Notification;
    }
    | {
        /** The viewer's filters changed, so the statuses an app has may match others now. */
        readonly event: "filters_changed";
        readonly stream: readonly string[];
    }
    | {
        /** The notification requests the viewer accepted were merged into their notifications. */
        readonly event: "notifications_merged";
        readonly stream: readonly string[];
    }
    | {
        /** A direct conversation has a new status, lost its latest, or was marked read or unread. */
        readonly event: "conversation";
        readonly stream: readonly string[];
        readonly conversation: Conversation;
    }
    | {
        /** An event this client doesn't know, which Mastodon may have and Verso may later. */
        readonly event: "unknown";
        readonly stream: readonly string[];
        readonly name: string;
        readonly payload: string;
    }
    | {
        /** The instance refused a subscription, or an unsubscription. */
        readonly event: "error";
        readonly error: string;
        /** As HTTP would say it, such as 401 for a stream the token's scopes don't allow. */
        readonly status: number | undefined;
    };

/** How the WebSocket closed, as it said. */
export type Closed = { readonly code: number; readonly reason: string };

export type ConnectOptions = Pick<CallOptions, "signal"> & {
    /** The streams to subscribe to at once. More can be subscribed to later. */
    readonly subscribe?: readonly Subscription[];
    /**
     * Where the instance streams, as its `configuration.urls.streaming` says. Defaults to the
     * instance's own URL, where Verso streams.
     */
    readonly url?: string | URL;
};

/** `text` as JSON, or `undefined` if it isn't any. */
const jsonOf = (text: unknown): unknown => {
    try {
        return typeof text === "string" ? JSON.parse(text) : undefined;
    } catch {
        return undefined;
    }
};

/** What the instance sends: an event of the streams it is in, or why a subscription was refused. */
const Message = z.union([
    z.object({ error: z.string(), status: z.int().optional() }),
    // Events such as `filters_changed` have no payload.
    z.object({ stream: z.array(z.string()), event: z.string(), payload: z.string().default("") }),
]);

/** The event a message from the instance is, or throws if it isn't one. */
const eventOf = (data: unknown): StreamEvent => {
    const message = Message.safeParse(jsonOf(data));
    if (!message.success) throw new UnexpectedResponse(101, message.error.issues);
    if ("error" in message.data) {
        return { event: "error", error: message.data.error, status: message.data.status };
    }

    const { stream, event, payload } = message.data;

    const parsed = <S extends z.ZodType>(schema: S): z.output<S> => {
        const result = schema.safeParse(jsonOf(payload));
        if (!result.success) throw new UnexpectedResponse(101, result.error.issues);

        return result.data;
    };

    switch (event) {
        case "update":
        case "status.update":
            return { event, stream, status: parsed(Status) };
        case "delete":
            return { event, stream, id: payload };
        case "notification":
            return { event, stream, notification: parsed(Notification) };
        case "filters_changed":
            return { event, stream };
        case "conversation":
            return { event, stream, conversation: parsed(Conversation) };
        case "notifications_merged":
            return { event, stream };
        default:
            return { event: "unknown", stream, name: event, payload };
    }
};

/**
 * A WebSocket to an instance's streaming API. Iterating it with `for await` gives its events, as
 * they come, until it closes; only one loop should iterate it. A message that isn't what the
 * instance should send ends the loop with an `UnexpectedResponse`, and closes the WebSocket.
 */
export class Stream implements AsyncIterable<StreamEvent>, AsyncDisposable {
    readonly #socket: WebSocket;
    readonly #queue: (StreamEvent | Error)[] = [];
    #wake: (() => void) | undefined;
    #done = false;

    /** How the WebSocket closed, once it has. */
    readonly closed: Promise<Closed>;

    constructor(socket: WebSocket) {
        this.#socket = socket;

        socket.onmessage = (message) => {
            try {
                this.#push(eventOf(message.data));
            } catch (error) {
                this.#push(error instanceof Error ? error : new Error(String(error)));
                socket.close(1003, "Not a streaming event");
            }
        };

        this.closed = new Promise((resolve) => {
            socket.addEventListener("close", ({ code, reason }) => {
                this.#done = true;
                this.#push();
                resolve({ code, reason });
            });
        });
    }

    /** Subscribes to a stream, such as `{ stream: "hashtag", tag: "cats" }`. */
    subscribe(subscription: Subscription): void {
        this.#socket.send(JSON.stringify({ type: "subscribe", ...subscription }));
    }

    /** Unsubscribes from a stream. */
    unsubscribe(subscription: Subscription): void {
        this.#socket.send(JSON.stringify({ type: "unsubscribe", ...subscription }));
    }

    /** Closes the WebSocket, which ends the loop iterating it. */
    close(): Promise<Closed> {
        this.#socket.close(1000);

        return this.closed;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
        while (true) {
            const next = this.#queue.shift();
            if (next instanceof Error) throw next;
            if (next !== undefined) {
                yield next;
                continue;
            }
            if (this.#done) return;

            await new Promise<void>((resolve) => this.#wake = resolve);
        }
    }

    /** Queues `item`, if any, and wakes the loop. */
    #push(item?: StreamEvent | Error): void {
        if (item !== undefined) this.#queue.push(item);
        this.#wake?.();
        this.#wake = undefined;
    }
}

/** Events as they happen, over a WebSocket. */
export class StreamingMethods {
    constructor(private readonly http: Http) {}

    /**
     * Whether the instance's streaming is up.
     * @see https://docs.joinmastodon.org/methods/streaming/#health
     */
    async health(options?: CallOptions): Promise<boolean> {
        try {
            await this.http.send("GET", "/api/v1/streaming/health", options);
            return true;
        } catch (error) {
            if (error instanceof ApiError) return false;
            throw error;
        }
    }

    /**
     * Opens a WebSocket to the instance's streaming API, as the viewer, once it is open. The token
     * is sent as the WebSocket's protocol, as browsers can send it, rather than in the URL, where
     * it would be logged.
     * @see https://docs.joinmastodon.org/methods/streaming/#websocket
     */
    async connect(options: ConnectOptions = {}): Promise<Stream> {
        const url = new URL("/api/v1/streaming", options.url ?? this.http.url);
        url.protocol = url.protocol === "http:" ? "ws:" : "wss:";

        const socket = new WebSocket(url, this.http.token === undefined ? [] : [this.http.token]);
        const stream = new Stream(socket);

        await new Promise<void>((resolve, reject) => {
            const abort = () => {
                socket.close();
                reject(options.signal?.reason);
            };
            options.signal?.addEventListener("abort", abort, { once: true });

            socket.addEventListener("open", () => {
                options.signal?.removeEventListener("abort", abort);
                resolve();
            });
            socket.addEventListener("close", ({ code, reason }) => {
                options.signal?.removeEventListener("abort", abort);
                reject(new Error(`The WebSocket to ${url} closed: ${code} ${reason}`));
            });
        });

        for (const subscription of options.subscribe ?? []) stream.subscribe(subscription);

        return stream;
    }
}
