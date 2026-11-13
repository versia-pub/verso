import { queueStats } from "../jobs/job_queries.ts";
import { reachabilityCounts } from "../instances/instance_queries.ts";
import type { Context } from "../kernel/context.ts";

/**
 * The content type of OpenMetrics text.
 * @see https://github.com/prometheus/OpenMetrics/blob/main/specification/OpenMetrics.md
 */
export const metricsType = "application/openmetrics-text; version=1.0.0; charset=utf-8";

/** A gauge and its samples, each with its labels, if any. */
type Gauge = {
    readonly name: string;
    readonly help: string;
    readonly unit?: string;
    readonly samples: readonly {
        readonly labels?: Readonly<Record<string, string>>;
        readonly value: number;
    }[];
};

const escape = (value: string) =>
    value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");

/** `gauges` as OpenMetrics text, which ends with `# EOF`. */
export const renderGauges = (gauges: readonly Gauge[]): string => {
    const lines = [];

    for (const gauge of gauges) {
        lines.push(`# TYPE ${gauge.name} gauge`);
        if (gauge.unit !== undefined) lines.push(`# UNIT ${gauge.name} ${gauge.unit}`);
        lines.push(`# HELP ${gauge.name} ${escape(gauge.help)}`);

        for (const { labels = {}, value } of gauge.samples) {
            const set = Object.entries(labels).map(([key, label]) => `${key}="${escape(label)}"`);
            lines.push(`${gauge.name}${set.length > 0 ? `{${set.join(",")}}` : ""} ${value}`);
        }
    }

    return [...lines, "# EOF", ""].join("\n");
};

/**
 * OpenMetrics text for the jobs and other instances. It reads only the database, so any process
 * gives the same answer.
 */
export const metrics = async (ctx: Context): Promise<string> => {
    const now = ctx.clock.now();
    const queues = await queueStats(ctx, now);
    const instances = await reachabilityCounts(ctx, now);
    const perQueue = (value: (stats: typeof queues[number]) => number) =>
        queues.map((stats) => ({ labels: { queue: stats.queue }, value: value(stats) }));

    return renderGauges([
        {
            name: "verso_jobs_waiting",
            help: "Jobs neither finished nor dead, due or not, running or not.",
            samples: perQueue((stats) => stats.waiting),
        },
        {
            name: "verso_jobs_oldest_due_seconds",
            help: "How long the job due longest, that no worker is running, has been due.",
            unit: "seconds",
            samples: perQueue((stats) =>
                stats.oldestDue === undefined
                    ? 0
                    : Math.max(0, (now.getTime() - stats.oldestDue.getTime()) / 1000)
            ),
        },
        {
            name: "verso_jobs_dead",
            help: "Jobs that failed for good, retained for someone to look at.",
            samples: perQueue((stats) => stats.dead),
        },
        {
            name: "verso_instances_parked",
            help: "Instances that nothing is sent to until their wait ends.",
            samples: [{ value: instances.parked }],
        },
        {
            name: "verso_instances_unreachable",
            help: "Instances that couldn't be reached the last time Verso tried.",
            samples: [{ value: instances.unreachable }],
        },
    ]);
};
