import { Report, ReportCategory } from "@versia/client-api";
import { z } from "zod";
import { NotFound } from "../http/errors.ts";
import { defineRoute, type Route } from "../http/route.ts";
import { Flag, Strings, Text } from "../http/schemas.ts";
import type { Config } from "../kernel/config.ts";
import { renderReport } from "./render.ts";
import { fileReport } from "./reports.ts";

/** Mastodon's limit on the length of a report's comment, in characters. */
const commentLimit = 1000;

/** Filing reports, with the rules in `instance` to say were broken. */
export const reportRoutes = (instance: Pick<Config["instance"], "rules">): readonly Route[] => [
    defineRoute({
        method: "POST",
        path: "/api/v1/reports",
        summary: "File a report",
        description: "Report problematic accounts and contents to your moderators.",
        docs: "https://docs.joinmastodon.org/methods/reports/#post",
        tags: ["reports"],
        auth: { require: "user", scope: "write:reports", permission: "owner:report" },
        body: z.object({
            account_id: z.string(),
            status_ids: Strings.default([]),
            comment: Text(commentLimit).default(""),
            forward: Flag.default(false),
            forward_to_domains: Strings.optional(),
            category: ReportCategory.optional(),
            rule_ids: Strings.default([]),
        }),
        responses: { 200: Report },
        handler: async (ctx, { body, viewer }) => {
            const report = await fileReport(ctx, viewer.accountId, {
                targetId: body.account_id,
                noteIds: body.status_ids,
                comment: body.comment,
                category: body.category,
                ruleIds: body.rule_ids,
                forward: body.forward,
                forwardToDomains: body.forward_to_domains,
            }, instance.rules.length);
            if (report === undefined) throw new NotFound();

            return { status: 200, body: await renderReport(ctx, report) };
        },
    }),
];
