// SPDX-License-Identifier: MIT
import type { DocSummary } from "../../api";
import { API_REFERENCE_ID } from "../ApiReference";

/** A page: a whole doc, or one section of a long one (its ## heading's anchor; none for the part before the first). */
export interface Page {
  kind: "page";
  /** Unique in the contents: the doc's id, and the section's anchor. */
  key: string;
  doc: string;
  section?: string;
  label: string;
  /** Design history: why, not how it works now. */
  history?: boolean;
}

/** Pages under one name: a long doc's sections, or docs that belong together. Opens and closes. */
export interface Group {
  kind: "group";
  key: string;
  label: string;
  children: Node[];
}

export type Node = Page | Group;

export interface Category {
  id: string;
  title: string;
  /** Who it's for and what's in it, on the docs' home. */
  blurb: string;
  children: Node[];
}

/**
 * What the contents are written as: a doc whole ([id, label]); a long doc a
 * section to a page ({ doc, label, sections }), its sections in groups of
 * their own where there are many (an anchor alone, or [group, anchors]),
 * or simply in order (sections: "all"); or docs under a name of their own
 * ({ group, items }).
 */
type Item =
  | [string, string]
  | { doc: string; label: string; sections: "all" | (string | [string, string[]])[]; skip?: string[] }
  | { group: string; items: Item[] };

/**
 * The docs in the order to read them: getting started, the ideas, the
 * how-tos, then by what you're doing, then how it all works, in depth. A
 * doc the console serves that isn't placed here still shows, under More,
 * and so does a section of a long doc not placed in its groups; a test
 * fails while either happens.
 */
const CONTENTS: { id: string; title: string; blurb: string; items: Item[] }[] = [
  {
    id: "start",
    title: "Get started",
    blurb: "Install Vennir and bring a team on, run your first DAG, and learn the one idea everything else builds on.",
    items: [
      ["17-onboarding", "Onboarding, start to finish"],
      ["01-getting-started", "Try Vennir end to end"],
      ["03-what-is-a-dag", "What's a DAG?"],
    ],
  },
  {
    id: "use",
    title: "Use the console",
    blurb: "Order from the catalog, call APIs, watch what's running, work with your team, and fix a run that failed.",
    items: [
      ["10-ordering-and-the-cart", "Ordering and the cart"],
      ["11-apis", "APIs and the gateway"],
      ["12-observe", "Observe: checks, logs, metrics, audit"],
      ["13-teams-and-roles", "Teams and roles"],
      ["15-troubleshooting", "Troubleshooting"],
    ],
  },
  {
    id: "concepts",
    title: "Concepts",
    blurb: "How a run goes, how values pass between steps, and how secrets stay with their team.",
    items: [
      { doc: "09-runs-explained", label: "Runs, explained", sections: "all" },
      ["07-how-data-moves", "How values move between steps"],
      ["04-secrets-explained", "Secrets, explained"],
    ],
  },
  {
    id: "how-to",
    title: "How-to guides",
    blurb: "Things you'll do once you're running: deploy to your cloud, publish APIs, automate runs with bots, and bring in secrets.",
    items: [
      ["19-deploy-to-gcp", "Deploy to Google Cloud"],
      ["20-deploy-to-aws", "Deploy to AWS"],
      ["23-deploy-to-azure", "Deploy to Azure"],
      ["24-every-cloud-from-any-install", "Creating resources in every cloud"],
      ["21-api-gateway", "The API gateway, start to finish"],
      ["22-addresses-and-firewalls", "Addresses and firewall rules"],
      ["14-bots-and-automation", "Bots and automation"],
      ["05-calling-the-api", "Call the API from a pipeline"],
      ["02-sync-secrets-gcp", "Sync secrets from Secret Manager"],
    ],
  },
  {
    id: "products",
    title: "Build products",
    blurb: "For platform teams: publish products, templates and APIs to the catalog.",
    items: [
      {
        doc: "reference-catalog-guide",
        label: "The catalog",
        sections: [
          ["Set up", ["layout", "onboarding-a-team", "a-teams-secretstore", "removing-a-team"]],
          ["Write products", ["productyaml", "the-container-contract", "templates-and-dags-dags", "api-products-apis"]],
          ["Ship them", ["testing", "what-ci-blocks", "who-approves-what", "publishing", "updating-your-catalog"]],
        ],
      },
      ["reference-catalog-onboarding-with-ai", "Onboard with an AI assistant"],
    ],
  },
  {
    id: "operate",
    title: "Install and operate",
    blurb: "For admins: set Vennir up, connect your cloud, and run it day to day.",
    items: [
      {
        group: "Set up",
        items: [
          ["18-where-to-host", "Where to host Vennir"],
          ["reference-setup", "Set up Vennir"],
          ["reference-clouds-computer", "Get your computer ready"],
          ["reference-clouds-gcp", "Get Google Cloud ready"],
          ["reference-clouds-aws", "Get AWS ready"],
          ["reference-clouds-azure", "Get Azure ready"],
          ["reference-clouds-github", "Get GitHub ready"],
        ],
      },
      ["16-admin-settings", "The Admin page, setting by setting"],
      {
        doc: "reference-operations",
        label: "Operations",
        sections: [
          ["Install", ["local-install-with-kind", "installing-on-a-cluster-with-helm"]],
          ["Run it", ["upgrading", "databases", "rotating-secrets", "backups", "network-policies", "the-chat-agent", "throughput"]],
          "troubleshooting",
        ],
      },
    ],
  },
  {
    id: "internals",
    title: "How Vennir works",
    blurb: "In depth: the pieces and how they fit, a run call by call, what keeps teams apart, the data, and why it's built this way.",
    items: [
      { doc: "reference-architecture", label: "Architecture", sections: "all" },
      { doc: "08-under-the-hood", label: "Under the hood", sections: "all" },
      { doc: "reference-kernel-architecture", label: "Inside the kernel", sections: "all", skip: ["table-of-contents"] },
      {
        doc: "reference-security-model",
        label: "Security model",
        sections: [
          "at-a-glance",
          ["Identity and signing in", ["who-is-trusted", "signing-in", "in-the-browser", "how-kernel-api-knows-its-caller", "bot-tokens", "keyless-bots", "ordering-bots", "tokens-for-another-cloud"]],
          ["Secrets", ["where-secret-values-live", "how-a-secret-reaches-a-step", "who-can-read-a-secret"]],
          ["Runs and what they make", ["consumers-and-templates", "who-sees-a-run-that-spans-teams", "who-sees-a-steps-logs", "what-a-run-made-and-deleting-it", "schedules"]],
          ["Notifications", ["notifications-and-chat-webhooks", "email"]],
          ["What the platform enforces", ["guardrails-the-cluster-enforces", "what-a-step-can-reach", "if-a-component-is-compromised", "the-consoles-writes", "the-api-gateway", "vennirs-own-supply-chain", "audit", "what-vennir-stores", "rules-for-product-authors"]],
          ["Limits", ["not-yet-enforced", "out-of-scope", "reporting-a-vulnerability"]],
        ],
      },
      { doc: "06-database-schemas", label: "Where the data lives", sections: "all" },
      {
        doc: "reference-assessment",
        label: "Design history",
        skip: ["contents"],
        sections: [
          "1-summary",
          ["Where it started", ["2-the-intended-model", "3-what-exists-today", "4-findings"]],
          ["Compared with", ["5-compared-with-temporal", "6-compared-with-inngest"]],
          [
            "The design, area by area",
            [
              "7-the-git-catalog",
              "8-team-authorization-and-secrets",
              "9-cloud-identity",
              "10-hosting-and-target-clouds",
              "11-keeping-cloud-permissions-from-creeping",
              "12-which-targets-a-consumer-may-use",
              "13-golden-paths-and-compatibility",
              "14-the-console-as-a-marketplace",
              "15-execution-reliability-traced",
              "16-before-production",
            ],
          ],
          ["What was decided", ["17-decisions", "18-roadmap", "19-the-smallest-architecture-that-does-it", "20-what-should-not-change", "21-answers-in-brief"]],
        ],
      },
    ],
  },
  {
    id: "reference",
    title: "Reference",
    blurb: "The console's API, and every folder and file in the repository.",
    items: [
      [API_REFERENCE_ID, "API reference"],
      { doc: "reference-repository-map", label: "Repository map", sections: "all" },
    ],
  },
];

/** The first steps, in order, on the help's home: each guide, and what it gives you. */
export const START_HERE: { guide: string; blurb: string }[] = [
  { guide: "01-getting-started", blurb: "A product that reads a secret and feeds another" },
  { guide: "03-what-is-a-dag", blurb: "The one idea everything builds on" },
  { guide: "07-how-data-moves", blurb: "One value, followed through a real run" },
  { guide: "04-secrets-explained", blurb: "Where a secret lives, and who can read it" },
];

/** A question, and the guide (and section) that answers it. */
export interface Answered {
  label: string;
  guide: string;
  section?: string;
}

/** What people often look for: chips under the help's search. */
export const POPULAR: Answered[] = [
  { label: "My step is Ready but not running", guide: "15-troubleshooting", section: "my-step-is-ready-but-not-running" },
  { label: "Retry or Run again?", guide: "09-runs-explained", section: "how-do-retries-work-automatic-retry-and-run-again" },
  { label: "Add a bot and get its token", guide: "14-bots-and-automation", section: "how-do-i-add-a-bot-and-get-its-token" },
  { label: "I can't sign in", guide: "15-troubleshooting", section: "i-cant-sign-in" },
];

/** The help's home by what you're trying to do: each task's questions, answered by a guide's section. */
export const TASKS: { id: string; title: string; blurb: string; questions: Answered[] }[] = [
  {
    id: "run",
    title: "Find and run something",
    blurb: "Order from the catalog, preview it, get it approved, and find what it made.",
    questions: [
      { label: "How do I order several actions with the cart?", guide: "10-ordering-and-the-cart", section: "how-do-i-order-several-actions-together-with-the-cart" },
      { label: "Why is my run waiting for an approval?", guide: "10-ordering-and-the-cart", section: "why-is-my-run-waiting-for-an-approval" },
      { label: "Can I see what a run would change first?", guide: "10-ordering-and-the-cart", section: "can-i-see-what-a-run-would-change-before-it-runs" },
      { label: "Run something on a schedule", guide: "10-ordering-and-the-cart", section: "how-do-i-run-something-on-a-schedule" },
    ],
  },
  {
    id: "fix",
    title: "Fix a run that failed",
    blurb: "Organized by what you see: a refused submission, a step that won't start, a missing secret.",
    questions: [
      { label: "Where do I start when a run fails?", guide: "15-troubleshooting", section: "where-do-i-start-when-a-run-fails" },
      { label: "What does each failure code mean?", guide: "09-runs-explained", section: "what-does-each-failure-code-mean" },
      { label: "An image was refused", guide: "15-troubleshooting", section: "an-image-was-refused" },
      { label: "My step doesn't get its secret", guide: "15-troubleshooting", section: "my-step-doesnt-get-its-secret" },
    ],
  },
  {
    id: "team",
    title: "Work with your team",
    blurb: "Members and maintainers, joining a team, groups, and retiring one.",
    questions: [
      { label: "What may a member, a maintainer and an admin do?", guide: "13-teams-and-roles", section: "what-may-a-member-a-maintainer-and-an-admin-do" },
      { label: "How do I join a team?", guide: "13-teams-and-roles", section: "how-do-i-join-a-team" },
      { label: "How do sign-in groups decide who is in a team?", guide: "13-teams-and-roles", section: "how-do-single-sign-on-groups-decide-who-is-in-a-team" },
    ],
  },
  {
    id: "automate",
    title: "Automate",
    blurb: "Bots for pipelines and storefronts, keyless CI, webhooks, the API.",
    questions: [
      { label: "Which kind of bot do I need?", guide: "14-bots-and-automation", section: "which-kind-of-bot-do-i-need" },
      { label: "Sign in from CI without a stored token", guide: "14-bots-and-automation", section: "how-do-i-sign-in-from-ci-without-a-stored-token" },
      { label: "Get every run's outcome posted to our systems", guide: "14-bots-and-automation", section: "how-do-i-get-every-runs-outcome-posted-to-our-systems" },
      { label: "Call the API from a pipeline", guide: "05-calling-the-api" },
    ],
  },
  {
    id: "secrets",
    title: "Keep and use secrets",
    blurb: "How a secret reaches a step, and only that step, and syncing from your vault.",
    questions: [
      { label: "Secrets, explained", guide: "04-secrets-explained" },
      { label: "Sync secrets from GCP Secret Manager", guide: "02-sync-secrets-gcp" },
      { label: "If a secret gets wiped, can it come back?", guide: "04-secrets-explained", section: "if-a-secret-gets-wiped-can-it-come-back" },
    ],
  },
  {
    id: "apis",
    title: "Call or publish an API",
    blurb: "Find another team's API, get access, call it through the gateway, read your traffic.",
    questions: [
      { label: "How do I call an API through the gateway?", guide: "11-apis", section: "how-do-i-call-an-api-through-the-gateway" },
      { label: "What does each gateway error mean?", guide: "11-apis", section: "what-does-each-gateway-error-mean" },
      { label: "Pausing an API during an incident", guide: "11-apis", section: "pausing-an-api-during-an-incident" },
      { label: "Publish an API through the gateway", guide: "21-api-gateway", section: "2-publish-an-api" },
    ],
  },
  {
    id: "cloud",
    title: "Deploy to your cloud",
    blurb: "Let products create resources in Google Cloud, AWS or Azure, and get past firewalls that want an address.",
    questions: [
      { label: "Let a product create things in Google Cloud", guide: "19-deploy-to-gcp" },
      { label: "Let a product create things in AWS", guide: "20-deploy-to-aws" },
      { label: "Let a product create things in Azure", guide: "23-deploy-to-azure" },
      { label: "Who sets up what in each cloud?", guide: "24-every-cloud-from-any-install" },
      { label: "A firewall needs Vennir's address", guide: "22-addresses-and-firewalls", section: "finding-the-outbound-addresses-now" },
      { label: "Which cloud should Vennir run on?", guide: "18-where-to-host" },
    ],
  },
  {
    id: "observe",
    title: "See what's happening",
    blurb: "Security checks, scans, logs, metrics and the audit log.",
    questions: [
      { label: "What does each security check mean?", guide: "12-observe", section: "what-does-each-security-check-mean" },
      { label: "Whose logs can I see?", guide: "12-observe", section: "whose-logs-can-i-see" },
      { label: "Reading the audit log", guide: "12-observe", section: "reading-the-audit-log" },
    ],
  },
  {
    id: "build",
    title: "Build products",
    blurb: "For platform teams: publish products, templates and APIs to the catalog.",
    questions: [
      { label: "The catalog: layout and product.yaml", guide: "reference-catalog-guide", section: "layout" },
      { label: "What CI blocks, and who approves what", guide: "reference-catalog-guide", section: "what-ci-blocks" },
      { label: "Onboard with an AI assistant", guide: "reference-catalog-onboarding-with-ai" },
    ],
  },
  {
    id: "operate",
    title: "Install and operate",
    blurb: "For admins: set Vennir up, connect your cloud, and run it day to day.",
    questions: [
      { label: "Onboarding, start to finish", guide: "17-onboarding" },
      { label: "Set up Vennir", guide: "reference-setup" },
      { label: "The Admin page, setting by setting", guide: "16-admin-settings" },
      { label: "Upgrading, backups, rotating secrets", guide: "reference-operations", section: "upgrading" },
    ],
  },
];

/** The help's home, for going deeper: the reference and how it all works. */
export const IN_DEPTH: Answered[] = [
  { label: "API reference: every method", guide: API_REFERENCE_ID },
  { label: "Architecture", guide: "reference-architecture" },
  { label: "Security model", guide: "reference-security-model" },
  { label: "Under the hood", guide: "08-under-the-hood" },
  { label: "Where Vennir keeps its data", guide: "06-database-schemas" },
  { label: "Repository map", guide: "reference-repository-map" },
];

/**
 * A guide organized by symptom opens with a grid of them, each to its
 * section: what you see, in a few words, and what it's about.
 */
export const SYMPTOMS: Record<string, { heading: string; items: (Answered & { hint: string })[] }> = {
  "15-troubleshooting": {
    heading: "What do you see?",
    items: [
      { label: "A run failed", hint: "Read its failure card, then its logs", guide: "15-troubleshooting", section: "where-do-i-start-when-a-run-fails" },
      { label: "Submitting returns an error", hint: "Nothing ran: the console refused it", guide: "15-troubleshooting", section: "my-submission-was-refused-before-anything-ran" },
      { label: "A step stays Ready", hint: "Something is holding it back", guide: "15-troubleshooting", section: "my-step-is-ready-but-not-running" },
      { label: "Awaiting approval", hint: "Who decides, and when it expires", guide: "15-troubleshooting", section: "my-step-is-awaiting-approval" },
      { label: "An image was refused", hint: "IMAGE_NOT_ALLOWED, scans, signatures", guide: "15-troubleshooting", section: "an-image-was-refused" },
      { label: "A secret is missing", hint: "MISSING_SECRET, or no file in /platform/secrets/", guide: "15-troubleshooting", section: "my-step-doesnt-get-its-secret" },
      { label: "Not ready on this install", hint: "A product's check found something missing", guide: "15-troubleshooting", section: "a-product-says-it-isnt-ready-here" },
      { label: "I can't sign in", hint: "Passwords, Google, groups, sessions", guide: "15-troubleshooting", section: "i-cant-sign-in" },
      { label: "A merge doesn't show up", hint: "The catalog release isn't applied", guide: "15-troubleshooting", section: "the-catalog-isnt-syncing" },
      { label: "Who to ask", hint: "An admin, the product's team, or your maintainer", guide: "15-troubleshooting", section: "when-should-i-ask-an-admin" },
    ],
  },
};

const keyOf = (doc: string, section?: string) => (section ? `${doc}/${section}` : doc);

/** The contents for the docs the console serves: each category with what it has, then anything not placed. */
export function contentsOf(docs: DocSummary[]): Category[] {
  const served = new Map(docs.map((d) => [d.id, d]));
  const placed = new Set<string>();
  const strays: Page[] = [];

  // A whole doc of design history says so; a long one's pages are under its name, which does.
  const page = (doc: string, label: string, section?: string, whole = false): Page => {
    placed.add(doc);
    const p: Page = { kind: "page", key: keyOf(doc, section), doc, label, history: whole && served.get(doc)?.kind === "history" };
    if (section) p.section = section;
    return p;
  };
  const expand = (item: Item): Node[] => {
    if (Array.isArray(item)) {
      const [id, label] = item;
      return id === API_REFERENCE_ID || served.has(id) ? [page(id, label, undefined, true)] : [];
    }
    if ("group" in item) {
      const children = item.items.flatMap(expand);
      return children.length > 0 ? [{ kind: "group", key: `group:${item.group}`, label: item.group, children }] : [];
    }
    const doc = served.get(item.doc);
    if (!doc) return [];
    const titles = new Map(doc.sections.map((s) => [s.anchor, s.title]));
    const used = new Set<string>(item.skip);
    const sectionPage = (anchor: string): Page[] => {
      const title = titles.get(anchor);
      if (!title) return [];
      used.add(anchor);
      return [page(doc.id, title, anchor)];
    };
    const children: Node[] = [page(doc.id, "Overview")];
    if (item.sections === "all") {
      children.push(...doc.sections.filter((s) => !used.has(s.anchor)).flatMap((s) => sectionPage(s.anchor)));
    } else {
      for (const s of item.sections) {
        if (typeof s === "string") {
          children.push(...sectionPage(s));
          continue;
        }
        const [label, anchors] = s;
        const pages = anchors.flatMap(sectionPage);
        if (pages.length > 0) children.push({ kind: "group", key: `${doc.id}:${label}`, label, children: pages });
      }
    }
    // A section the groups don't name (a heading added or renamed since) still shows, under More.
    for (const s of doc.sections) {
      if (!used.has(s.anchor)) strays.push({ kind: "page", key: keyOf(doc.id, s.anchor), doc: doc.id, section: s.anchor, label: `${item.label}: ${s.title}` });
    }
    return [{ kind: "group", key: doc.id, label: item.label, children }];
  };

  const categories: Category[] = [];
  for (const c of CONTENTS) {
    const children = c.items.flatMap(expand);
    if (children.length > 0) categories.push({ id: c.id, title: c.title, blurb: c.blurb, children });
  }
  const more: Node[] = [
    ...docs.filter((d) => !placed.has(d.id)).map((d): Page => ({ kind: "page", key: d.id, doc: d.id, label: d.title, history: d.kind === "history" })),
    ...strays,
  ];
  if (more.length > 0) categories.push({ id: "more", title: "More", blurb: "Other guides and reference.", children: more });
  return categories;
}

/** Every page under some nodes, in order. */
export function pagesOf(nodes: Node[]): Page[] {
  return nodes.flatMap((n) => (n.kind === "page" ? [n] : pagesOf(n.children)));
}

/** The groups a page is under, outermost first (what to open to show it); null when it isn't under these. */
export function trailOf(nodes: Node[], key: string): Group[] | null {
  for (const n of nodes) {
    if (n.kind === "page") {
      if (n.key === key) return [];
      continue;
    }
    const below = trailOf(n.children, key);
    if (below) return [n, ...below];
  }
  return null;
}

/** Where a page is: its category, the groups it's under, and the pages before and after it in reading order. */
export function placeOf(categories: Category[], doc: string, section?: string) {
  const key = keyOf(doc, section);
  const order = categories.flatMap((category) => pagesOf(category.children).map((page) => ({ page, category })));
  const at = order.findIndex((o) => o.page.key === key);
  const found = order[at];
  if (!found) return null;
  return { ...found, groups: trailOf(found.category.children, key) ?? [], previous: order[at - 1], next: order[at + 1] };
}

/** Whether a doc is shown a section to a page. */
export function isSplit(categories: Category[], doc: string): boolean {
  return categories.some((c) => pagesOf(c.children).some((p) => p.doc === doc && p.section !== undefined));
}

/** A heading's anchor, as rehype-slug makes it (GitHub's). */
export function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** A heading (or any text) as it reads, without the markdown around its words. */
export const plain = (heading: string) =>
  heading
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*/g, "");

/** A doc's lines, each with whether it's code (inside a fenced block, or its fence). */
function linesOf(markdown: string): { line: string; code: boolean }[] {
  let fenced = false;
  return markdown.split("\n").map((line) => {
    const fence = /^\s*(```|~~~)/.test(line);
    if (fence) fenced = !fenced;
    return { line, code: fenced || fence };
  });
}

/** A doc's sections (its ## headings, outside code), for "On this page"; a repeated one numbered -1, -2… as rehype-slug does. */
export function sectionsOf(markdown: string): { title: string; anchor: string }[] {
  const sections: { title: string; anchor: string }[] = [];
  const seen = new Map<string, number>();
  for (const { line, code } of linesOf(markdown)) {
    const heading = code ? null : /^## (.+?)\s*#*\s*$/.exec(line);
    if (!heading?.[1]) continue;
    const title = plain(heading[1]);
    const anchor = slug(title);
    const times = seen.get(anchor) ?? 0;
    seen.set(anchor, times + 1);
    sections.push({ title, anchor: times === 0 ? anchor : `${anchor}-${String(times)}` });
  }
  return sections;
}

/**
 * One page of a long doc: the part before its first section (none), or the
 * section with that anchor, its headings a level up so it reads as a page
 * of its own (its ## the page's title, its ### its sections). Null when
 * the doc has no such section.
 */
export function pageOf(markdown: string, section?: string): string | null {
  const lines = linesOf(markdown);
  const starts = lines.flatMap((l, i) => (!l.code && l.line.startsWith("## ") ? [i] : []));
  if (!section) return lines.slice(0, starts[0] ?? lines.length).map((l) => l.line).join("\n");
  const index = sectionsOf(markdown).findIndex((s) => s.anchor === section);
  const start = starts[index];
  if (index < 0 || start === undefined) return null;
  return lines
    .slice(start, starts[index + 1] ?? lines.length)
    .map((l) => (l.code ? l.line : l.line.replace(/^#(#{1,5}) /, "$1 ")))
    .join("\n");
}

/** The section of a long doc that a heading's anchor is in: undefined when it's before the first, or isn't there. */
export function sectionHolding(markdown: string, anchor: string): string | undefined {
  const sections = sectionsOf(markdown);
  let current: string | undefined;
  let h2 = -1;
  for (const { line, code } of linesOf(markdown)) {
    const heading = code ? null : /^(#{1,6}) (.+?)\s*#*\s*$/.exec(line);
    if (!heading?.[1] || !heading[2]) continue;
    if (heading[1] === "##") {
      h2 += 1;
      current = sections[h2]?.anchor;
      if (current === anchor) return current;
    } else if (current && slug(plain(heading[2])) === anchor) {
      return current;
    }
  }
  return undefined;
}

/**
 * Where a link between docs goes here: "security-model.md#x" is
 * /docs/reference-security-model#x. The link is the repository's path
 * from wherever the doc lives, so it's matched by name: the doc itself,
 * its reference copy, or the one whose id ends with its name
 * ("docs/onboarding-with-ai.md" is reference-catalog-onboarding-with-ai).
 * Null when the console doesn't serve it.
 */
export function docTarget(href: string, served: ReadonlySet<string>): string | null {
  const [path = "", anchor] = href.split("#", 2);
  const name = path
    .replace(/\.md$/, "")
    .replace(/^(\.\.?\/)+/, "")
    .replace(/^(console\/)?docs\//, "")
    .replace(/\//g, "-");
  const base = path.replace(/\.md$/, "").split("/").at(-1) ?? name;
  const id =
    [name, `reference-${name}`, base, `reference-${base}`].find((candidate) => served.has(candidate)) ??
    [...served].find((candidate) => candidate.endsWith(`-${base}`));
  return id ? `/docs/${id}${anchor ? `#${anchor}` : ""}` : null;
}
