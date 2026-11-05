// SPDX-License-Identifier: MIT
/**
 * Who ran what (ObserveService.GetUsage; Observe's Usage tab and the Teams
 * page): runs started for each team over a period, who started them, the
 * products their steps used, and the teams each team's products ran for.
 * From the console's own record of runs (submitted_executions), so it needs
 * no Prometheus; perf/README.md's phase 3 measured it at about 50 ms over
 * 200,000 runs. How runs ended is the kernel's, on Metrics.
 *
 * A run counts for the teams it was run for: a template run's onBehalfOf
 * ("" when for no team), a raw DAG's every team (each of which sees its own
 * steps of it in full, runView.ts; a count shows none of its outputs).
 * Readiness checks (the console's own) don't count. Steps are the steps of
 * the DAG as submitted, retries not counted. A step is a product's
 * only when it ran in the product's team's namespace, where that team sees
 * it (runView.ts); elsewhere it's an image, by its repository.
 *
 * Every install's whole usage is read once a minute per period, grouped by
 * the set of teams each run counts for (so a run for two teams is still one
 * run in a total), and each caller is shown their part of it: an admin
 * every team; anyone else the teams they're in, the products those teams
 * own (and every team that used them, as each such run is already theirs to
 * see in part), and the products their teams used.
 */
import { Code } from "@connectrpc/connect";
import { sql } from "drizzle-orm";
import { ApiError } from "../apiError.js";
import type { AuthUser } from "../auth/plugin.js";
import { db } from "../db/client.js";
import { listRunnableProducts } from "../db/queries.js";
import { imageRepository } from "../imageRef.js";
import { CHECK_RUN } from "../readiness.js";

export const USAGE_DAYS = [1, 7, 30] as const;
const DAY_MS = 24 * 3_600_000;
const CACHE_MS = 60_000;

export interface UsageCount {
  name: string;
  count: number;
}

export interface TeamUsage {
  /** "" for runs started for no team. */
  team: string;
  runs: number;
  /** Runs in the period before this one, as long. */
  previousRuns: number;
  byPeople: number;
  byBots: number;
  bySchedules: number;
  steps: number;
  /** Steps of its runs by product, most first. */
  used: UsageCount[];
  /** Steps of its own products by the team each run was for, most first. */
  ranFor: UsageCount[];
}

export interface ProductUsage {
  /** The registered product, or the image repository for one that isn't. */
  product: string;
  /** The product's team; for an image that isn't a product, the namespace its steps ran in. */
  team: string;
  action: string;
  registered: boolean;
  steps: number;
  runs: number;
  /** Steps by the team each run was for, most first. */
  usedBy: UsageCount[];
  lastUsed: Date;
}

/** Runs counted for one set of teams. */
type RunGroup = {
  owners: string[];
  runs: number;
  previous: number;
  schedules: number;
  bots: number;
  steps: number;
};

/** One product's (or image's) steps in the runs of one set of teams. */
interface Use {
  owners: string[];
  key: string;
  product: string;
  repository: string;
  productTeam: string;
  action: string;
  registered: boolean;
  hidden: boolean;
  steps: number;
  runs: number;
  last: Date;
}

interface Whole {
  since: Date;
  groups: RunGroup[];
  uses: Use[];
}

const cache = new Map<number, { at: number; whole: Promise<Whole> }>();

/** Each run since `since` with the teams it counts for, sorted so a set is one value. */
function runs(since: Date) {
  return sql`SELECT e.execution_id, e.payload, e.schedule_id, e.created_at, u.is_bot,
      CASE WHEN e.template IS NOT NULL THEN ARRAY[coalesce(e.on_behalf_of, '')]
        ELSE ARRAY(SELECT DISTINCT t FROM unnest(e.teams) AS t ORDER BY t) END AS owners
    FROM submitted_executions e LEFT JOIN users u ON u.id = e.submitted_by
    WHERE e.created_at >= ${since.toISOString()}::timestamptz
      AND e.template IS DISTINCT FROM ${CHECK_RUN}`;
}

async function readWhole(days: number): Promise<Whole> {
  const now = Date.now();
  const since = new Date(now - days * DAY_MS);
  const inPeriod = sql`r.created_at >= ${since.toISOString()}::timestamptz`;
  const groups = await db.execute<RunGroup>(sql`
    WITH r AS (${runs(new Date(now - 2 * days * DAY_MS))})
    SELECT owners,
      count(*) FILTER (WHERE ${inPeriod})::int AS runs,
      count(*) FILTER (WHERE NOT ${inPeriod})::int AS previous,
      count(*) FILTER (WHERE ${inPeriod} AND r.schedule_id IS NOT NULL)::int AS schedules,
      count(*) FILTER (WHERE ${inPeriod} AND r.schedule_id IS NULL AND r.is_bot)::int AS bots,
      coalesce(sum(jsonb_array_length(r.payload->'tasks')) FILTER (
        WHERE ${inPeriod} AND jsonb_typeof(r.payload->'tasks') = 'array'), 0)::int AS steps
    FROM r
    GROUP BY owners`);
  // By repository: the digest, then a tag, off (imageRef.ts finishes it).
  const steps = await db.execute<{ owners: string[]; image: string; action: string; team: string; steps: number; runs: number; last: string }>(sql`
    WITH r AS (${runs(since)})
    SELECT owners,
      regexp_replace(split_part(task->>'image', '@', 1), ':[^/:]*$', '') AS image,
      coalesce(task->>'action', '') AS action,
      coalesce(task->>'team', '') AS team,
      count(*)::int AS steps,
      count(DISTINCT r.execution_id)::int AS runs,
      max(r.created_at) AS last
    FROM r, jsonb_array_elements(CASE WHEN jsonb_typeof(r.payload->'tasks') = 'array' THEN r.payload->'tasks' ELSE '[]'::jsonb END) AS task
    WHERE coalesce(task->>'image', '') <> ''
    GROUP BY 1, 2, 3, 4`);

  const products = await listRunnableProducts();
  // A product's own step: its image and action, in its team's namespace.
  const named = (repository: string, action: string, team: string) =>
    products.find((p) => p.action === action && p.teamName === team && imageRepository(p.image) === repository);
  const uses = new Map<string, Use>();
  for (const row of steps.rows) {
    const repository = imageRepository(row.image);
    const product = named(repository, row.action, row.team);
    const key = product ? `${product.teamName}/${product.name}/${row.action}` : `${row.team}/${repository}/${row.action}`;
    const last = new Date(row.last);
    const id = `${row.owners.join(",")}\n${key}`;
    const seen = uses.get(id);
    if (seen) {
      // The same repository written two ways (node, docker.io/library/node): rare, and a run so spelt counts twice.
      seen.steps += row.steps;
      seen.runs += row.runs;
      if (last > seen.last) seen.last = last;
      continue;
    }
    uses.set(id, {
      owners: row.owners,
      key,
      product: product?.name ?? repository,
      repository,
      productTeam: product?.teamName ?? row.team,
      action: row.action,
      registered: product !== undefined,
      hidden: product?.hidden ?? false,
      steps: row.steps,
      runs: row.runs,
      last,
    });
  }
  return { since, groups: groups.rows, uses: [...uses.values()] };
}

function whole(days: number): Promise<Whole> {
  const cached = cache.get(days);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.whole;
  const entry = { at: Date.now(), whole: readWhole(days) };
  cache.set(days, entry);
  // A failed read isn't kept: the next caller tries again.
  entry.whole.catch(() => {
    if (cache.get(days) === entry) cache.delete(days);
  });
  return entry.whole;
}

function tally(entries: [string, number][]): UsageCount[] {
  const sums = new Map<string, number>();
  for (const [name, n] of entries) sums.set(name, (sums.get(name) ?? 0) + n);
  return [...sums].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** The caller's part of the last `days` days' usage. */
export async function getUsage(caller: AuthUser | undefined, days: number) {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  if (!(USAGE_DAYS as readonly number[]).includes(days)) {
    throw new ApiError(400, "BAD_REQUEST", `days is one of ${USAGE_DAYS.join(", ")}.`);
  }
  const { since, groups, uses } = await whole(days);
  const mine = new Set(caller.teamNames);
  const sees = (team: string) => caller.isAdmin || mine.has(team);
  const seesAny = (owners: string[]) => owners.some(sees);
  // A hidden product's name only for its own team (and admins), as Metrics does.
  const shownName = (u: Use) => (u.hidden && !sees(u.productTeam) ? u.repository : u.product);

  // Every team seen: one runs were for, or one whose products ran.
  const names = new Set([...groups.flatMap((g) => g.owners), ...uses.filter((u) => u.registered).map((u) => u.productTeam)]);
  const teamRows: TeamUsage[] = [...names]
    .filter(sees)
    .map((team) => {
      const own = groups.filter((g) => g.owners.includes(team));
      const sum = (pick: (g: RunGroup) => number) => own.reduce((n, g) => n + pick(g), 0);
      const runs = sum((g) => g.runs);
      const bots = sum((g) => g.bots);
      const schedules = sum((g) => g.schedules);
      return {
        team,
        runs,
        previousRuns: sum((g) => g.previous),
        byPeople: runs - bots - schedules,
        byBots: bots,
        bySchedules: schedules,
        steps: sum((g) => g.steps),
        used: tally(uses.filter((u) => u.owners.includes(team)).map((u) => [shownName(u), u.steps])),
        ranFor: team === "" ? [] : tally(uses.filter((u) => u.registered && u.productTeam === team).flatMap((u) => u.owners.map((o): [string, number] => [o, u.steps]))),
      };
    })
    .filter((t) => t.runs > 0 || t.previousRuns > 0 || t.ranFor.length > 0)
    .sort((a, b) => b.runs - a.runs || a.team.localeCompare(b.team));

  const byProduct = new Map<string, ProductUsage>();
  for (const u of uses) {
    // Its own team's product (or a step in its namespace): every team that used it. Else only its teams' use.
    const full = sees(u.productTeam);
    if (!full && !seesAny(u.owners)) continue;
    const p = byProduct.get(u.key) ?? {
      product: shownName(u),
      team: u.productTeam,
      action: u.action,
      registered: u.registered,
      steps: 0,
      runs: 0,
      usedBy: [],
      lastUsed: u.last,
    };
    p.steps += u.steps;
    p.runs += u.runs;
    for (const owner of u.owners) if (full || sees(owner)) p.usedBy.push({ name: owner, count: u.steps });
    if (u.last > p.lastUsed) p.lastUsed = u.last;
    byProduct.set(u.key, p);
  }
  const productRows = [...byProduct.values()]
    .map((p) => ({ ...p, usedBy: tally(p.usedBy.map((x) => [x.name, x.count])) }))
    .sort((a, b) => b.steps - a.steps || a.product.localeCompare(b.product));

  // Each run once, however many of the caller's teams it counts for.
  const seen = groups.filter((g) => seesAny(g.owners));
  const total = (pick: (g: RunGroup) => number) => seen.reduce((n, g) => n + pick(g), 0);
  return {
    since,
    days,
    runs: total((g) => g.runs),
    previousRuns: total((g) => g.previous),
    steps: total((g) => g.steps),
    teams: teamRows,
    products: productRows,
  };
}
