/**
 * Blocking instances, for moderators with the `federation` permission. Blocks from the config file
 * are listed too, with ids of their own, but can only be changed there.
 * @see https://docs.joinmastodon.org/methods/admin/domain_blocks/
 * @module
 */
import { AdminDomainBlock } from "@versia/client-api";
import { canonicalizeDomain } from "@versia/protocol";
import { z } from "zod";
import { HttpError, NotFound, NotPermitted, Unprocessable } from "../http/errors.ts";
import { cursorsOf, PageQuery } from "../http/paging.ts";
import { Paged } from "../http/responses.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Flag } from "../http/schemas.ts";
import type { Context } from "../kernel/context.ts";
import {
    type DomainBlock,
    type DomainBlockNotes,
    findDomainBlock,
    findDomainBlockOf,
    listBlockedDomains,
    updateDomainBlock,
} from "./domain_block_queries.ts";
import { blockDomain, domainDigest, unblockDomain } from "./domain_blocks.ts";

const docs = "https://docs.joinmastodon.org/methods/admin/domain_blocks";

const read = {
    require: "user",
    scope: "admin:read:domain_blocks",
    permission: "federation",
} as const;
const write = {
    require: "user",
    scope: "admin:write:domain_blocks",
    permission: "federation",
} as const;

/** What the id of a block from the config file starts with, before its domain. */
const configPrefix = "config:";

/** When blocks from the config file were made, which Verso doesn't know. */
const configCreatedAt = new Date(0);

const Id = z.object({ id: z.string() });

/** What creating or changing a block notes. Verso only blocks with `suspend`. */
const Notes = z.object({
    severity: z.enum(["silence", "suspend", "noop"]).optional(),
    reject_media: Flag.optional(),
    reject_reports: Flag.optional(),
    private_comment: z.string().nullable().optional(),
    public_comment: z.string().nullable().optional(),
    obfuscate: Flag.optional(),
});

/** A create that would block a domain twice. Mastodon's body names the block there is. */
class AlreadyBlocked extends HttpError {
    constructor(readonly existing: AdminDomainBlock) {
        super(422, `You have already imposed stricter limits on ${existing.domain}.`);
    }

    override toJSON(): Record<string, unknown> {
        return { error: this.message, existing_domain_block: this.existing };
    }
}

/** A block as moderators see it. */
const shown = async (block: DomainBlock): Promise<AdminDomainBlock> => ({
    id: block.id,
    domain: block.domain,
    digest: await domainDigest(block.domain),
    created_at: block.created_at.toISOString(),
    severity: "suspend",
    reject_media: true,
    reject_reports: true,
    private_comment: block.private_comment,
    public_comment: block.reason === "" ? null : block.reason,
    obfuscate: block.obfuscate,
});

/** A block from the config file as moderators see it. */
const shownFromConfig = async (domain: string): Promise<AdminDomainBlock> => ({
    id: `${configPrefix}${domain}`,
    domain,
    digest: await domainDigest(domain),
    created_at: configCreatedAt.toISOString(),
    severity: "suspend",
    reject_media: true,
    reject_reports: true,
    private_comment: null,
    public_comment: null,
    obfuscate: false,
});

/**
 * Negative if the block with id `a` is listed before the one with id `b`: the stored ones newest
 * first, then the config file's by domain. Works for ids that no longer exist.
 */
const listOrder = (a: string, b: string): number => {
    const aFromConfig = a.startsWith(configPrefix);
    const bFromConfig = b.startsWith(configPrefix);
    if (aFromConfig !== bFromConfig) return aFromConfig ? 1 : -1;

    const ascending = a < b ? -1 : a > b ? 1 : 0;

    return aFromConfig ? ascending : -ascending;
};

/** The page of `blocks`, in list order, that `query` asks for. */
const pageOf = <T extends { readonly id: string }>(blocks: readonly T[], query: PageQuery): T[] => {
    const { max_id: maxId, since_id: sinceId, min_id: minId } = query;
    const inRange = blocks.filter((block) =>
        (maxId === undefined || listOrder(block.id, maxId) > 0) &&
        (sinceId === undefined || listOrder(block.id, sinceId) < 0) &&
        (minId === undefined || listOrder(block.id, minId) < 0)
    );

    // Just after `min_id`, rather than from the start of the list.
    return minId === undefined ? inRange.slice(0, query.limit) : inRange.slice(-query.limit);
};

/** What `body` notes, as the stored block keeps it. */
const notesOf = (body: z.output<typeof Notes>): DomainBlockNotes => ({
    reason: body.public_comment === undefined ? undefined : body.public_comment ?? "",
    privateComment: body.private_comment,
    obfuscate: body.obfuscate,
});

/** Throws unless `severity` is one Verso blocks with. */
const checkSeverity = (severity: string | undefined): void => {
    if (severity !== "suspend") throw new Unprocessable("Verso only blocks with severity suspend");
};

/** The admin API's domain block routes, which list `configured` as blocks of their own. */
export const adminDomainBlockRoutes = (configured: readonly string[]): readonly Route[] => {
    /** The stored block `id`, or a 403 for a block from the config file, or a 404. */
    const stored = async (ctx: Context, id: string) => {
        if (id.startsWith(configPrefix)) {
            throw new NotPermitted("Blocks from the config file can only be changed there");
        }

        const block = await findDomainBlock(ctx, id);
        if (block === undefined) throw new NotFound();

        return block;
    };

    /** The stored block of `domain`, or the config file's, if there is one. */
    const existing = async (ctx: Context, domain: string) => {
        if (configured.includes(domain)) return await shownFromConfig(domain);

        const block = await findDomainBlockOf(ctx, domain);
        return block && await shown(block);
    };

    return [
        defineRoute({
            method: "GET",
            path: "/api/v1/admin/domain_blocks",
            summary: "List all blocked domains",
            description: "Show information about all blocked domains.",
            docs: `${docs}/#get`,
            tags: ["admin"],
            auth: read,
            query: PageQuery({ default: 100, max: 500 }),
            responses: { 200: Paged(AdminDomainBlock) },
            handler: async (ctx, { query }) => {
                const fromConfig = configured.toSorted()
                    .map((domain) => ({
                        id: `${configPrefix}${domain}`,
                        domain,
                        stored: undefined,
                    }));
                const fromAdmins = (await listBlockedDomains(ctx))
                    .map((stored) => ({ id: stored.id, domain: stored.domain, stored }))
                    .toSorted((a, b) => listOrder(a.id, b.id));
                const page = pageOf([...fromAdmins, ...fromConfig], query);

                return {
                    status: 200,
                    body: await Promise.all(
                        page.map((block) =>
                            block.stored === undefined
                                ? shownFromConfig(block.domain)
                                : shown(block.stored)
                        ),
                    ),
                    cursors: cursorsOf(page, query, (block) => block.id),
                };
            },
        }),
        defineRoute({
            method: "GET",
            path: "/api/v1/admin/domain_blocks/:id",
            summary: "Get a single blocked domain",
            description: "Show information about a single blocked domain.",
            docs: `${docs}/#get-one`,
            tags: ["admin"],
            auth: read,
            params: Id,
            responses: { 200: AdminDomainBlock },
            handler: async (ctx, { params }) => {
                if (params.id.startsWith(configPrefix)) {
                    const domain = params.id.slice(configPrefix.length);
                    if (!configured.includes(domain)) throw new NotFound();

                    return { status: 200, body: await shownFromConfig(domain) };
                }

                const block = await findDomainBlock(ctx, params.id);
                if (block === undefined) throw new NotFound();

                return { status: 200, body: await shown(block) };
            },
        }),
        defineRoute({
            method: "POST",
            path: "/api/v1/admin/domain_blocks",
            summary: "Block a domain from federating",
            description: "Add a domain to the list of domains blocked from federating.",
            docs: `${docs}/#create`,
            tags: ["admin"],
            auth: write,
            body: Notes.extend({ domain: z.string() }),
            responses: { 200: AdminDomainBlock },
            handler: async (ctx, { body }) => {
                const domain = canonicalizeDomain(body.domain);
                if (domain === undefined) throw new Unprocessable(`${body.domain} isn't a domain`);
                checkSeverity(body.severity);

                const before = await existing(ctx, domain);
                if (before !== undefined) throw new AlreadyBlocked(before);

                const block = await blockDomain(ctx, domain, notesOf(body));
                if (block === undefined) {
                    // Another request blocked it first.
                    const raced = await existing(ctx, domain);
                    if (raced === undefined) throw new Error(`${domain} wasn't blocked`);
                    throw new AlreadyBlocked(raced);
                }

                return { status: 200, body: await shown(block) };
            },
        }),
        defineRoute({
            method: "PUT",
            path: "/api/v1/admin/domain_blocks/:id",
            summary: "Update a domain block",
            description: "Change parameters for an existing domain block.",
            docs: `${docs}/#update`,
            tags: ["admin"],
            auth: write,
            params: Id,
            body: Notes,
            responses: { 200: AdminDomainBlock },
            handler: async (ctx, { params, body }) => {
                const block = await stored(ctx, params.id);
                if (body.severity !== undefined) checkSeverity(body.severity);

                const notes = notesOf(body);
                const changed = Object.values(notes).some((value) => value !== undefined)
                    ? await updateDomainBlock(ctx, block.id, notes)
                    : block;
                if (changed === undefined) throw new NotFound();

                return { status: 200, body: await shown(changed) };
            },
        }),
        defineRoute({
            method: "DELETE",
            path: "/api/v1/admin/domain_blocks/:id",
            summary: "Remove a domain block",
            description: "Lift a block against a domain.",
            docs: `${docs}/#delete`,
            tags: ["admin"],
            auth: write,
            params: Id,
            responses: { 200: z.strictObject({}) },
            handler: async (ctx, { params }) => {
                const block = await stored(ctx, params.id);
                await unblockDomain(ctx, block.domain);

                return { status: 200, body: {} };
            },
        }),
    ];
};
