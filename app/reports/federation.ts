/**
 * Reports as Versia has them: local users' reports of remote accounts, which Verso sends on
 * anonymously when asked, as Mastodon does, and reports from other instances, which are stored for
 * the moderators with no reporter, but the instance that sent them.
 * @see https://versia.pub/extensions/reports
 * @see https://docs.joinmastodon.org/methods/reports/#post
 * @module
 */
import type { ReportCategory } from "@versia/client-api";
import { parseReference, v0_6 } from "@versia/protocol";
import { type AccountRow, findAccount, findAccounts } from "../accounts/account_queries.ts";
import { knownUser, userReferences } from "../accounts/federation.ts";
import { queueDeliveriesTo } from "../federation/deliver.ts";
import type { EntityType, Sender } from "../federation/registry.ts";
import type { Context, DomainEvent } from "../kernel/context.ts";
import { instanceMaySee } from "../notes/audience.ts";
import { findNotes, type NoteRow } from "../notes/note_queries.ts";
import { knownNoteRow } from "../notes/remote.ts";
import { noteReferenceMap } from "../notes/versia.ts";
import { isReportForwarded } from "./events.ts";
import { findReport, insertReceivedReport } from "./report_queries.ts";

const typeName = "pub.versia:reports/Report";

/** The most of a received report's comment that is kept, as on Mastodon. */
const commentLimit = 5000;

/**
 * The instances to send a report of `target` on to, of those at `domains`: `target`'s, and those of
 * the remote accounts that the reported `notes` reply to, as Mastodon sends it.
 */
const forwardInstances = async (
    ctx: Context,
    target: AccountRow,
    notes: readonly NoteRow[],
    domains: readonly string[],
) => {
    const repliedTo = await findAccounts(
        ctx,
        notes.flatMap((note) => note.in_reply_to_account_id ?? []),
    );
    const instances = [target, ...repliedTo]
        .filter((account) => account.domain !== null && domains.includes(account.domain))
        .flatMap((account) => account.instance_id ?? []);

    return [...new Set(instances)];
};

/**
 * Sends a local user's report of a remote account on to the instances they asked for, without
 * saying who filed it, with its category as its tag. This instance's rules aren't sent.
 */
export const reportDeliveries = async (ctx: Context, event: DomainEvent): Promise<void> => {
    if (!isReportForwarded(event)) return;

    const report = await findReport(ctx, event.reportId);
    const target = report && await findAccount(ctx, report.target_account_id);
    if (report === undefined || target === undefined) return;

    const notes = await findNotes(ctx, report.note_ids);
    const references = await noteReferenceMap(ctx, notes.map((note) => note.id));
    const entity: v0_6.Report = {
        type: typeName,
        created_at: report.created_at.toISOString(),
        reported: [
            ...await userReferences(ctx, [target.id]),
            ...report.note_ids.flatMap((id) => references.get(id) ?? []),
        ],
        tags: [report.category],
        ...report.comment !== "" && { comment: report.comment },
    };
    const instanceIds = await forwardInstances(ctx, target, notes, event.domains);
    await queueDeliveriesTo(ctx, entity, { instanceIds });
};

/** The category of a received report: the first of its tags that is one, other than `violation`. */
const categoryOf = (tags: readonly string[]): ReportCategory =>
    tags.find((tag): tag is "spam" | "legal" => tag === "spam" || tag === "legal") ?? "other";

/** What a received report names that Verso has: users by their account ids, and statuses. */
const reportedBy = async (ctx: Context, report: v0_6.Report, sender: Sender) => {
    const users = new Set<string>();
    const notes = new Map<string, NoteRow>();

    // A reference doesn't say what it is of, so each is looked for among both.
    for (const text of report.reported) {
        const reference = parseReference(text, sender.domain);
        if (reference === undefined) continue;

        const user = await knownUser(ctx, reference);
        if (user !== undefined) users.add(user.id);
        const note = await knownNoteRow(ctx, reference);
        if (note !== undefined) notes.set(note.id, note);
    }

    return { users: [...users], notes: [...notes.values()] };
};

/**
 * Reports from other instances, which may say who filed them. They are stored without a reporter,
 * as Verso doesn't fetch them, and each reported account gets its own, with those of its statuses
 * the report names that the sender may see, as Mastodon stores them. A remote account is reported
 * only for statuses that reply to local users, which is when Mastodon sends it on to here; a report
 * Verso has nothing in is dropped. A comment is cut at {@link commentLimit} characters.
 */
export const reportType: EntityType<v0_6.Report> = {
    type: typeName,
    extension: v0_6.reportsKey,
    schema: v0_6.Report,
    // An anonymous report comes from the instance that sent it.
    authority: (report, origin) =>
        report.author ? parseReference(report.author, origin)?.host : origin,
    receive: async (ctx, report, sender) => {
        const { users, notes } = await reportedBy(ctx, report, sender);
        const accounts = await findAccounts(ctx, users);
        const repliedTo = await findAccounts(
            ctx,
            notes.flatMap((note) => note.in_reply_to_account_id ?? []),
        );
        const local = new Set(
            repliedTo.filter((account) => account.domain === null).map((account) => account.id),
        );

        const body = new TextEncoder().encode(JSON.stringify(report));
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body)).toHex();
        const comment = [...report.comment ?? ""].slice(0, commentLimit).join("");

        for (const account of accounts) {
            const named = notes.filter((note) => note.account_id === account.id);
            if (
                account.domain !== null &&
                !named.some((note) => local.has(note.in_reply_to_account_id ?? ""))
            ) {
                continue;
            }

            const seen = [];
            for (const note of named) {
                if (note.instance_id !== null || await instanceMaySee(ctx, note, sender.domain)) {
                    seen.push(note.id);
                }
            }

            await insertReceivedReport(ctx, {
                id: ctx.ids(),
                account_id: null,
                instance_id: sender.instanceId,
                digest,
                target_account_id: account.id,
                category: categoryOf(report.tags),
                comment,
                note_ids: seen,
                rule_ids: null,
                forwarded: false,
                created_at: ctx.clock.now(),
                resolved_at: null,
            });
        }
    },
};
