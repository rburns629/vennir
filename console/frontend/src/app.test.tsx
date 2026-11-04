// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
/**
 * The whole app, routed and signed in, over a fake console API: every page
 * renders, the navigation follows who you are, and the sign-in rules hold.
 * The fake answers each `/api/vennir.console.v1.<Service>/<Method>` call
 * with canned JSON (an empty message when a test gives none), so these
 * tests check what the pages do with the API, whatever the pages look like.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { create, toBinary } from "@bufbuild/protobuf";
import { FailureSchema } from "./gen/vennir/console/v1/common_pb.js";
import { CssBaseline, ThemeProvider } from "@mui/material";
import type { ComponentType } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { theme } from "./theme";

type Answer = unknown | ((request: Record<string, unknown>) => unknown);
let answers: Record<string, Answer> = {};

/** A Connect error, as the console sends one: its Connect code, and the
 * console's stable code in a Failure detail. */
const refused = (status: number, code: string, message: string, failure?: string, detail?: Record<string, string>) => ({ refused: { status, code, message, failure, detail } });

async function connectResponse(key: string, request: Record<string, unknown>, streaming: boolean): Promise<Response> {
  const answer = answers[key];
  // A handler may answer later (a promise), to test what happens meanwhile.
  const value: unknown = await (typeof answer === "function" ? (answer as (r: Record<string, unknown>) => unknown)(request) : (answer ?? {}));
  // (An array named refused is a message's field: the gateway's refusals.)
  if (value && typeof value === "object" && "refused" in value && !Array.isArray(value.refused)) {
    const { status, code, message, failure, detail } = (value as ReturnType<typeof refused>).refused;
    const details = failure
      ? [{ type: "vennir.console.v1.Failure", value: btoa(String.fromCharCode(...toBinary(FailureSchema, create(FailureSchema, { code: failure, message, detail })))) }]
      : undefined;
    // A stream that fails says so in its end, as the console's does.
    if (streaming) return streamOf([], { error: { code, message, details } });
    return new Response(JSON.stringify({ code, message, details }), { status, headers: { "content-type": "application/json" } });
  }
  if (!streaming) return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  return streamOf(Array.isArray(value) ? value : [], {});
}

/** A server stream: its messages, then its end. */
function streamOf(messages: unknown[], end: unknown): Response {
  const frame = (flags: number, json: unknown) => {
    const body = new TextEncoder().encode(JSON.stringify(json));
    const envelope = new Uint8Array(5 + body.length);
    envelope[0] = flags;
    new DataView(envelope.buffer).setUint32(1, body.length);
    envelope.set(body, 5);
    return envelope;
  };
  const frames = [...messages.map((m) => frame(0, m)), frame(0b10, end)];
  // One byte array: jsdom's Blob isn't one Node's Response can read.
  const body = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  frames.reduce((offset, f) => {
    body.set(f, offset);
    return offset + f.length;
  }, 0);
  return new Response(body, { status: 200, headers: { "content-type": "application/connect+json" } });
}

const calls: string[] = [];

beforeAll(() => {
  // Before the app's API client exists: it keeps the fetch it's given.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const match = /\/api\/vennir\.console\.v1\.(\w+)\/(\w+)$/.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });
    const key = `${match[1]}/${match[2]}`;
    calls.push(key);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const streaming = (headers.get("content-type") ?? "").startsWith("application/connect+");
    let body: Record<string, unknown> = {};
    const raw = init?.body;
    if (typeof raw === "string") body = JSON.parse(raw || "{}") as Record<string, unknown>;
    else if (raw && ArrayBuffer.isView(raw)) {
      // A byte array, possibly from another realm (jsdom's), so not instanceof.
      const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const text = new TextDecoder().decode(streaming ? bytes.subarray(5) : bytes);
      body = JSON.parse(text || "{}") as Record<string, unknown>;
    }
    return connectResponse(key, body, streaming);
  });
  // MUI and recharts measure; jsdom has neither of these.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // A desktop-sized window: min-width queries match (the sidebar is shown).
  window.matchMedia = ((query: string) => ({ matches: /min-width/.test(query), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  answers = {};
  calls.length = 0;
});

const ADMIN = { userId: "u1", email: "ana@acme.com", teamNames: ["azure-apps"], maintainerOf: ["azure-apps"], isAdmin: true, mustChangePassword: false, hasPassword: true, usesSso: false };
const MEMBER = { ...ADMIN, isAdmin: false, maintainerOf: [] };

let App: ComponentType;
async function renderAt(path: string, me: typeof ADMIN | null, extra: Record<string, Answer> = {}) {
  App ??= (await import("./App")).App;
  if (me) localStorage.setItem("token", "a-session");
  answers = { "AuthService/GetEnvironment": { label: "test" }, ...(me ? { "AuthService/GetMe": me } : {}), ...extra };
  render(
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** Each signed-in page, and what it needs beyond empty answers to have something to show. */
const PAGES: [string, Record<string, Answer>][] = [
  ["/", {}],
  ["/teams", {}],
  ["/teams/azure-apps", {}],
  ["/admin", {}],
  ["/admin?tab=scans", {}],
  ["/account", {}],
  ["/runs", {}],
  ["/runs/submit", {}],
  ["/runs/made", {}],
  ["/catalog/compose", {}],
  ["/runs/0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11", { "ExecutionService/WatchExecution": [{ execution: { executionId: "0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11", name: "a run", state: "EXECUTION_STATE_SUCCEEDED", createdAt: "2026-10-21T16:20:00Z", tasks: [] } }] }],
  ["/catalog", {}],
  ["/products", {}],
  ["/apis", {}],
  ["/apis/payments/orders", { "ApiService/GetApi": { api: { team: "payments", name: "orders", displayName: "Orders API", mayCall: true, endpoints: [] }, openapi: "{}" } }],
  ["/observe", {}],
  ["/observe?tab=usage", {}],
  [
    "/docs",
    {
      "GuideService/ListGuides": { guides: [{ id: "01-getting-started", title: "Getting started" }] },
      "GuideService/GetGuide": { markdown: "# Getting started\n\nHello." },
    },
  ],
];

describe("every page", () => {
  it.each(PAGES)("%s renders inside the app's layout", async (path, needs) => {
    await renderAt(path, ADMIN, needs);
    const main = await screen.findByRole("main");
    // The page itself, once its lazy chunk has loaded: a heading of its own.
    expect((await within(main).findAllByRole("heading", {}, { timeout: 5000 })).length).toBeGreaterThan(0);
    // A code comment that slipped into JSX shows as text.
    expect(main.textContent).not.toMatch(/(^|[^:])\/\/ /);
  });
});

describe("the navigation", () => {
  it("offers Admin to admins only", async () => {
    await renderAt("/", ADMIN);
    const nav = await screen.findByRole("navigation", { name: /main/i });
    expect(within(nav).getByRole("link", { name: /admin/i })).toBeTruthy();
    cleanup();

    await renderAt("/", MEMBER);
    const memberNav = await screen.findByRole("navigation", { name: /main/i });
    expect(within(memberNav).queryByRole("link", { name: /admin/i })).toBeNull();
  });
});

describe("image scans", () => {
  const FAILED = {
    digest: "sha256:" + "a".repeat(64),
    image: "registry.example/web/site@sha256:" + "a".repeat(64),
    status: "SCAN_STATUS_FAILED",
    findings: { fixable: 1, unfixable: 0, secrets: 0, findings: [{ kind: "vulnerability", id: "CVE-2026-1", severity: "HIGH", package: "openssl", installed: "3.0.1", fixedIn: "3.0.2" }] },
  };
  const PASSED = { digest: "sha256:" + "b".repeat(64), image: "registry.example/web/api@sha256:" + "b".repeat(64), status: "SCAN_STATUS_PASSED" };

  it("filters by verdict, and opens a failed one to accept it only with a reason", async () => {
    await renderAt("/admin?tab=scans", ADMIN, { "ImageService/ListImageScans": { scans: [FAILED, PASSED] } });
    fireEvent.click(await screen.findByRole("button", { name: /^Failed 1/ }));
    expect(screen.queryByText("registry.example/web/api")).toBeNull();
    fireEvent.click(screen.getByText("registry.example/web/site"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("CVE-2026-1")).toBeTruthy();
    const accept = within(dialog).getByRole("button", { name: "Accept" });
    expect(accept.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Why it may run anyway"), { target: { value: "No fix upstream; not reachable here." } });
    expect(accept.hasAttribute("disabled")).toBe(false);
  });

  it("tells an admin only about failed images a product runs now", async () => {
    const running = (image: string) => ({
      "AdminService/GetInstall": { version: "0.4.0", scanning: true },
      "ObserveService/GetSecurity": { images: [{ product: "web", team: "web", image, scan: "passed" }] },
    });
    // An old build the product moved on from: listed, but nothing to do.
    await renderAt("/admin", ADMIN, { "ImageService/ListImageScans": { scans: [FAILED, PASSED] }, ...running(PASSED.image) });
    const parts = await screen.findByRole("region", { name: "Every part, and where it's set" });
    expect(await within(parts).findByText(/1 failed \(none in use\)/)).toBeTruthy();
    expect(screen.queryByText(/failed its scan/)).toBeNull();
    cleanup();

    // The build a product runs: it needs an admin.
    await renderAt("/admin", ADMIN, { "ImageService/ListImageScans": { scans: [FAILED, PASSED] }, ...running(FAILED.image) });
    const needs = await screen.findByRole("region", { name: "Needs you" });
    expect(await within(needs).findByText("registry.example/web/site failed its scan")).toBeTruthy();
  });
});

describe("runs", () => {
  const RUN = {
    executionId: "0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11",
    name: "orders-api first deploy",
    teams: ["azure-apps"],
    createdAt: "2026-10-22T14:02:00Z",
    state: "EXECUTION_STATE_RUNNING",
    template: "gcp-platform/app-on-cloud-run",
    steps: { SUCCEEDED: 2, RUNNING: 1, PENDING: 1 },
  };

  it("says what each run was, how far its steps got, what runs now, and how long runs are kept", async () => {
    await renderAt("/runs", MEMBER, {
      "ExecutionService/ListExecutions": { executions: [{ ...RUN, running: [{ taskId: "app-hosting", action: "create", attempt: 2, maxAttempts: 3 }] }], runRetentionDays: 90 },
    });
    expect(await screen.findByRole("link", { name: "orders-api first deploy" })).toBeTruthy();
    expect(screen.getByText("app-on-cloud-run · gcp-platform")).toBeTruthy();
    expect(screen.getByText("2 of 4")).toBeTruthy();
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    expect(screen.getByText("Now: app-hosting.create, attempt 2 of 3")).toBeTruthy();
    // Not an admin, and still told: the list carries it.
    expect(screen.getByText(/Runs are kept 90 days/)).toBeTruthy();
    expect(calls).not.toContain("AdminService/GetInstall");
  });

  it("says runs are kept with no time limit when the install keeps them forever", async () => {
    await renderAt("/runs", MEMBER, { "ExecutionService/ListExecutions": { executions: [RUN] } });
    expect(await screen.findByText(/Runs are kept with no time limit/)).toBeTruthy();
  });

  it("asks the server for your own runs, and lists the steps waiting for your team to approve", async () => {
    const asked: Record<string, unknown>[] = [];
    await renderAt("/runs", MEMBER, {
      "ExecutionService/ListExecutions": (request: Record<string, unknown>) => {
        asked.push(request);
        return { executions: [RUN] };
      },
      "ExecutionService/ListPendingApprovals": {
        approvals: [{ executionId: RUN.executionId, executionName: "orders-api prod database", taskId: "database", team: "gcp-platform", requestedBy: "sam@acme.com", canDecide: true }],
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Mine" }));
    await waitFor(() => { expect(asked.at(-1)).toMatchObject({ mine: true }); });

    fireEvent.click(screen.getByRole("tab", { name: /to approve/i }));
    expect(await screen.findByRole("link", { name: "orders-api prod database" })).toBeTruthy();
    expect(screen.getByText("sam@acme.com")).toBeTruthy();
  });

  it("says when the runs couldn't be loaded, in their card, and tries again", async () => {
    let asked = 0;
    await renderAt("/runs", MEMBER, {
      // The list's first page fails once; the week's tiles (since set) load.
      "ExecutionService/ListExecutions": (request: Record<string, unknown>) =>
        request["since"] ? { executions: [RUN] } : asked++ === 0 ? refused(503, "unavailable", "kernel-api didn't answer.") : { executions: [RUN] },
    });
    const failed = await screen.findByText(/Couldn't load the runs: kernel-api didn't answer\. Nothing is wrong with the runs themselves\./, {}, { timeout: 5000 });
    expect(screen.queryByText(/No runs you can see yet/)).toBeNull();
    fireEvent.click(within(failed.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("orders-api first deploy")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load the runs/)).toBeNull();
  });

  it("says when the steps to approve or the schedules couldn't be loaded, never that there are none, and tries again", async () => {
    let approvalsAsked = 0;
    let schedulesAsked = 0;
    await renderAt("/runs", MEMBER, {
      "ExecutionService/ListExecutions": { executions: [RUN] },
      "ExecutionService/ListPendingApprovals": () =>
        approvalsAsked++ === 0
          ? refused(503, "unavailable", "kernel-api didn't answer.")
          : { approvals: [{ executionId: RUN.executionId, executionName: "orders-api prod database", taskId: "database", team: "azure-apps", requestedBy: "sam@acme.com", canDecide: true }] },
      "ScheduleService/ListSchedules": () => (schedulesAsked++ === 0 ? refused(503, "unavailable", "kernel-api didn't answer.") : { schedules: [] }),
    });
    const failed = await screen.findByText(/Couldn't load the steps waiting for your approval: kernel-api didn't answer\./, {}, { timeout: 5000 });
    fireEvent.click(screen.getByRole("tab", { name: /to approve/i }));
    expect(screen.queryByText("Nothing waits for your teams to approve.")).toBeNull();
    fireEvent.click(within(failed.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "orders-api prod database" })).toBeTruthy();
    expect(screen.queryByText(/Couldn't load the steps/)).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /schedules/i }));
    const noSchedules = await screen.findByText(/Couldn't load your teams' schedules: kernel-api didn't answer\./);
    fireEvent.click(within(noSchedules.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Try again" }));
    await waitFor(() => { expect(screen.queryByText(/Couldn't load your teams' schedules/)).toBeNull(); });
    expect(schedulesAsked).toBe(2);
  });

  it("counts the week's runs, filters by kind, and says who started each", async () => {
    const DAG = { ...RUN, executionId: "1b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a12", name: "kafka topics backfill", template: "", state: "EXECUTION_STATE_FAILED", submittedBy: "u9", submittedByEmail: "sam@acme.com" };
    const GONE = { ...RUN, executionId: "2b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a13", name: "old cleanup", template: "", state: "EXECUTION_STATE_SUCCEEDED" };
    const CHECK = { ...RUN, executionId: "3b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a14", name: "Check: gcp-platform-project-ready", template: "check", state: "EXECUTION_STATE_SUCCEEDED" };
    await renderAt("/runs", MEMBER, { "ExecutionService/ListExecutions": { executions: [{ ...RUN, submittedBy: MEMBER.userId, submittedByEmail: MEMBER.email }, DAG, GONE, CHECK] } });
    expect(await screen.findByText("kafka topics backfill")).toBeTruthy();
    expect(screen.getByText("sam@acme.com")).toBeTruthy();
    expect(screen.getByText("you")).toBeTruthy();
    expect(screen.getByText("a deleted account")).toBeTruthy();
    expect(screen.getByText("the readiness check")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /^Failed this week 1/ })).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Kind" }));
    fireEvent.click(await screen.findByRole("option", { name: "A DAG" }));
    await waitFor(() => { expect(screen.queryByText("orders-api first deploy")).toBeNull(); });
    expect(screen.getByText("kafka topics backfill")).toBeTruthy();
  });

  it("shows a pressed tile's runs from the week it counts, and no numbers when states are unknown", async () => {
    const OLDER = { ...RUN, executionId: "3b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a14", name: "monday's failed backfill", state: "EXECUTION_STATE_FAILED" };
    // The first page holds only the newest run; the week (asked with since) holds the failure too.
    await renderAt("/runs", MEMBER, {
      "ExecutionService/ListExecutions": (request: Record<string, unknown>) => ({ executions: request["since"] ? [RUN, OLDER] : [RUN] }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Failed this week 1/ }));
    expect(await screen.findByText("monday's failed backfill")).toBeTruthy();
    expect(screen.queryByText("orders-api first deploy")).toBeNull();
    cleanup();

    // kernel-api didn't say any run's state: the tiles don't claim zero.
    await renderAt("/runs", MEMBER, { "ExecutionService/ListExecutions": { executions: [{ ...RUN, state: undefined }] } });
    expect(await screen.findByRole("button", { name: /^Failed this week —/ })).toBeTruthy();
  });

  it("lists every one of your teams' schedules together", async () => {
    const asked: string[] = [];
    await renderAt("/runs?view=schedules", { ...MEMBER, teamNames: ["payments", "ml"] }, {
      "ScheduleService/ListSchedules": (request: Record<string, unknown>) => {
        const team = String(request["team"]);
        asked.push(team);
        return { schedules: [{ id: `s-${team}`, team, name: `${team} nightly`, kind: "action", runnableName: "uptime-check.check", cron: "0 2 * * *", timeZone: "UTC", botEmail: `${team}@bots.vennir.local`, enabled: team === "ml" }] };
      },
    });
    expect(await screen.findByText("payments nightly")).toBeTruthy();
    expect(screen.getByText("ml nightly")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /schedules 2/i, selected: true })).toBeTruthy();
    expect(asked.sort()).toEqual(["ml", "payments"]);
  });
});

describe("what runs made", () => {
  const made = (id: string, name: string, state = "exists") => ({
    id,
    type: "gcp/project",
    externalId: `${name}-7f3`,
    name,
    product: "gcp-platform-project",
    productTeam: "gcp-platform",
    ownerTeam: "azure-apps",
    executionId: "0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11",
    taskId: "project",
    firstReportedAt: "2026-10-21T16:21:00Z",
    state,
    canDelete: true,
  });

  it("lists a delete sent to an admin at once", async () => {
    let requested = 0;
    await renderAt("/runs/made", MEMBER, {
      "ResourceService/ListResources": { resources: [made("a1b2c3d4-0000-4000-8000-000000000000", "bucket-0")] },
      "ResourceService/ListDeleteRequests": () => {
        requested++;
        return { requests: [] };
      },
      "ResourceService/DeleteResources": () => refused(409, "failed_precondition", "It's used: an admin has been asked.", "HAS_DEPENDENTS"),
    });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select bucket-0" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 1…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await screen.findByText("It's used: an admin has been asked.")).toBeTruthy();
    await waitFor(() => { expect(requested).toBe(2); }); // loaded again once asked
  });

  // 51 clicks, each re-rendering 51 rows: seconds on a CI runner.
  it("picks at most 50 to delete together", { timeout: 20_000 }, async () => {
    const many = Array.from({ length: 51 }, (_, i) => made(`a1b2c3d4-0000-4000-8000-${String(i).padStart(12, "0")}`, `bucket-${String(i)}`));
    await renderAt("/runs/made", MEMBER, { "ResourceService/ListResources": { resources: many } });
    await screen.findByRole("checkbox", { name: "Select bucket-0" });
    // Every row's box at once (looking each up by name is slow on 51 rows).
    for (const box of screen.getAllByRole("checkbox") as HTMLInputElement[]) if ((box.getAttribute("aria-label") ?? "").startsWith("Select bucket-")) fireEvent.click(box);
    expect(screen.getByText(/At most 50 at once: unselect 1/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete 51…" })).toHaveProperty("disabled", true);
  });

  it("counts by state, and deletes the ones picked in one cleanup run", async () => {
    const asked: Record<string, unknown>[] = [];
    const listed: Record<string, unknown>[] = [];
    const all = [
      made("a1b2c3d4-0000-4000-8000-000000000001", "payments-dev"),
      made("a1b2c3d4-0000-4000-8000-000000000002", "orders-api-dev"),
      made("a1b2c3d4-0000-4000-8000-000000000003", "scratch-bucket", "delete_failed"),
      made("a1b2c3d4-0000-4000-8000-000000000004", "old-bucket", "deleted"),
    ];
    await renderAt("/runs/made", MEMBER, {
      // As the server does: deleted ones only when asked for.
      "ResourceService/ListResources": (request: Record<string, unknown>) => {
        listed.push(request);
        return { resources: request["includeDeleted"] ? all : all.filter((r) => r.state !== "deleted") };
      },
      "ResourceService/DeleteResources": (request: Record<string, unknown>) => {
        asked.push(request);
        return { executionId: "9c9c9c9c-0000-4000-8000-000000000009" };
      },
    });
    expect(await screen.findByRole("button", { name: /^Made 2/ })).toBeTruthy();
    // Deleted ones aren't even fetched until asked for: they'd crowd the newest 200.
    expect(listed[0]?.["includeDeleted"]).toBeFalsy();
    expect(screen.getByRole("button", { name: /^Deleted —/ })).toBeTruthy();
    expect(screen.queryByText("old-bucket")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Deleted —/ }));
    expect(await screen.findByText("old-bucket")).toBeTruthy();
    expect(listed.at(-1)?.["includeDeleted"]).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Deleted 1/ }));

    fireEvent.click(screen.getByRole("checkbox", { name: "Select payments-dev" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select orders-api-dev" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete 2…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(asked).toEqual([{ resourceIds: ["a1b2c3d4-0000-4000-8000-000000000001", "a1b2c3d4-0000-4000-8000-000000000002"] }]);
    });
  });
});

describe("a run", () => {
  const FAILED_RUN = {
    executionId: "0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11",
    name: "billing-api staging",
    state: "EXECUTION_STATE_FAILED",
    teams: ["azure-apps"],
    createdAt: "2026-10-21T16:20:00Z",
    tasks: [
      { taskId: "project", state: "TASK_STATE_SUCCEEDED", attemptCount: 1, attempts: [{ number: 1, startedAt: "2026-10-21T16:20:01Z", completedAt: "2026-10-21T16:21:00Z" }] },
      {
        taskId: "deploy",
        state: "TASK_STATE_FAILED",
        attemptCount: 1,
        dependsOn: ["project"],
        failure: { code: "REGION_QUOTA_EXCEEDED", message: "the region is out of quota", retryable: true },
        help: { means: "The project has used all its CPU in us-central1.", whatToDo: "Run again in europe-west1.", retry: "safe", team: "gcp-platform" },
        attempts: [{ number: 1, startedAt: "2026-10-21T16:21:01Z", completedAt: "2026-10-21T16:26:00Z", failure: { code: "REGION_QUOTA_EXCEEDED", message: "the region is out of quota", retryable: true } }],
      },
    ],
  };

  it("explains why it failed, and retries the failed step", async () => {
    const retried: Record<string, unknown>[] = [];
    await renderAt(`/runs/${FAILED_RUN.executionId}`, MEMBER, {
      "ExecutionService/WatchExecution": [{ execution: FAILED_RUN }],
      "ExecutionService/RetryTask": (request: Record<string, unknown>) => {
        retried.push(request);
        return {};
      },
    });
    expect(await screen.findByRole("heading", { name: /step 2, deploy: the region is out of quota/i })).toBeTruthy();
    expect(screen.getByText(/failed at step 2 of 2/i)).toBeTruthy();
    expect(screen.getAllByText("REGION_QUOTA_EXCEEDED").length).toBeGreaterThan(0);
    expect(screen.getByText(/run again in europe-west1/i)).toBeTruthy();
    // The failed step is the one shown below the timeline.
    expect(screen.getByRole("button", { name: /deploy/i, pressed: true })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry deploy" }));
    await waitFor(() => { expect(retried).toEqual([{ executionId: FAILED_RUN.executionId, taskId: "deploy" }]); });
  });

  it("offers Ask Vennir about a failure, with the question in its box to send", async () => {
    let asked = 0;
    await renderAt(`/runs/${FAILED_RUN.executionId}`, MEMBER, {
      "ExecutionService/WatchExecution": [{ execution: FAILED_RUN }],
      "ChatService/GetChatSettings": { enabled: true, model: "qwen3.8-27b" },
      "ChatService/AskStream": () => {
        asked++;
        return [];
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Ask Vennir about it" }));
    const box = (await screen.findByLabelText("Your question")) as HTMLTextAreaElement;
    // Only what Vennir itself says: the run's id and the step's position, never the product's code or the step's id.
    await waitFor(() => { expect(box.value).toBe(`Why did run ${FAILED_RUN.executionId} fail at step 2, and what should I do?`); });
    expect(asked).toBe(0);
  });

  it("shows what uses what, and lets an admin approve a delete that others depended on", async () => {
    const project = { id: "a1b2c3d4-0000-4000-8000-0000000000a1", type: "gcp/project", externalId: "web-prod", executionId: FAILED_RUN.executionId, input: "" };
    const service = { id: "a1b2c3d4-0000-4000-8000-0000000000a2", type: "gcp/cloud-run-service", externalId: "shop-api", executionId: FAILED_RUN.executionId, input: "projectId" };
    const decided: Record<string, unknown>[] = [];
    await renderAt("/runs/made", ADMIN, {
      "ResourceService/ListResources": {
        resources: [
          { ...project, name: "", product: "gcp-project-create", productTeam: "gcp", ownerTeam: "azure-apps", taskId: "project", firstReportedAt: "2026-10-21T16:21:00Z", state: "exists", canDelete: true, dependents: [service] },
        ],
      },
      "ResourceService/ListDeleteRequests": {
        requests: [{ id: "d1d1d1d1-0000-4000-8000-000000000001", resources: [project], dependents: [service], requestedBy: "bo@acme.com", createdAt: "2026-10-27T10:00:00Z" }],
      },
      "ResourceService/DecideDeleteRequest": (request: Record<string, unknown>) => {
        decided.push(request);
        return { executionId: "9c9c9c9c-0000-4000-8000-000000000009" };
      },
    });
    // In the table, and on the request.
    expect(await screen.findByText("Used by shop-api")).toBeTruthy();
    expect(screen.getAllByText("shop-api").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: /^Waiting for an admin/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve and delete" }));
    await waitFor(() => { expect(decided).toEqual([{ id: "d1d1d1d1-0000-4000-8000-000000000001", approve: true }]); });
  });

  it("asks an admin when something else still uses what Delete all would delete", async () => {
    const outside = { id: "c1c1c1c1-0000-4000-8000-0000000000c1", type: "gcp/cloud-run-service", externalId: "shop-api", executionId: "other", input: "projectId" };
    const project = { id: "a1b2c3d4-0000-4000-8000-000000000001", type: "gcp/project", externalId: "web-prod", name: "web-prod", product: "gcp-platform-project-create", productTeam: "gcp-platform", ownerTeam: "azure-apps", executionId: FAILED_RUN.executionId, taskId: "project", firstReportedAt: "2026-10-21T16:21:00Z", state: "exists", canDelete: true, dependents: [outside] };
    await renderAt(`/runs/${FAILED_RUN.executionId}`, MEMBER, {
      "ExecutionService/WatchExecution": [{ execution: FAILED_RUN }],
      "ResourceService/ListResources": { resources: [project, { ...project, id: "a1b2c3d4-0000-4000-8000-000000000002", externalId: "web-db", name: "web-db", dependents: [] }] },
      "ResourceService/DeleteRunResources": () => refused(409, "failed_precondition", "Other resources use these: an admin has been asked.", "HAS_DEPENDENTS"),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Delete all 2…" }));
    expect(await screen.findByText(/still use some of these, so they're deleted only if an admin approves/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask an admin" }));
    // Said as what happened, not as an error.
    const said = await screen.findByText("Other resources use these: an admin has been asked.");
    expect(said.closest(".MuiAlert-colorInfo")).toBeTruthy();
  });

  it("shows what it made, and deletes it all as a cleanup run", async () => {
    const made = (id: string, name: string) => ({
      id,
      type: "gcp/project",
      externalId: `${name}-7f3`,
      name,
      link: "https://console.cloud.google.com/home?project=x",
      product: "gcp-platform-project-create",
      productTeam: "gcp-platform",
      ownerTeam: "azure-apps",
      executionId: FAILED_RUN.executionId,
      taskId: "project",
      firstReportedAt: "2026-10-21T16:21:00Z",
      state: "exists",
      canDelete: true,
    });
    const asked: Record<string, unknown>[] = [];
    await renderAt(`/runs/${FAILED_RUN.executionId}`, MEMBER, {
      "ExecutionService/WatchExecution": [{ execution: FAILED_RUN }],
      "ResourceService/ListResources": { resources: [made("a1b2c3d4-0000-4000-8000-000000000001", "billing-api"), made("a1b2c3d4-0000-4000-8000-000000000002", "billing-db")] },
      "ResourceService/DeleteRunResources": (request: Record<string, unknown>) => {
        asked.push(request);
        return { executionId: "9c9c9c9c-0000-4000-8000-000000000009" };
      },
    });
    expect(await screen.findByRole("heading", { name: "What it made before failing" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /billing-db/ }).getAttribute("href")).toBe("https://console.cloud.google.com/home?project=x");
    fireEvent.click(screen.getByRole("button", { name: "Delete all 2…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete all", hidden: false }));
    await waitFor(() => { expect(asked).toEqual([{ executionId: FAILED_RUN.executionId }]); });
  });

  it("says what a step waiting its turn is waiting for", async () => {
    const waiting = {
      ...FAILED_RUN,
      state: "EXECUTION_STATE_RUNNING",
      tasks: [{ taskId: "project", state: "TASK_STATE_READY", attemptCount: 0, attempts: [], waitingFor: { projectId: "orders-api" } }],
    };
    await renderAt(`/runs/${FAILED_RUN.executionId}`, MEMBER, { "ExecutionService/WatchExecution": [{ execution: waiting }] });
    expect(await screen.findByText(/another run is changing the same projectId \(orders-api\)/i)).toBeTruthy();
  });

  it("shows another step when it's picked on the timeline", async () => {
    await renderAt(`/runs/${FAILED_RUN.executionId}`, MEMBER, { "ExecutionService/WatchExecution": [{ execution: FAILED_RUN }] });
    fireEvent.click(await screen.findByRole("button", { name: /^project/i }));
    expect(screen.getByRole("heading", { name: "project" })).toBeTruthy();
    expect(screen.getByText(/attempt 1 · succeeded after 59s/i)).toBeTruthy();
  });
});

describe("the catalog", () => {
  const CATALOG = {
    runnables: [
      {
        kind: "KIND_TEMPLATE",
        team: "gcp-platform",
        name: "app-on-cloud-run",
        displayName: "App on Cloud Run",
        description: "A project, an image and a Cloud Run service.",
        parameters: { type: "object", properties: { projectId: { type: "string" }, region: { type: "string" } } },
        actions: ["gcp-platform/project.create", "gcp-platform/app-hosting.create"],
        shared: true,
        sourceUrl: "https://github.com/acme/vennir-catalog/blob/main/teams/gcp-platform/templates/app.yaml",
      },
      {
        kind: "KIND_ACTION",
        team: "aws-platform",
        name: "rds",
        displayName: "RDS for PostgreSQL",
        actions: ["aws-platform/rds.create"],
        shared: false,
        shareWith: ["data-team"],
        askForAccessUrl: "https://github.com/acme/vennir-catalog/issues/new?title=rds",
      },
    ],
  };

  it("shows what you can run and what you can ask for, by team", async () => {
    await renderAt("/catalog", MEMBER, { "TemplateService/ListTemplates": CATALOG });
    expect(await screen.findByRole("heading", { name: "App on Cloud Run" })).toBeTruthy();
    expect(screen.getByText("projectId, region")).toBeTruthy();
    expect(screen.getByText("gcp-platform · template · 2 steps")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Run" }).getAttribute("href")).toBe("/catalog/run?template=gcp-platform%2Fapp-on-cloud-run");
    expect(screen.getByRole("link", { name: /ask for access/i }).getAttribute("href")).toContain("issues/new");
    expect(screen.getByRole("link", { name: /catalog repository/i }).getAttribute("href")).toBe("https://github.com/acme/vennir-catalog");

    fireEvent.click(screen.getByRole("button", { name: "aws-platform" }));
    expect(screen.queryByRole("heading", { name: "App on Cloud Run" })).toBeNull();
    expect(screen.getByRole("heading", { name: "RDS for PostgreSQL" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "All teams" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /only what i can run/i }));
    expect(screen.queryByRole("heading", { name: "RDS for PostgreSQL" })).toBeNull();
    expect(screen.getByRole("heading", { name: "App on Cloud Run" })).toBeTruthy();
  });
});

describe("the docs", () => {
  it("lists the platform's docs as the reference, and finds a section by search", async () => {
    await renderAt("/docs/01-getting-started", MEMBER, {
      "GuideService/ListGuides": {
        guides: [
          { id: "01-getting-started", title: "Getting started", section: "guides" },
          { id: "reference-operations", title: "Operations", section: "reference" },
        ],
      },
      "GuideService/GetGuide": { markdown: "# Getting started\n\nHello." },
      "GuideService/SearchGuides": { hits: [{ guide: "reference-operations", title: "Operations", heading: "Databases > Backups", excerpt: "Back up both databases nightly." }] },
    });
    expect(await screen.findByText("Reference")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search the guides"), { target: { value: "back up" } });
    const hit = await screen.findByRole("link", { name: /^Backups\s*in Operations/ });
    expect(hit.getAttribute("href")).toBe("/docs/reference-operations#backups");
    // The words searched for, marked in the excerpt.
    expect(within(hit).getByText("Back").tagName).toBe("MARK");
  });

  const DOCS = {
    "GuideService/ListGuides": {
      guides: [
        { id: "01-getting-started", title: "Try Vennir end to end", section: "guides", kind: "guide" },
        { id: "03-what-is-a-dag", title: "What's a DAG", section: "guides", kind: "guide" },
        { id: "reference-setup", title: "Setting up Vennir", section: "reference", kind: "operating" },
        {
          id: "reference-operations",
          title: "Operations",
          section: "reference",
          kind: "operating",
          sections: [
            { title: "Upgrading", anchor: "upgrading" },
            { title: "Backups", anchor: "backups" },
          ],
        },
        { id: "09-something-new", title: "Something new", section: "guides", kind: "guide" },
      ],
    },
    "GuideService/GetGuide": {
      markdown: "# Operations\n\nRunning it.\n\n## Upgrading\n\nUp.\n\n### Reused tags\n\nTags.\n\n```\n## not a section\n```\n\n### Rolling back\n\nBack.\n\n## Backups\n\nNightly.",
    },
  };

  it("opens on a home by task, linking only the guides this console serves", async () => {
    await renderAt("/docs", MEMBER, DOCS);
    const start = await screen.findByRole("region", { name: "New here? Start with these two" });
    expect(within(start).getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["/docs/01-getting-started", "/docs/03-what-is-a-dag"]);
    const tasks = screen.getByRole("region", { name: "What are you trying to do?" });
    // Of the tasks, only Install and operate has a guide served here.
    expect(within(tasks).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Install and operate"]);
    expect(within(tasks).getByRole("link", { name: "Upgrading, backups, rotating secrets" }).getAttribute("href")).toBe("/docs/reference-operations#upgrading");
    expect(within(tasks).getByRole("link", { name: "All guides, in reading order" }).getAttribute("href")).toBe("/docs/01-getting-started");
    // Nothing to offer without a model.
    expect(screen.queryByRole("button", { name: "Ask Vennir instead" })).toBeNull();
  });

  it("offers Ask Vennir from the help when there's a model", async () => {
    await renderAt("/docs", MEMBER, { ...DOCS, "ChatService/GetChatSettings": { enabled: true, model: "qwen3.8-27b" } });
    fireEvent.click(await screen.findByRole("button", { name: "Ask Vennir instead" }));
    expect(((await screen.findByLabelText("Your question")) as HTMLTextAreaElement).value).toBe("");
  });

  it("opens Ask with a page's question in the box (useAsk().open(question)): the help's search", async () => {
    await renderAt("/docs", MEMBER, {
      ...DOCS,
      "ChatService/GetChatSettings": { enabled: true, model: "qwen3.8-27b" },
      "GuideService/SearchGuides": { hits: [] },
    });
    fireEvent.change(await screen.findByLabelText("Search the guides"), { target: { value: "rotate a bot token" } });
    const results = await screen.findByRole("region", { name: "Search results" });
    fireEvent.click(within(results).getByRole("button", { name: "Ask Vennir" }));
    await waitFor(() => { expect((screen.getByLabelText("Your question") as HTMLTextAreaElement).value).toBe("rotate a bot token"); });
  });

  it("sends what's asked in Home's Ask box at once (useAsk().open(question, { send: true }))", async () => {
    let asked = 0;
    await renderAt("/", MEMBER, {
      "ChatService/GetChatSettings": { enabled: true, model: "qwen3.8-27b" },
      "ChatService/AskStream": () => {
        asked++;
        return [{ answer: { text: "Its step ran out of memory." } }];
      },
    });
    fireEvent.change(await screen.findByRole("textbox", { name: "Ask Vennir" }), { target: { value: "Why did my run fail?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("Its step ran out of memory.")).toBeTruthy();
    expect(asked).toBe(1);
  });

  it("never drops a question asked while one is being answered: it waits in the box", async () => {
    await renderAt("/", MEMBER, {
      "ChatService/GetChatSettings": { enabled: true, model: "qwen3.8-27b" },
      // The first answer never comes, so it's busy.
      "ChatService/AskStream": () => new Promise(() => {}),
    });
    const box = await screen.findByRole("textbox", { name: "Ask Vennir" });
    fireEvent.change(box, { target: { value: "Why did my run fail?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    const question = (await screen.findByLabelText("Your question")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "And what should I do?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask", hidden: true }));
    await waitFor(() => { expect(question.value).toBe("And what should I do?"); });
  });

  it("opens the console's own pages from an answer in the console, and others in a new tab", async () => {
    await renderAt("/", MEMBER, {
      "ChatService/GetChatSettings": { enabled: true, model: "qwen3.8-27b" },
      "ChatService/AskStream": () => [{ answer: { text: "See [your runs](/runs) or [the status page](https://status.example.com)." } }],
    });
    fireEvent.change(await screen.findByRole("textbox", { name: "Ask Vennir" }), { target: { value: "Where are my runs?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    const external = await screen.findByRole("link", { name: "the status page" });
    expect(external.getAttribute("target")).toBe("_blank");
    expect(external.getAttribute("rel")).toContain("noopener");
    fireEvent.click(screen.getByRole("link", { name: "your runs" }));
    // The Runs page, in the console (no reload), with the panel closed for it.
    expect(await screen.findByRole("heading", { level: 1, name: "Runs" })).toBeTruthy();
    await waitFor(() => { expect(screen.queryByRole("dialog", { name: "Ask Vennir" })).toBeNull(); });
  });

  it("keeps the help's contents loaded moving from one guide to another", async () => {
    const titles: Record<string, string> = { "01-getting-started": "Try Vennir end to end" };
    await renderAt("/docs/01-getting-started", MEMBER, {
      ...DOCS,
      "GuideService/GetGuide": (request: Record<string, unknown>) => ({ markdown: `# ${titles[String(request["id"])] ?? "?"}\n\nIts text.` }),
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Try Vennir end to end" })).toBeTruthy();
    const listed = calls.filter((c) => c === "GuideService/ListGuides").length;
    // Any link to another guide (the side contents, or Next).
    const other = screen.getAllByRole("link").find((l) => (l.getAttribute("href") ?? "").startsWith("/docs/0") && !(l.getAttribute("href") ?? "").startsWith("/docs/01-"));
    expect(other).toBeTruthy();
    const guides = calls.filter((c) => c === "GuideService/GetGuide").length;
    fireEvent.click(other!);
    await waitFor(() => { expect(calls.filter((c) => c === "GuideService/GetGuide").length).toBe(guides + 1); });
    // The new guide is fetched; the list of guides isn't fetched again.
    expect(calls.filter((c) => c === "GuideService/ListGuides").length).toBe(listed);
  });

  it("forgets a guide that failed to load once another opens", async () => {
    await renderAt("/docs/old-guide", MEMBER, {
      ...DOCS,
      "GuideService/GetGuide": (request: Record<string, unknown>) =>
        request["id"] === "old-guide" ? refused(404, "not_found", "No such guide.") : { markdown: "# Try Vennir end to end\n\nIts text." },
    });
    expect((await screen.findByRole("alert")).textContent).toContain("No such guide.");
    screen.getByRole("button", { name: "Settings" }).click();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Help and guides" }));
    const start = await screen.findByRole("region", { name: "New here? Start with these two" });
    expect(screen.queryByText("No such guide.")).toBeNull();
    fireEvent.click(within(start).getAllByRole("link").find((l) => l.getAttribute("href") === "/docs/01-getting-started")!);
    expect(await screen.findByRole("heading", { level: 1, name: "Try Vennir end to end" })).toBeTruthy();
  });

  it("shows the guide that's open, not one whose answer came late", async () => {
    let answerFirst: (value: unknown) => void = () => {};
    await renderAt("/docs/03-what-is-a-dag", MEMBER, {
      ...DOCS,
      "GuideService/GetGuide": (request: Record<string, unknown>) =>
        request["id"] === "03-what-is-a-dag"
          ? new Promise((resolve) => { answerFirst = resolve; })
          : { markdown: "# Try Vennir end to end\n\nIts text." },
    });
    const contents = await screen.findByRole("navigation", { name: "Docs contents" });
    fireEvent.click(within(contents).getByRole("link", { name: "Try Vennir end to end" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Try Vennir end to end" })).toBeTruthy();
    await act(async () => { answerFirst({ markdown: "# What's a DAG\n\nToo late." }); await Promise.resolve(); });
    expect(screen.queryByText("Too late.")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Try Vennir end to end" })).toBeTruthy();
  });

  it("sets a troubleshooting guide by symptom: what you see, why, and what to do", async () => {
    await renderAt("/docs/15-troubleshooting", MEMBER, {
      "GuideService/ListGuides": { guides: [{ id: "15-troubleshooting", title: "Troubleshooting", section: "guides", kind: "guide" }] },
      "GuideService/GetGuide": {
        markdown: "# Troubleshooting\n\nBy what you see.\n\n## My step is Ready but not running\n\n**What you see:** the step stays **Ready**.\n\n**Why:** something holds it.\n\n**What to do:** wait.\n\n## I can't sign in\n\nAsk.",
      },
    });
    const symptoms = await screen.findByRole("region", { name: "What do you see?" });
    // The symptoms whose sections the guide has, each to its section.
    expect(within(symptoms).getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["#my-step-is-ready-but-not-running", "#i-cant-sign-in"]);
    expect(screen.getByText("What you see").nextElementSibling?.textContent).toBe("The step stays Ready.");
    expect(screen.getByText("What to do").nextElementSibling?.textContent).toBe("Wait.");
  });

  it("lists a doc the contents don't place under More", async () => {
    await renderAt("/docs/01-getting-started", MEMBER, { ...DOCS, "GuideService/GetGuide": { markdown: "# Try Vennir end to end\n\nHello." } });
    const contents = await screen.findByRole("navigation", { name: "Docs contents" });
    fireEvent.click(await within(contents).findByRole("button", { name: "More" }));
    expect((await within(contents).findByRole("link", { name: "Something new" })).getAttribute("href")).toBe("/docs/09-something-new");
  });

  it("shows a long doc a section to a page, nested under it, with the pages before and after", async () => {
    await renderAt("/docs/reference-operations/upgrading", MEMBER, DOCS);
    const trail = await screen.findByRole("navigation", { name: "Where this is" });
    expect(await within(trail).findByText("Install and operate")).toBeTruthy();
    expect(within(trail).getByRole("link", { name: "Operations" }).getAttribute("href")).toBe("/docs/reference-operations");
    expect(within(trail).getByText("Run it")).toBeTruthy();
    // Only this section, its headings a level up.
    expect(await screen.findByRole("heading", { level: 1, name: "Upgrading" })).toBeTruthy();
    expect(screen.queryByText("Nightly.")).toBeNull();
    const contents = screen.getByRole("navigation", { name: "Docs contents" });
    for (const open of ["Install and operate", "Operations", "Run it"]) {
      expect(within(contents).getByRole("button", { name: open }).getAttribute("aria-expanded")).toBe("true");
    }
    expect(within(contents).getByRole("button", { name: "Get started" }).getAttribute("aria-expanded")).toBe("false");
    expect(within(contents).getByRole("link", { name: "Upgrading" }).getAttribute("aria-current")).toBe("page");
    const sections = screen.getByRole("navigation", { name: "On this page" });
    expect(within(sections).getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["#reused-tags", "#rolling-back"]);
    expect(within(trail).getByText("Upgrading").getAttribute("aria-current")).toBe("page");
    const onward = screen.getByRole("navigation", { name: "Previous and next" });
    expect(within(onward).getByRole("link", { name: /Previous\s*Operations/ }).getAttribute("href")).toBe("/docs/reference-operations");
    expect(within(onward).getByRole("link", { name: /Next\s*Backups/ }).getAttribute("href")).toBe("/docs/reference-operations/backups");
  });

  it("draws a doc's figure, and opens it and a linked one at full size", async () => {
    const asked: string[] = [];
    await renderAt("/docs/reference-architecture", MEMBER, {
      "GuideService/ListGuides": { guides: [{ id: "reference-architecture", title: "Architecture", section: "reference", kind: "current" }] },
      "GuideService/GetGuide": { markdown: "# Architecture\n\n![The pieces: what runs where](architecture/6-the-pieces.svg)\n\nIn full: [the system diagram](architecture/1-system.svg)." },
      "GuideService/GetGuideImage": (body: Record<string, unknown>) => {
        asked.push(String(body["path"]));
        return { svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>" };
      },
    });
    const figure = await screen.findByRole("img", { name: /The pieces: what runs where/ });
    await waitFor(() => { expect(figure.getAttribute("src")).toMatch(/^data:image\/svg\+xml/); });
    expect(figure.closest("p")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "the system diagram" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("img", { name: "The system diagram" })).toBeTruthy();
    expect(asked).toEqual(["architecture/6-the-pieces.svg", "architecture/1-system.svg"]);
  });

  it("opens a link to a heading in a long doc on the page that heading is on", async () => {
    await renderAt("/docs/reference-operations#reused-tags", MEMBER, DOCS);
    expect(await screen.findByRole("heading", { level: 1, name: "Upgrading" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Reused tags" })).toBeTruthy();
  });
});

describe("the chat panel", () => {
  it("isn't there without a model, and answers with its sources and a cart to open", async () => {
    const asked: Record<string, unknown>[] = [];
    const rated: Record<string, unknown>[] = [];
    await renderAt("/", MEMBER, {
      "ChatService/GetChatSettings": { enabled: true, model: "qwen3.8-27b" },
      "ChatService/AskStream": (request: Record<string, unknown>) => {
        asked.push(request);
        const answer = {
          text: "Back up both databases nightly [S1]. Here's a cart for a bucket.",
          citations: [
            { id: "S1", guide: "reference-operations", title: "Operations", heading: "Backups", kind: "operating", link: "/docs/reference-operations#backups" },
            { id: "S2", guide: "reference-assessment", title: "Assessment", heading: "17. Decisions", kind: "history", link: "/docs/reference-assessment#17-decisions" },
          ],
          cart: {
            team: "azure-apps",
            actions: ["azure-apps-bucket-create"],
            choices: [{ step: "bucket", input: "account", resourceId: "r-1", label: "shop (storage)" }],
            values: { bucket: { name: "shop-assets" } },
          },
          steps: [{ tool: "search_docs", ok: true }, { tool: "propose_cart", ok: true }],
        };
        // Its steps as it takes them, then the answer.
        return [{ step: { tool: "search_docs", ok: true } }, { step: { tool: "propose_cart", ok: true } }, { answer }];
      },
      "ChatService/RateAnswer": (request: Record<string, unknown>) => {
        rated.push(request);
        return {};
      },
      "TemplateService/ListTemplates": { runnables: [] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Ask Vennir" }));
    fireEvent.change(await screen.findByLabelText("Your question"), { target: { value: "How do I back up?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("link", { name: "Operations · Backups" })).getAttribute("href")).toBe("/docs/reference-operations#backups");
    // Cited in the answer by the number it has in the list.
    expect(screen.getByRole("link", { name: "Source 1" }).textContent).toBe("[1]");
    expect(screen.getByText(/design history: why, not how it works now/)).toBeTruthy();
    expect(screen.getByText("Searched the guides, filled a cart")).toBeTruthy();
    expect(asked).toMatchObject([{ team: "azure-apps", messages: [{ role: "user", content: "How do I back up?" }] }]);
    // A wrong answer goes to the admins with its question, and what was wrong.
    fireEvent.click(screen.getByRole("button", { name: "Wrong answer" }));
    fireEvent.change(await screen.findByLabelText("What was wrong?"), { target: { value: "Only the kernel's is nightly" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Send" })[0]!);
    expect(await screen.findByText(/sent to your admins, to fix/)).toBeTruthy();
    expect(rated).toMatchObject([
      {
        rating: "down",
        team: "azure-apps",
        question: "How do I back up?",
        answer: "Back up both databases nightly [S1]. Here's a cart for a bucket.",
        steps: ["search_docs", "propose_cart"],
        model: "qwen3.8-27b",
        comment: "Only the kernel's is nightly",
      },
    ]);
    expect(rated[0]?.citations).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Open in cart" }));
    expect(await screen.findByRole("heading", { name: "Cart" })).toBeTruthy();
    // With what the answer filled in, for the cart page to start from.
    expect(JSON.parse(localStorage.getItem("vennir.cart") ?? "{}")).toMatchObject({
      team: "azure-apps",
      actions: ["azure-apps-bucket-create"],
      choices: [{ step: "bucket", input: "account", resourceId: "r-1" }],
      values: { bucket: { name: "shop-assets" } },
    });
    const { cart } = await import("./cart");
    cart.clear();
  });

  it("says when a conversation is filling the model's window, and starts a new one when it's too long", async () => {
    let asked = 0;
    await renderAt("/", MEMBER, {
      "ChatService/GetChatSettings": { enabled: true, model: "claude-haiku-5-5" },
      "ChatService/AskStream": () => {
        asked++;
        return asked === 1
          ? [{ answer: { text: "The docs don't cover that.", contextPercent: 80 } }]
          : refused(429, "resource_exhausted", "This conversation is too long for the chat model: start a new one.", "CONVERSATION_TOO_LONG");
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Ask Vennir" }));
    fireEvent.change(await screen.findByLabelText("Your question"), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/80% of what the model can take/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "second" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/too long for the chat model/)).toBeTruthy();
    // The question waits in the box, to ask in a new conversation.
    expect((screen.getByLabelText("Your question") as HTMLTextAreaElement).value).toBe("second");
    fireEvent.click(screen.getAllByRole("button", { name: "New conversation" })[0]!);
    await waitFor(() => { expect(screen.queryByText("first")).toBeNull(); });
    expect(screen.queryByText(/too long for the chat model/)).toBeNull();
  });

  it("is there but off when no model is set, saying who sets one", async () => {
    await renderAt("/", MEMBER, { "ChatService/GetChatSettings": { enabled: false } });
    const ask = await screen.findByRole("button", { name: "Ask Vennir" });
    expect(ask.hasAttribute("disabled") || ask.getAttribute("aria-disabled") === "true").toBe(true);
    expect(screen.getByLabelText("Not set up yet: an admin chooses its model")).toBeTruthy();
  });
});

describe("the cart", () => {
  it("says when what its steps ask for couldn't be loaded, and won't place it until it is", async () => {
    const { cart } = await import("./cart");
    cart.add("gcp-app-hosting-create");
    let asked = 0;
    const action = { kind: "KIND_ACTION", team: "gcp", name: "gcp-app-hosting-create", displayName: "App hosting", parameters: { type: "object", properties: {} }, actions: ["gcp/app-hosting.create"], shared: true };
    await renderAt("/catalog/cart", MEMBER, {
      "TemplateService/ListTemplates": () => (asked++ === 0 ? refused(503, "unavailable", "The console is restarting.") : { runnables: [action] }),
      "OrderService/PreviewOrder": { steps: [{ id: "app-hosting", product: "gcp-app-hosting-create", inputs: {} }] },
    });
    const failed = await screen.findByText(/Couldn't load what the steps ask for: The console is restarting\. Their inputs can't be asked until it is\./, {}, { timeout: 5000 });
    await waitFor(() => { expect((screen.getByRole("button", { name: "Place order" }) as HTMLButtonElement).disabled).toBe(true); });
    fireEvent.click(within(failed.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Try again" }));
    await waitFor(() => { expect((screen.getByRole("button", { name: "Place order" }) as HTMLButtonElement).disabled).toBe(false); });
    expect(screen.queryByText(/Couldn't load what the steps ask for/)).toBeNull();
    cart.clear();
  });

  it("plans the cart for your team, offers what's there, and places it with what you fill in", async () => {
    const { cart } = await import("./cart");
    cart.add("gcp-app-hosting-create");
    const placed: Record<string, unknown>[] = [];
    const step = (projectId: Record<string, unknown>) => ({
      id: "app-hosting",
      product: "gcp-app-hosting-create",
      inputs: { serviceName: { kind: "unset" }, region: { kind: "parameter", parameter: "gcp.region" }, projectId },
    });
    const options = [
      { step: "app-hosting", input: "projectId", resourceId: "r1", label: "web-prod (gcp/project)" },
      { step: "app-hosting", input: "projectId", addNew: true, label: "A new one (gcp-project-create)" },
    ];
    await renderAt("/catalog/cart", MEMBER, {
      "TemplateService/ListTemplates": {
        runnables: [
          {
            kind: "KIND_ACTION",
            team: "gcp",
            name: "gcp-app-hosting-create",
            displayName: "App hosting",
            parameters: { type: "object", required: ["serviceName"], properties: { serviceName: { type: "string", title: "Service name" }, projectId: { type: "string" }, region: { type: "string" } } },
            actions: ["gcp/app-hosting.create"],
            shared: true,
          },
        ],
      },
      "OrderService/PreviewOrder": (request: Record<string, unknown>) =>
        Array.isArray(request["choices"]) && request["choices"].length > 0
          ? { steps: [step({ kind: "resource", resourceId: "r1", value: "web-prod" })] }
          : { steps: [step({ kind: "unset" })], problems: [{ code: "CHOOSE_EXISTING", step: "app-hosting", input: "projectId", message: "Use one you already have, or add a new one.", options }] },
      "OrderService/PlaceOrder": (request: Record<string, unknown>) => {
        placed.push(request);
        return { executionId: "9c9c9c9c-0000-4000-8000-000000000009" };
      },
    });
    expect(await screen.findByRole("heading", { name: "App hosting" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Place order" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /web-prod \(gcp\/project\)/ }));
    expect(await screen.findByText("Uses web-prod (gcp/project)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Service name/), { target: { value: "shop-api" } });
    fireEvent.change(screen.getByLabelText(/gcp\.region/), { target: { value: "us-central1" } });
    fireEvent.click(screen.getByRole("button", { name: "Place order" }));
    await waitFor(() => {
      expect(placed).toMatchObject([
        {
          team: "azure-apps",
          actions: ["gcp-app-hosting-create"],
          choices: [{ step: "app-hosting", input: "projectId", resourceId: "r1" }],
          values: { "app-hosting": { serviceName: "shop-api" } },
          parameters: { "gcp.region": "us-central1" },
        },
      ]);
    });
    cart.clear();
  });
});

describe("an API", () => {
  const ORDERS = { team: "payments", name: "orders", displayName: "Orders API", state: "API_STATE_LIVE", mayCall: true, endpoints: [{ method: "GET", path: "/orders/{id}", summary: "One order" }], perMinute: 600 };

  it("tells a caller how to call it, without its team's traffic, backend or logs", async () => {
    await renderAt("/apis/payments/orders", MEMBER, { "ApiService/GetApi": { api: ORDERS, openapi: "{}" } });
    expect(await screen.findByRole("heading", { name: "Orders API" })).toBeTruthy();
    expect(screen.getByText(/curl -X GET/)).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "On this page" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Requests" })).toBeNull();
    expect(calls).not.toContain("ApiService/GetApiTraffic");
    expect(calls).not.toContain("ObserveService/SearchLogs");
  });

  it("says it can't serve, why, and where to fix it, while the gateway can't use its spec", async () => {
    const broken = {
      ...ORDERS,
      state: "API_STATE_UNAVAILABLE",
      problem: "its OpenAPI document can't be used: a $ref that isn't there",
      problemFoundAt: "2026-10-30T14:02:00Z",
      sourcePath: "teams/payments/apis/orders/api.yaml",
    };
    await renderAt("/apis/payments/orders", MEMBER, { "ApiService/GetApi": { api: broken, openapi: "{}" } });
    expect(await screen.findByText("Can’t serve")).toBeTruthy();
    expect(screen.getByText(/every call gets 503 and nothing reaches the backend/)).toBeTruthy();
    expect(screen.getByText("its OpenAPI document can't be used: a $ref that isn't there")).toBeTruthy();
    expect(screen.getByText("teams/payments/apis/orders/api.yaml")).toBeTruthy();
  });

  it("offers whoever it isn't shared with an issue asking its team", async () => {
    const theirs = { ...ORDERS, mayCall: false, askForAccessUrl: "https://github.com/acme/catalog/issues/new?title=orders" };
    await renderAt("/apis/payments/orders", MEMBER, { "ApiService/GetApi": { api: theirs, openapi: "{}" } });
    expect((await screen.findByRole("link", { name: "Ask for access ↗" })).getAttribute("href")).toBe("https://github.com/acme/catalog/issues/new?title=orders");
  });

  it("tells someone in no team to join one, rather than asking for an API shared with everyone", async () => {
    await renderAt("/apis/payments/orders", { ...ADMIN, teamNames: [], maintainerOf: [] }, { "ApiService/GetApi": { api: { ...ORDERS, mayCall: false }, openapi: "{}" } });
    expect(await screen.findByText(/You're in no team, and calls are made as one of your teams/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Ask for access ↗" })).toBeNull();
  });

  it("shows its own team each endpoint's traffic, its backend's logs, and lets a maintainer pause it", async () => {
    const paused: Record<string, unknown>[] = [];
    await renderAt("/apis/payments/orders", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "ApiService/GetApi": { api: { ...ORDERS, backendUrl: "https://orders.internal", sourcePath: "teams/payments/apis/orders/api.yaml" }, openapi: "{}" },
      "ApiService/GetApiTraffic": {
        requests: "120",
        forwarded: "100",
        stopped: "20",
        endpoints: [
          { endpoint: "GET /orders/{id}", requests: "4321", backend5xx: "7" },
          // Unauthenticated probes on a path the spec never had.
          { endpoint: "GET /wp-login.php", requests: "5000" },
        ],
        blocked: [{ request: "DELETE /orders/x", count: "9", teams: ["growth"] }],
        teams: [
          { team: "growth", requests: "120", peakPerMinute: "57", limitPerMinute: 60 },
          { team: "", requests: "5000", peakPerMinute: "900" },
        ],
      },
      "ObserveService/SearchLogs": { lines: [{ team: "payments", app: "orders-api", level: "error", line: "ledger answered 503" }], searchDays: 30 },
      "ApiService/PauseApi": (request: Record<string, unknown>) => {
        paused.push(request);
        return {};
      },
    });
    expect(await screen.findByText("teams/payments/apis/orders/api.yaml")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "On this page" })).toBeTruthy();
    // The endpoint's own row carries its traffic; what the spec doesn't describe is listed apart.
    expect(await screen.findByText("4,321")).toBeTruthy();
    expect(screen.getByText("DELETE /orders/x")).toBeTruthy();
    expect(screen.getByText("busiest minute 57 of 60")).toBeTruthy();
    // Traffic to paths not in the spec has its row; refusals before a team was known aren't called "not signed in".
    expect(screen.getByText("GET /wp-login.php")).toBeTruthy();
    expect(screen.getByText("not in its current spec")).toBeTruthy();
    expect(screen.getByText("(no calling team)")).toBeTruthy();
    expect(screen.queryByText(/not signed in, so no limit/)).toBeNull();
    expect(await screen.findByText("ledger answered 503")).toBeTruthy();
    expect(calls).toContain("ObserveService/SearchLogs");
    // Over the same day the card shows.
    expect(screen.getByRole("link", { name: "Search them in Observe" }).getAttribute("href")).toBe("/observe?tab=logs&from=api&team=payments&api=orders&hours=24");

    fireEvent.change(screen.getByLabelText(/message to callers/i), { target: { value: "Failing over" } });
    fireEvent.click(screen.getByRole("button", { name: "Pause this API" }));
    await waitFor(() => { expect(paused).toEqual([{ team: "payments", name: "orders", message: "Failing over" }]); });
  });
});

describe("the APIs page", () => {
  const api = (team: string, name: string, extra: Record<string, unknown> = {}) => ({ team, name, displayName: `${name} API`, state: "API_STATE_LIVE", endpoints: [], url: `http://gateway.vennir-system.svc/${team}/${name}`, ...extra });

  it("groups APIs as your teams', shared with you, and not shared, and filters them", async () => {
    await renderAt("/apis", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "ApiService/ListApis": {
        apis: [
          api("payments", "orders", { mayCall: true }),
          api("identity", "users", { mayCall: true }),
          api("ml", "scoring", { state: "API_STATE_HELD", heldReason: "Its backend's host isn't allowed here yet" }),
          api("risk", "fraud", { askForAccessUrl: "https://github.com/acme/catalog/issues/new?title=fraud" }),
        ],
      },
    });
    await screen.findByText("orders API");
    const table = screen.getByRole("region", { name: "APIs you can see" });
    const groups = [...table.querySelectorAll("th[scope=rowgroup]")].map((h) => h.textContent);
    expect(groups).toEqual([expect.stringMatching(/^Your teams’ · payments/), expect.stringMatching(/^Shared with your teams/), expect.stringMatching(/^Not shared/)]);
    // An issue on the catalog asking its team, when the console can build one; else the team's page.
    expect(within(table).getByRole("link", { name: "Ask ml for access" }).getAttribute("href")).toBe("/teams/ml");
    expect(within(table).getByRole("link", { name: "Ask risk for access ↗" }).getAttribute("href")).toBe("https://github.com/acme/catalog/issues/new?title=fraud");
    expect(screen.getByText("http://gateway.vennir-system.svc/<team>/<api>")).toBeTruthy();
    expect(screen.getByRole("link", { name: "A bot for payments" }).getAttribute("href")).toBe("/teams/payments?tab=automation");

    fireEvent.click(screen.getByRole("button", { name: /Not live/ }));
    expect(within(table).queryByText("orders API")).toBeNull();
    expect(within(table).getByText("scoring API")).toBeTruthy();
    expect(within(table).getByText("Its backend's host isn't allowed here yet")).toBeTruthy();
  });
});

describe("admin", () => {
  const PEOPLE = {
    users: [
      { email: "ana@acme.com", isAdmin: true, teamNames: ["azure-apps"], hasPassword: true, usesSso: true, lastSignedInAt: "2026-10-22T13:58:00Z" },
      { email: "lee@acme.com", teamNames: ["payments"], hasPassword: true, mustChangePassword: true },
      { email: "kim@acme.com", teamNames: [], usesSso: true },
    ],
  };

  it("lists people with how they sign in, and resets a password from a person's menu", async () => {
    const reset: Record<string, unknown>[] = [];
    await renderAt("/admin?tab=people", ADMIN, {
      "AuthService/GetEnvironment": { label: "test", ssoLabel: "Google" },
      "UserService/ListUsers": PEOPLE,
      "UserService/ResetPassword": (request: Record<string, unknown>) => {
        reset.push(request);
        return {};
      },
    });
    expect(await screen.findByText("Google and a password")).toBeTruthy();
    expect(screen.getByText(/hasn't chosen a password yet/i)).toBeTruthy();
    expect(screen.getByText("No team yet")).toBeTruthy();
    expect(screen.getAllByText("Never")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Actions for lee@acme.com" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /reset password/i }));
    fireEvent.change(await screen.findByLabelText(/temporary password/i), { target: { value: "a-temporary-one" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await waitFor(() => { expect(reset).toEqual([{ email: "lee@acme.com", newPassword: "a-temporary-one" }]); });
  });

  it("lists how people rated the chat's answers, the wrong ones first", async () => {
    await renderAt("/admin?tab=chat", ADMIN, {
      "ChatService/ListChatFeedback": {
        ratings: [
          { id: "1", rating: "up", question: "How do I add a secret?", answer: "Register it.", model: "claude-haiku-5-5", email: "lee@acme.com", createdAt: "2026-10-28T10:00:00Z" },
          {
            id: "2",
            rating: "down",
            team: "payments",
            question: "How do I back up?",
            answer: "Nightly.",
            comment: "Only the kernel's",
            citations: [{ id: "S1", guide: "reference-operations", title: "Operations", heading: "Backups", kind: "operating", link: "/docs/reference-operations#backups" }],
            steps: ["search_docs"],
            model: "claude-haiku-5-5",
            email: "kim@acme.com",
            createdAt: "2026-10-28T11:00:00Z",
          },
        ],
      },
    });
    expect(await screen.findByText("How do I back up?")).toBeTruthy();
    expect(screen.getByText(/Only the kernel's/)).toBeTruthy();
    expect(screen.queryByText("How do I add a secret?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All 2" }));
    expect(await screen.findByText("How do I add a secret?")).toBeTruthy();
  });

  it("opens a section from the address, and from an old tab's", async () => {
    await renderAt("/admin?tab=gateway", ADMIN, { "ApiService/GetGateway": { enabled: true, url: "http://gateway:8080" } });
    expect(await screen.findByRole("button", { name: "Close the gateway…" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Admin sections" });
    expect(within(nav).getByRole("link", { name: /^API gateway/ }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: /^Chat agent/ }).getAttribute("href")).toBe("/admin/chat");
  });

  it("says where each section is set, and gives image sources and the audit copy sections of their own", async () => {
    await renderAt("/admin/images", ADMIN, { "ImageService/GetImagePolicy": { policy: { exists: true, source: "registry.example/", allowed: ["registry.example/"] } } });
    expect(await screen.findByRole("heading", { name: "Image sources" })).toBeTruthy();
    expect(screen.getByText("Install and here")).toBeTruthy();
    expect(screen.getByRole("link", { name: "About Image sources" }).getAttribute("href")).toBe("/docs/16-admin-settings#image-sources");
    const nav = screen.getByRole("navigation", { name: "Admin sections" });
    expect(within(nav).getByRole("link", { name: /^Audit log copy/ }).getAttribute("href")).toBe("/admin/audit");
    expect(within(nav).getByRole("link", { name: /^Single sign-on and groups/ }).getAttribute("href")).toBe("/admin/sign-in");
    // Each section's state beside its name, in words: one source allowed.
    expect(await within(nav).findByRole("link", { name: "Image sources 1, fine" })).toBeTruthy();
  });

  it("closes the gateway only once it's confirmed, and lists what it refused in words", async () => {
    const closed: Record<string, unknown>[] = [];
    await renderAt("/admin/gateway", ADMIN, {
      "ApiService/GetGateway": { enabled: true, url: "http://gateway:8080", apis: 2, requests24h: "200", refused: [{ outcome: "blocked", count: "10", mostly: "payments" }] },
      "ApiService/SetGatewayClosed": (request: Record<string, unknown>) => {
        closed.push(request);
        return {};
      },
    });
    expect(await screen.findByText("Not in the API's spec")).toBeTruthy();
    expect(screen.getByText("5.0% of requests")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message to every caller"), { target: { value: "Maintenance" } });
    fireEvent.click(screen.getByRole("button", { name: "Close the gateway…" }));
    expect(closed).toEqual([]);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Close the gateway" }));
    await waitFor(() => { expect(closed).toEqual([{ message: "Maintenance" }]); });
  });

  it("says what this install has set, in each section, never a credential", async () => {
    const install = {
      version: "0.4.0",
      catalog: true,
      catalogVersion: "newest",
      catalogPollSeconds: 300,
      catalogSignerKeys: 1,
      externalCatalog: "us-docker.pkg.dev/other/vennir-products",
      email: true,
      emailHost: "smtp.acme.com",
      emailFrom: "vennir@acme.com",
      monitoringProvider: "google",
      grafanaUrl: "https://grafana.acme.com",
      sessionLength: "12h",
      auditCopy: true,
      auditKeepDays: 400,
      auditLock: true,
      policySyncSeconds: 300,
      imageSignaturesRequired: true,
      scanning: true,
      rescanHours: 24,
    };
    await renderAt("/admin/catalog", ADMIN, { "AdminService/GetInstall": install });
    expect(await screen.findByText("newest")).toBeTruthy();
    expect(screen.getByText("us-docker.pkg.dev/other/vennir-products")).toBeTruthy();
    expect(screen.getByText(/1 public key/)).toBeTruthy();
    expect(screen.getByText(/every 5 min/)).toBeTruthy();
    cleanup();

    await renderAt("/admin/people", ADMIN, { "AdminService/GetInstall": install });
    expect(await screen.findByText("12h")).toBeTruthy();
    cleanup();
    await renderAt("/admin/alerts", ADMIN, { "AdminService/GetInstall": install });
    expect(await screen.findByText("smtp.acme.com")).toBeTruthy();
    cleanup();
    await renderAt("/admin/audit", ADMIN, { "AdminService/GetInstall": install });
    expect(await screen.findByText(/400 days/)).toBeTruthy();
    expect(screen.getByText(/this install: locked/)).toBeTruthy();
    cleanup();
    await renderAt("/admin/images", ADMIN, { "AdminService/GetInstall": install });
    expect(await screen.findByText(/this install: required/)).toBeTruthy();
    // Where signed images are required, added sources don't run: said where they're added.
    expect((await screen.findByRole("note")).textContent).toMatch(/Images from the sources below pass this check, then are refused at the signature check/);
    expect(screen.getByText("Is signed, and from the source registry")).toBeTruthy();
    cleanup();
    await renderAt("/admin/scans", ADMIN, { "AdminService/GetInstall": install });
    expect(await screen.findByText(/every 24 h/)).toBeTruthy();
    cleanup();

    // What the console can't confirm, it says so; what it couldn't read, it doesn't guess.
    await renderAt("/admin/audit", ADMIN, { "AdminService/GetInstall": install });
    expect(await screen.findByText(/400 days, as configured/)).toBeTruthy();
    cleanup();
    await renderAt("/admin/catalog", ADMIN, { "AdminService/GetInstall": install });
    expect(await screen.findByText(/, as configured/)).toBeTruthy();
    cleanup();
    await renderAt("/admin/images", ADMIN, { "AdminService/GetInstall": { ...install, imageSignaturesRequired: undefined } });
    expect(await screen.findByText(/couldn't be read from the cluster/)).toBeTruthy();
    // Not read: no note, and check 4 claims no state.
    expect(screen.queryByRole("note")).toBeNull();
    cleanup();
    await renderAt("/admin/images", ADMIN, { "AdminService/GetInstall": { ...install, imageSignaturesRequired: false } });
    expect(await screen.findByText(/not required, no signature policy in the cluster/)).toBeTruthy();
    expect(await screen.findByText(/Off here: any image from an allowed source runs/)).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
    cleanup();

    // No catalog: nothing said about how often it's read, or who signs it.
    await renderAt("/admin/catalog", ADMIN, { "AdminService/GetInstall": { ...install, catalog: false, catalogVersion: "", catalogPollSeconds: 0, catalogSignerKeys: 0, externalCatalog: "" } });
    expect((await screen.findAllByText(/no catalog/)).length).toBeGreaterThan(1);
    expect(screen.queryByText(/every 5 min/)).toBeNull();
    expect(screen.queryByText(/releases aren't checked/)).toBeNull();
    cleanup();

    // The overview's metrics part, and Observe's Metrics, name the provider and link Grafana.
    await renderAt("/admin", ADMIN, { "AdminService/GetInstall": install });
    expect((await screen.findByRole("link", { name: "Grafana" })).getAttribute("href")).toBe("https://grafana.acme.com");
    cleanup();
    await renderAt("/observe?tab=metrics", ADMIN, { "AdminService/GetInstall": install });
    expect(await screen.findByText(/This install uses google/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open its Grafana" }).getAttribute("href")).toBe("https://grafana.acme.com");
  });

  it("names every policy the console writes, never its key", async () => {
    await renderAt("/admin/policies", ADMIN, {
      "AdminService/GetPolicySync": {
        outcomes: {
          pullSecrets: { applies: true, ok: true },
          schedulerLogs: { applies: true, ok: true },
          teamQuotas: { applies: true, ok: false, error: "quota refused" },
        },
      },
    });
    expect(await screen.findByText("Registry sign-in for each team")).toBeTruthy();
    expect(screen.getByText("The scheduler's log reading")).toBeTruthy();
    expect(screen.getByText("What each team may use together")).toBeTruthy();
    expect(screen.getByText("quota refused")).toBeTruthy();
    const main = screen.getByRole("main");
    expect(main.textContent).not.toMatch(/pullSecrets|schedulerLogs|teamQuotas/);
  });

  it("sets the chat agent's model in place of the install's, keeps its key unshown, and tries it first", async () => {
    const saved: Record<string, unknown>[] = [];
    const tried: Record<string, unknown>[] = [];
    await renderAt("/admin/chat", ADMIN, {
      "ChatService/GetChatConfig": {
        config: { source: "install", enabled: true, provider: "vertex", model: "google/gemini-3.5-flash", vertexProject: "acme-prod", vertexLocation: "global", installProvider: "vertex", installModel: "google/gemini-3.5-flash" },
      },
      "ChatService/TestChatConfig": (request: Record<string, unknown>) => {
        tried.push(request);
        return { ok: true, seconds: 3.2, model: "claude-haiku-5-5", answer: "Back up nightly [S1].", citations: 1 };
      },
      "ChatService/SetChatConfig": (request: Record<string, unknown>) => {
        saved.push(request);
        return { config: { source: "admins", enabled: true, provider: "anthropic", model: "claude-haiku-5-5", keySet: true, updatedBy: "ana@acme.com", installProvider: "vertex", installModel: "google/gemini-3.5-flash" } };
      },
      "ChatService/ListChatFeedback": { ratings: [] },
    });
    expect(await screen.findByText(/These are the install's settings \(Gemini on Vertex AI/)).toBeTruthy();
    expect((screen.getByLabelText("Google Cloud project") as HTMLInputElement).value).toBe("acme-prod");
    // No key on Vertex: it signs in as the console.
    expect(screen.queryByLabelText(/^API key/)).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /^Claude through Anthropic's API/ }));
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-haiku-5-5" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ant-typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText(/claude-haiku-5-5 answered in 3.2 s, citing 1 section/)).toBeTruthy();
    expect(tried[0]?.["config"]).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5", apiKey: "sk-ant-typed" });

    fireEvent.click(within(screen.getByRole("region", { name: "The model" })).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Saved: in effect within seconds/)).toBeTruthy();
    expect(saved[0]?.["config"]).toMatchObject({ enabled: true, provider: "anthropic", model: "claude-haiku-5-5", apiKey: "sk-ant-typed" });
    // Saved, the key is never shown again: kept, and the field empty.
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/One is kept \(encrypted, never shown\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use the install's" })).toBeTruthy();
  });

  it("sets how many questions each person may ask, an hour's no more than a day's", async () => {
    const saved: Record<string, unknown>[] = [];
    await renderAt("/admin/chat", ADMIN, {
      "ChatService/GetChatLimits": { limits: { perHour: 30, perDay: 200 } },
      "ChatService/SetChatLimits": (request: Record<string, unknown>) => {
        saved.push(request);
        if (request["perHour"] === 9) return refused(400, "invalid_argument", "No more questions an hour than a day.", "BAD_CHAT_LIMITS");
        return { limits: { perHour: request["perHour"], perDay: request["perDay"], updatedBy: "ana@acme.com", updatedAt: "2026-10-30T09:00:00Z" } };
      },
      "ChatService/ListChatFeedback": { ratings: [] },
    });
    const card = await screen.findByRole("region", { name: "Questions per person" }, { timeout: 5000 });
    const hour = await within(card).findByLabelText("An hour");
    expect((hour as HTMLInputElement).value).toBe("30");
    // The defaults: nobody set them.
    expect(within(card).queryByText(/^Set by/)).toBeNull();

    const save = within(card).getByRole("button", { name: "Save" });
    fireEvent.change(within(card).getByLabelText("A day"), { target: { value: "20" } });
    expect(within(card).getByText("At least the hour's")).toBeTruthy();
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(card).getByLabelText("A day"), { target: { value: "20000" } });
    expect(within(card).getByText("1 to 10,000")).toBeTruthy();
    expect(save.hasAttribute("disabled")).toBe(true);

    fireEvent.change(within(card).getByLabelText("A day"), { target: { value: "100" } });
    fireEvent.change(hour, { target: { value: "10" } });
    fireEvent.click(save);
    expect(await within(card).findByText("Saved: 10 an hour, 100 a day.")).toBeTruthy();
    expect(saved[0]).toMatchObject({ perHour: 10, perDay: 100 });
    expect(within(card).getByText(/^Set by ana@acme\.com · /)).toBeTruthy();

    // What the server refuses is said too.
    fireEvent.change(hour, { target: { value: "9" } });
    fireEvent.click(save);
    expect(await within(card).findByText("No more questions an hour than a day.")).toBeTruthy();

    fireEvent.click(within(card).getByRole("button", { name: "Use the defaults" }));
    await waitFor(() => { expect(saved.at(-1)).toMatchObject({ perHour: 30, perDay: 200 }); });
    expect(await within(card).findByText("Saved: 30 an hour, 200 a day.")).toBeTruthy();
  });

  it("says when the limits couldn't be loaded, and loads them again on Try again", async () => {
    let calls = 0;
    await renderAt("/admin/chat", ADMIN, {
      "ChatService/GetChatLimits": () => {
        calls++;
        return calls === 1 ? refused(503, "unavailable", "The console's database didn't answer.") : { limits: { perHour: 12, perDay: 90 } };
      },
      "ChatService/ListChatFeedback": { ratings: [] },
    });
    const card = await screen.findByRole("region", { name: "Questions per person" }, { timeout: 5000 });
    const failed = await within(card).findByText(/Couldn't load the limits: The console's database didn't answer\./);
    expect(within(card).queryByLabelText("An hour")).toBeNull();
    fireEvent.click(within(failed.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Try again" }));
    expect(((await within(card).findByLabelText("An hour")) as HTMLInputElement).value).toBe("12");
    expect(within(card).queryByText(/Couldn't load the limits/)).toBeNull();
  });
});

describe("observe", () => {
  it("filters what was refused by who refused it, with the gateway's counts", async () => {
    await renderAt("/observe", MEMBER, {
      "ObserveService/GetSecurity": {
        refusals: [
          { what: "local · step t", detail: "registry/x@sha256:aa", code: "IMAGE_NOT_ALLOWED", why: "Not an allowed source.", source: "step", count: 1 },
          { what: "azure-apps → payments/orders", detail: "POST /orders", code: "INVALID_REQUEST", why: "Didn't fit.", source: "gateway", count: 214 },
        ],
      },
    });
    // What was refused, and under it the endpoint or the image.
    expect(await screen.findByText(/payments\/orders, 214 calls/)).toBeTruthy();
    expect(screen.getByText("POST /orders")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cluster" }));
    expect(screen.queryByText(/214 calls/)).toBeNull();
    expect(screen.getByText("local · step t")).toBeTruthy();
    expect(screen.getByText("registry/x@sha256:aa")).toBeTruthy();
  });

  it("says whether the audit log's chain held", async () => {
    await renderAt("/observe?tab=audit", MEMBER, {
      "ObserveService/GetAuditCopy": { enabled: true, copiedThrough: "41206", checkedAt: "2026-10-22T08:00:00Z", copiedAt: "2026-10-22T14:05:00Z" },
    });
    expect(await screen.findByText("Chain intact")).toBeTruthy();
    expect(screen.getByText("entry 41,206")).toBeTruthy();
  });

  it("never calls the audit copy intact when it couldn't be compared, or hasn't been checked", async () => {
    await renderAt("/observe?tab=audit", MEMBER, {
      "ObserveService/GetAuditCopy": { enabled: true, copiedThrough: "41206", checkedAt: "2026-10-22T08:00:00Z", compareProblem: "Couldn't list the copy: AccessDenied." },
    });
    expect(await screen.findByText("Not compared")).toBeTruthy();
    expect(screen.queryByText("Chain intact")).toBeNull();
    expect(screen.queryByText(/agrees with its copy/)).toBeNull();
    expect(screen.getByText(/AccessDenied/)).toBeTruthy();
    cleanup();

    // Admin's side navigation, and Needs you, say the same.
    await renderAt("/admin", ADMIN, {
      "ObserveService/GetAuditCopy": { enabled: true, copiedThrough: "41206", checkedAt: "2026-10-22T08:00:00Z", compareProblem: "Couldn't list the copy: AccessDenied." },
    });
    const nav = await screen.findByRole("navigation", { name: "Admin sections" });
    expect(await within(nav).findByRole("link", { name: /^Audit log copy Not compared/ })).toBeTruthy();
    cleanup();

    await renderAt("/observe?tab=audit", MEMBER, { "ObserveService/GetAuditCopy": { enabled: true } });
    expect(await screen.findByText("Not checked yet")).toBeTruthy();
    expect(screen.queryByText("Chain intact")).toBeNull();
  });

  it("opens the logs on an API's backends when linked from one, and says who sees which lines", async () => {
    const searched: Record<string, unknown>[] = [];
    await renderAt("/observe?tab=logs&from=api&team=payments&hours=24", MEMBER, {
      "ObserveService/SearchLogs": (request: Record<string, unknown>) => {
        searched.push(request);
        return { lines: [{ team: "payments", app: "orders-api", level: "warn", line: "ledger call slow" }], searchDays: 30 };
      },
    });
    expect(await screen.findByText("ledger call slow")).toBeTruthy();
    expect(searched[0]).toMatchObject({ source: "api", team: "payments" });
    // Over the last day, as the link said.
    expect(Math.round((Date.now() - Date.parse(String(searched[0]?.["since"]))) / 3_600_000)).toBe(24);
    expect(screen.getByRole("button", { name: "API backends" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/1 line/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Who sees which lines" })).toBeTruthy();
  });

  it("says when the APIs to search couldn't be loaded, and tries again", async () => {
    let asked = 0;
    await renderAt("/observe?tab=logs&from=api&team=payments&hours=24", MEMBER, {
      "ObserveService/SearchLogs": { lines: [], searchDays: 30 },
      "ApiService/ListApis": () => (asked++ === 0 ? refused(503, "unavailable", "The console is restarting.") : { apis: [] }),
    });
    const failed = await screen.findByText(/Couldn't load the APIs to choose from: The console is restarting\./, {}, { timeout: 5000 });
    fireEvent.click(within(failed.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Try again" }));
    await waitFor(() => { expect(screen.queryByText(/Couldn't load the APIs/)).toBeNull(); });
    expect(asked).toBe(2);
  });

  it("counts what was refused by code, and marks who refused each", async () => {
    await renderAt("/observe", MEMBER, {
      "ObserveService/GetSecurity": {
        checks: [{ name: "Teams from the directory", state: "not_yet", text: "Planned." }],
        refusals: [
          { what: "a", code: "NOT_IN_SPEC", why: "No such path.", source: "gateway", count: 2 },
          { what: "b", code: "NOT_IN_SPEC", why: "No such path.", source: "gateway", count: 3 },
          { what: "c", code: "IMAGE_NOT_ALLOWED", why: "Not allowed.", source: "step", count: 1 },
        ],
      },
    });
    expect(await screen.findByText("Teams from the directory: not yet")).toBeTruthy();
    // Calls, not rows: the gateway's two rows are 2 and 3 calls.
    expect(screen.getByText("1 by the cluster · 5 by the gateway")).toBeTruthy();
    const refused = screen.getByRole("region", { name: "Refused, last 7 days" });
    expect(within(refused).getAllByText("NOT_IN_SPEC").length).toBeGreaterThan(1);
  });
});

describe("home", () => {
  it("lists only what was made for you or your teams, and picks up your own draft", async () => {
    const made = (id: string, name: string, ownerEmail: string) => ({ id, type: "gcp/bucket", externalId: name, name, product: "storage-bucket", productTeam: "storage", ownerEmail, executionId: "r1", taskId: "t", firstReportedAt: "2026-10-21T16:21:00Z", state: "exists" });
    await renderAt("/", MEMBER, {
      "ResourceService/ListResources": { resources: [made("a1", "my-bucket", MEMBER.email), made("a2", "bobs-bucket", "bob@acme.com")] },
      "DraftService/ListDrafts": {
        drafts: [
          { team: "azure-apps", name: "theirs", version: "3", body: { steps: [] }, updatedBy: "bob@acme.com", updatedAt: "2026-10-30T10:00:00Z" },
          { team: "azure-apps", name: "mine", version: "1", body: { steps: [] }, updatedBy: MEMBER.email, updatedAt: "2026-10-29T10:00:00Z" },
        ],
      },
    });
    expect(await screen.findByText("my-bucket")).toBeTruthy();
    expect(screen.queryByText("bobs-bucket")).toBeNull();
    const pickUp = await screen.findByRole("link", { name: /mine/ });
    expect(pickUp.getAttribute("href")).toContain("draft=azure-apps%2Fmine");
    expect(screen.queryByRole("link", { name: /theirs/ })).toBeNull();
  });

  it("shows your runs that are going, and what waits for you", async () => {
    await renderAt("/", MEMBER, {
      "ExecutionService/ListExecutions": {
        executions: [
          {
            executionId: "r1",
            name: "orders-api first deploy",
            submittedBy: MEMBER.userId,
            createdAt: new Date(Date.now() - 300_000).toISOString(),
            state: "EXECUTION_STATE_RUNNING",
            steps: { SUCCEEDED: 2, RUNNING: 1, PENDING: 1 },
            running: [{ taskId: "app-hosting", action: "create", attempt: 2, maxAttempts: 3 }],
          },
          // Someone else's, in a team you're not in: not yours to watch.
          { executionId: "r3", name: "not ours", submittedBy: "u9", teams: ["payments"], createdAt: new Date(Date.now() - 60_000).toISOString(), state: "EXECUTION_STATE_RUNNING", steps: { RUNNING: 1 } },
          { executionId: "r2", name: "yesterday's", createdAt: new Date(Date.now() - 86_400_000).toISOString(), state: "EXECUTION_STATE_SUCCEEDED", steps: { SUCCEEDED: 1 } },
        ],
      },
      "ExecutionService/ListPendingApprovals": { approvals: [{ executionId: "r9", executionName: "orders-api prod database", taskId: "database", team: "azure-apps", requestedBy: "sam@acme.com", canDecide: true }] },
    });
    expect(await screen.findByText("orders-api first deploy")).toBeTruthy();
    expect(screen.getByText("2 of 4 steps done · now: app-hosting.create, attempt 2 of 3")).toBeTruthy();
    expect(screen.queryByText("not ours")).toBeNull();
    expect(await screen.findByText(/1 run for you and your teams is going, and 1 thing waits for you to decide\./)).toBeTruthy();
    expect(screen.getByText("orders-api prod database")).toBeTruthy();
    expect(screen.getByText(/sam@acme.com asked to run database for azure-apps/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review it" }).getAttribute("href")).toBe("/runs/r9");
    // The install at a glance is an admin's.
    expect(screen.queryByRole("heading", { name: /at a glance/ })).toBeNull();
  });

  it("says when schedules run next in each one's own time zone, and in yours on hover", async () => {
    // 02:30 UTC on Sunday Nov 1 is 22:30 on Saturday Oct 31 in New York, whatever the viewer's zone.
    const nightly = { id: "s1", team: "azure-apps", name: "nightly uptime check", cron: "30 22 * * *", timeZone: "America/New_York", enabled: true, nextRunAt: "2026-11-01T02:30:00Z", lastRunAt: "2026-10-31T02:30:00Z" };
    await renderAt("/", MEMBER, { "ScheduleService/ListSchedules": { schedules: [nightly] } });
    const panel = (await screen.findByRole("heading", { name: "Coming up" }, { timeout: 5000 })).closest("section") ?? document.body;
    const time = within(panel as HTMLElement).getByText("22:30 New York time");
    expect(within(panel as HTMLElement).getByText("Sat")).toBeTruthy();
    expect(within(panel as HTMLElement).getByText("31")).toBeTruthy();
    expect(within(panel as HTMLElement).getByText("Times are each schedule's own; hover one for yours.")).toBeTruthy();
    // The tooltip describes the time; it doesn't replace it as the row's name.
    expect(time.getAttribute("aria-label")).toBeNull();
    expect(within(panel as HTMLElement).getByRole("link", { name: /22:30 New York time/ })).toBeTruthy();
    fireEvent.mouseOver(time);
    expect((await screen.findByRole("tooltip")).textContent).toMatch(/^\d\d:\d\d your time \(.+\)$/);
  });
});

describe("preferences", () => {
  it("say a single sign-on account has no password to change", async () => {
    await renderAt("/account", { ...MEMBER, hasPassword: false, usesSso: true }, { "AuthService/GetEnvironment": { label: "test", ssoLabel: "Google" } });
    expect(await screen.findByText(/you sign in with google, as ana@acme.com/i)).toBeTruthy();
    expect(screen.queryByLabelText(/current password/i)).toBeNull();
  });

  it("let someone with a password change it", async () => {
    await renderAt("/account", MEMBER);
    expect(await screen.findByLabelText(/current password/i)).toBeTruthy();
  });
});

describe("a run form", () => {
  const TEMPLATE = {
    kind: "KIND_TEMPLATE",
    team: "gcp-platform",
    name: "app-on-cloud-run",
    displayName: "App on Cloud Run",
    shared: true,
    actions: ["gcp-platform/project.create", "gcp-platform/app-hosting.create"],
    parameters: {
      type: "object",
      required: ["projectId"],
      properties: {
        projectId: { type: "string", title: "Project ID", minLength: 6, pattern: "^[a-z][a-z0-9-]*$", "x-vennir-pattern-message": "Lowercase letters, digits and hyphens.", "x-vennir-group": "Project" },
        regions: { type: "array", title: "Regions", items: { type: "string" } },
      },
    },
  };

  it("checks what's typed on its field, then runs it with typed values and opens the run", async () => {
    const ran: Record<string, unknown>[] = [];
    await renderAt("/catalog/run?template=gcp-platform%2Fapp-on-cloud-run", MEMBER, {
      "TemplateService/ListTemplates": { runnables: [TEMPLATE] },
      "TemplateService/RunTemplate": (request: Record<string, unknown>) => {
        ran.push(request);
        return { executionId: "0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11" };
      },
      "ExecutionService/WatchExecution": [
        { execution: { executionId: "0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11", name: "orders-api run", state: "EXECUTION_STATE_SUCCEEDED", createdAt: "2026-10-21T16:20:00Z", tasks: [] } },
      ],
    });
    expect(await screen.findByRole("heading", { name: "App on Cloud Run" })).toBeTruthy();
    expect(screen.getByText("Project")).toBeTruthy();
    expect(screen.getByText("app-hosting · create")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/project id/i), { target: { value: "Orders_API" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Lowercase letters, digits and hyphens.")).toBeTruthy();
    expect(ran).toEqual([]);

    fireEvent.change(screen.getByLabelText(/project id/i), { target: { value: "orders-api" } });
    fireEvent.change(screen.getByLabelText("Regions, item 1"), { target: { value: "us-central1" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => { expect(ran).toEqual([{ team: "gcp-platform", name: "app-on-cloud-run", parameters: { projectId: "orders-api", regions: ["us-central1"] } }]); });
    expect(await screen.findByRole("heading", { level: 1, name: "orders-api run" })).toBeTruthy();
  });

  it("runs again with changes, filled in from the run, and shows itself as an API call", async () => {
    const run = {
      executionId: "5a1d9c0e-2f4b-4e7a-9c3d-1b2a3c4d5e6f",
      name: "orders-api on Cloud Run",
      state: "EXECUTION_STATE_SUCCEEDED",
      teams: ["gcp-platform"],
      createdAt: "2026-10-21T16:20:00Z",
      tasks: [{ taskId: "project", state: "TASK_STATE_SUCCEEDED", attemptCount: 1, attempts: [{ number: 1, startedAt: "2026-10-21T16:20:01Z", completedAt: "2026-10-21T16:21:00Z" }] }],
      dag: { name: "orders-api on Cloud Run", tasks: [{ id: "project", image: "registry.example/project@sha256:aa", action: "create", team: "gcp-platform" }] },
      template: "gcp-platform/app-on-cloud-run",
      templateParameters: { projectId: "orders-api", regions: ["us-central1"] },
    };
    await renderAt(`/runs/${run.executionId}`, MEMBER, {
      "ExecutionService/WatchExecution": [{ execution: run }],
      "TemplateService/ListTemplates": { runnables: [TEMPLATE] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Run with changes" }));
    expect(await screen.findByText(/filled in from orders-api on cloud run/i)).toBeTruthy();
    expect((screen.getByLabelText(/project id/i) as HTMLInputElement).value).toBe("orders-api");
    expect((screen.getByLabelText("Regions, item 1") as HTMLInputElement).value).toBe("us-central1");

    fireEvent.click(screen.getByRole("button", { name: "Show as an API call" }));
    const call = screen.getByText(/TemplateService\/RunTemplate/).textContent ?? "";
    expect(call).toContain('"projectId": "orders-api"');
    expect(call).toContain("Bearer $VENNIR_TOKEN");
  });

  it("previews what it would do, from each step's plan", async () => {
    const previewed: Record<string, unknown>[] = [];
    await renderAt("/catalog/run?template=gcp-platform%2Fapp-on-cloud-run", MEMBER, {
      "TemplateService/ListTemplates": { runnables: [{ ...TEMPLATE, previewable: true }] },
      "TemplateService/PreviewTemplate": (request: Record<string, unknown>) => {
        previewed.push(request);
        return { executionId: "7a7a7a7a-0000-4000-8000-000000000007", notPreviewed: [{ step: "deploy", why: "It uses project's output, known only once that runs." }] };
      },
      "ExecutionService/GetExecution": {
        execution: {
          executionId: "7a7a7a7a-0000-4000-8000-000000000007",
          state: "EXECUTION_STATE_SUCCEEDED",
          tasks: [{ taskId: "project", state: "TASK_STATE_SUCCEEDED", outputs: { summary: "Creates one project.", changes: [{ action: "create", type: "gcp/project", id: "orders-api" }] } }],
        },
      },
    });
    fireEvent.change(await screen.findByLabelText(/project id/i), { target: { value: "orders-api" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => { expect(previewed).toEqual([{ team: "gcp-platform", name: "app-on-cloud-run", parameters: { projectId: "orders-api" } }]); });
    expect(await screen.findByText("Creates one project.")).toBeTruthy();
    expect(screen.getByText("gcp/project · orders-api")).toBeTruthy();
    expect(screen.getByText(/not previewed\. It uses project's output/)).toBeTruthy();
  });

  it("schedules it for a team the person maintains, as its bot", async () => {
    const made: Record<string, unknown>[] = [];
    await renderAt("/catalog/run?template=gcp-platform%2Fapp-on-cloud-run", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "TemplateService/ListTemplates": { runnables: [TEMPLATE] },
      "TokenService/ListBots": { bots: [{ id: "b0b0b0b0-0000-4000-8000-000000000001", email: "payments-nightly@bots.vennir.local" }] },
      "ScheduleService/CreateSchedule": (request: Record<string, unknown>) => {
        made.push(request);
        return { schedule: { id: "s1", team: "payments", name: request["name"] } };
      },
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
    });
    fireEvent.change(await screen.findByLabelText(/project id/i), { target: { value: "orders-api" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule…" }));
    expect(await screen.findByText("payments-nightly@bots.vennir.local")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Schedule it" }));
    await waitFor(() => {
      expect(made).toEqual([
        expect.objectContaining({ team: "payments", name: "app-on-cloud-run", kind: "template", runnableTeam: "gcp-platform", runnableName: "app-on-cloud-run", parameters: { projectId: "orders-api" }, cron: "0 2 * * *", botId: "b0b0b0b0-0000-4000-8000-000000000001" }),
      ]);
    });
  });

  it("says when the team's bots couldn't be loaded, rather than that it has none, and tries again", async () => {
    let asked = 0;
    await renderAt("/catalog/run?template=gcp-platform%2Fapp-on-cloud-run", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "TemplateService/ListTemplates": { runnables: [TEMPLATE] },
      "TokenService/ListBots": () => (asked++ === 0 ? refused(503, "unavailable", "The console is restarting.") : { bots: [{ id: "b0b0b0b0-0000-4000-8000-000000000001", email: "payments-nightly@bots.vennir.local" }] }),
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
    });
    await screen.findByLabelText(/project id/i);
    fireEvent.click(screen.getByRole("button", { name: "Schedule…" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Couldn't load payments's bots: The console is restarting\./)).toBeTruthy();
    expect(within(dialog).queryByText(/has no bot to run it as/)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Schedule it" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText("payments-nightly@bots.vennir.local")).toBeTruthy();
  });

  it("fills itself from an example", async () => {
    await renderAt("/catalog/run?template=gcp-platform%2Fapp-on-cloud-run", MEMBER, {
      "TemplateService/ListTemplates": { runnables: [{ ...TEMPLATE, examples: [{ name: "orders api", inputs: { projectId: "orders-api", regions: ["us-central1"] }, outputs: { url: "https://orders" } }] }] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Use this" }));
    expect((screen.getByLabelText(/project id/i) as HTMLInputElement).value).toBe("orders-api");
    expect((screen.getByLabelText("Regions, item 1") as HTMLInputElement).value).toBe("us-central1");
  });

  it("opens from an old catalog link", async () => {
    await renderAt("/catalog?template=gcp-platform%2Fapp-on-cloud-run", MEMBER, { "TemplateService/ListTemplates": { runnables: [TEMPLATE] } });
    expect(await screen.findByLabelText(/project id/i)).toBeTruthy();
  });
});

describe("pages that can't be shown", () => {
  it("say an address leads nowhere, inside the console", async () => {
    await renderAt("/no/such/page", MEMBER);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: /main/i })).toBeTruthy();
  });

  it("keep Admin to admins", async () => {
    await renderAt("/admin", MEMBER);
    expect(await screen.findByRole("heading", { name: "Admins only" })).toBeTruthy();
  });
});

describe("the Admin page's summary", () => {
  it("is read once, for admins only, and says which parts it couldn't read", async () => {
    await renderAt("/admin", MEMBER);
    expect(await screen.findByText(/Admins only/)).toBeTruthy();
    expect(calls).not.toContain("ObserveService/GetSecurity");
    expect(calls).not.toContain("AdminService/GetInstall");
    cleanup();
    calls.length = 0;

    await renderAt("/admin", ADMIN, {
      "UserService/ListUsers": refused(503, "unavailable", "Down."),
      "TokenService/ListAutomationTokens": { tokens: [{ id: "k1", label: "nightly", expiresAt: "2020-01-01T00:00:00Z" }] },
    });
    const needs = await screen.findByRole("region", { name: "Needs you" });
    // Not "every part reads as it should": People couldn't be read.
    expect(await within(needs).findByText(/Couldn't read People/)).toBeTruthy();
    expect(within(needs).queryByText(/every part reads as it should/)).toBeNull();
    // An expired token isn't a working one.
    const parts = screen.getByRole("region", { name: "Every part, and where it's set" });
    expect(within(parts).getByText("None working: every one has expired.")).toBeTruthy();
    // Moving between sections doesn't read every part again.
    const read = calls.filter((c) => c === "ObserveService/GetSecurity").length;
    fireEvent.click(within(screen.getByRole("navigation", { name: "Admin sections" })).getByRole("link", { name: /^Image sources/ }));
    expect((await screen.findAllByRole("heading", { name: /Image sources/ })).length).toBeGreaterThan(0);
    expect(calls.filter((c) => c === "ObserveService/GetSecurity").length).toBe(read);
  });
});

describe("a new install", () => {
  it("shows its admin what's left to set up, and what's on", async () => {
    await renderAt("/admin", ADMIN, {
      "AdminService/GetCatalogStatus": { status: { release: "" } },
      "ImageService/GetImagePolicy": { policy: { exists: true, source: "registry.example/", allowed: ["registry.example/"] } },
      "TeamService/ListTeams": { teams: [] },
      "UserService/ListUsers": { users: [{ email: "ana@acme.com", isAdmin: true }] },
      "AdminService/GetInstall": { version: "0.4.0", environmentLabel: "gke-prod", scanning: true, runRetentionDays: 90 },
    });
    expect(await screen.findByRole("heading", { name: "Getting this install ready" })).toBeTruthy();
    expect(screen.getByText("1 of 4 done")).toBeTruthy();
    expect(screen.getByText("Connect the catalog")).toBeTruthy();
    expect(await screen.findByText("0.4.0")).toBeTruthy();
    // Every part says where it's set, and leads to its section.
    const parts = screen.getByRole("region", { name: "Every part, and where it's set" });
    expect(within(parts).getByRole("link", { name: /^Single sign-on/ }).getAttribute("href")).toBe("/admin/sign-in");
    expect(within(parts).getByRole("link", { name: /^Image sources/ }).getAttribute("href")).toBe("/admin/images");
    expect(within(parts).getByText(/Kept 90 days/)).toBeTruthy();
  });

  it("lists what needs an admin, from what the API says", async () => {
    await renderAt("/admin", ADMIN, {
      "AdminService/GetCatalogStatus": {
        status: { release: "registry.example/catalog-release", appliedAt: "2026-10-29T10:00:00Z", problems: [{ item: "team sandbox", message: "Not made by the catalog.", adoptableTeam: "sandbox" }] },
      },
      "UserService/ListUsers": { users: [{ email: "ana@acme.com", isAdmin: true }, { email: "lee@acme.com", mustChangePassword: true }] },
    });
    const needs = await screen.findByRole("region", { name: "Needs you" });
    expect(await within(needs).findByText("The catalog found a team named sandbox that it didn't make")).toBeTruthy();
    expect(within(needs).getByText("1 person hasn't chosen a password yet")).toBeTruthy();
    expect(within(needs).getByRole("link", { name: /Decide in Catalog/ }).getAttribute("href")).toBe("/admin/catalog");
    const nav = screen.getByRole("navigation", { name: "Admin sections" });
    expect(within(nav).getByRole("link", { name: "Catalog 1 to adopt, needs a look" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "People 1 to finish, needs a look" })).toBeTruthy();
  });
});

describe("the admins' chat channel", () => {
  it("lets an admin choose the team whose webhook gets admins' alerts", async () => {
    const saved: Record<string, unknown>[] = [];
    await renderAt("/admin/alerts", ADMIN, {
      "AdminService/GetCatalogStatus": { status: { release: "" } },
      "ImageService/GetImagePolicy": { policy: { exists: true, source: "registry.example/", allowed: ["registry.example/"] } },
      "TeamService/ListTeams": { teams: [{ id: "t1", name: "platform" }, { id: "t2", name: "old", retiredAt: "2026-10-01T00:00:00Z" }] },
      "UserService/ListUsers": { users: [{ email: "ana@acme.com", isAdmin: true }] },
      "NotificationService/GetAdminChannel": { team: "" },
      "NotificationService/SetAdminChannel": (request: Record<string, unknown>) => {
        saved.push(request);
        return { team: request["team"] };
      },
    });
    expect(await screen.findByRole("heading", { name: "Admins' alerts in chat" })).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Team" }));
    expect(screen.queryByRole("option", { name: "old" })).toBeNull(); // retired
    fireEvent.click(await screen.findByRole("option", { name: "platform" }));
    const card = screen.getByRole("heading", { name: "Admins' alerts in chat" }).closest("section") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() => { expect(saved).toEqual([{ team: "platform" }]); });
  });
});

describe("pages that moved", () => {
  it.each([
    ["/executions", "Runs"],
    ["/executions/0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11", "Runs"],
    ["/run?action=title-case", "Catalog"],
  ])("%s opens its new place", async (path, place) => {
    await renderAt(path, ADMIN);
    const nav = await screen.findByRole("navigation", { name: /main/i });
    expect(within(nav).getByRole("link", { name: place }).getAttribute("aria-current")).toBe("page");
  });
});

describe("the settings menu", () => {
  it("holds Preferences, Help and guides, and Sign out; the sidebar has neither Docs nor Help", async () => {
    await renderAt("/", MEMBER);
    const nav = await screen.findByRole("navigation", { name: /main/i });
    expect(within(nav).queryByRole("link", { name: /docs|help/i })).toBeNull();
    screen.getByRole("button", { name: "Settings" }).click();
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Preferences", "Help and guides", "Sign out"]);
  });
});

describe("signing in", () => {
  it("sends someone who isn't signed in to the sign-in page", async () => {
    await renderAt("/observe", null);
    expect(await screen.findByLabelText(/email/i)).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: /main/i })).toBeNull();
  });

  it("treats a session the console no longer accepts as signed out", async () => {
    await renderAt("/observe", ADMIN, { "AuthService/GetMe": refused(401, "unauthenticated", "Session expired.") });
    expect(await screen.findByLabelText(/email/i)).toBeTruthy();
    expect(localStorage.getItem("token")).toBeNull();
  });

  it("treats a watch the console ends as unauthenticated as signed out", async () => {
    // The stream opens, then the console ends it: the session went (signed
    // out elsewhere, a password reset) while the run was being watched.
    await renderAt("/runs/0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11", ADMIN, {
      "ExecutionService/WatchExecution": refused(401, "unauthenticated", "Invalid, expired, or revoked credential."),
    });
    expect(await screen.findByLabelText(/email/i)).toBeTruthy();
    expect(localStorage.getItem("token")).toBeNull();
  });

  it("goes back to the page a link opened once signed in, with a password or single sign-on", async () => {
    const RUN = "0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11";
    const run = { "ExecutionService/WatchExecution": [{ execution: { executionId: RUN, name: "the failed run", state: "EXECUTION_STATE_FAILED", createdAt: "2026-10-21T16:20:00Z", tasks: [] } }] };
    await renderAt(`/runs/${RUN}`, null, { "AuthService/Login": { token: "a-session" }, "AuthService/GetMe": MEMBER, ...run });
    fireEvent.change(await screen.findByLabelText(/email/i), { target: { value: "ana@acme.com" } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "their-password" } });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByText("the failed run", undefined, { timeout: 5000 })).toBeTruthy();
    cleanup();
    localStorage.clear();

    // Single sign-on leaves the page, so where to go back to waits in this tab.
    sessionStorage.setItem("vennir_sso_tab", "fedcba9876543210fedcba9876543210");
    sessionStorage.setItem("vennir_sso_return", `/runs/${RUN}`);
    window.history.replaceState(null, "", "/login#token=this-tabs&tab=fedcba9876543210fedcba9876543210");
    await renderAt("/login", null, { "AuthService/GetMe": MEMBER, ...run });
    expect(await screen.findByText("the failed run", undefined, { timeout: 5000 })).toBeTruthy();
    expect(sessionStorage.getItem("vennir_sso_return")).toBeNull();
  });

  it("waits out a console that can't answer yet instead of signing out", async () => {
    let asked = 0;
    await renderAt("/observe", MEMBER, {
      "AuthService/GetMe": () => {
        asked += 1;
        return asked === 1 ? refused(503, "unavailable", "Restarting.") : MEMBER;
      },
    });
    expect(await screen.findByRole("navigation", { name: /main/i }, { timeout: 3000 })).toBeTruthy();
    expect(asked).toBe(2);
    expect(screen.queryByLabelText(/email/i)).toBeNull();
    expect(localStorage.getItem("token")).toBe("a-session");
  });

  it("says it can't reach the console while it waits, and asks again at once on Retry now", async () => {
    let up = false;
    await renderAt("/observe", MEMBER, { "AuthService/GetMe": () => (up ? MEMBER : refused(503, "unavailable", "Restarting.")) });
    expect(await screen.findByText("Can't reach the console. Trying again…")).toBeTruthy();
    up = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    // Well before the next try (a second after the first).
    expect(await screen.findByRole("navigation", { name: /main/i }, { timeout: 800 })).toBeTruthy();
  });

  it("doesn't ask again a console without the method (501): it says so", async () => {
    let asked = 0;
    await renderAt("/observe", MEMBER, {
      "AuthService/GetMe": () => {
        asked += 1;
        return refused(501, "unimplemented", "No such method here.");
      },
    });
    expect(await screen.findByText("No such method here.")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(asked).toBe(1);
    expect(screen.queryByText("Can't reach the console. Trying again…")).toBeNull();
  });

  it("opens the console when someone signs in while the first check is still trying", async () => {
    let signedIn = false;
    await renderAt("/login", MEMBER, {
      "AuthService/GetMe": () => (signedIn ? MEMBER : refused(503, "unavailable", "Restarting.")),
      "AuthService/Login": () => {
        signedIn = true;
        return { token: "a-new-session" };
      },
    });
    const email = await screen.findByLabelText(/email/i);
    // Past the second try, so the next is two seconds off.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    fireEvent.change(email, { target: { value: "ana@acme.com" } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "their-password" } });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByRole("navigation", { name: /main/i }, { timeout: 800 })).toBeTruthy();
  });

  it("forgets the cart and the browser's old drafts when signing out or when the session ends", async () => {
    const { cart } = await import("./cart");
    for (const end of ["sign out", "session ends"]) {
      cart.replace("payments", ["payments-ledger-refund"], [], { refund: { amount: 40 } });
      localStorage.setItem("vennir.compose.drafts", JSON.stringify({ old: { name: "old", team: "payments" } }));
      await renderAt("/", MEMBER, end === "sign out" ? {} : { "AuthService/GetMe": refused(401, "unauthenticated", "Session expired.") });
      if (end === "sign out") {
        (await screen.findByRole("button", { name: "Settings" })).click();
        fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
      }
      expect(await screen.findByLabelText(/email/i)).toBeTruthy();
      expect(localStorage.getItem("vennir.cart")).toBeNull();
      expect(localStorage.getItem("vennir.compose.drafts")).toBeNull();
      // Nor does this page still hold it.
      cart.add("growth-report");
      expect(JSON.parse(localStorage.getItem("vennir.cart") ?? "{}")).toMatchObject({ team: null, actions: ["growth-report"] });
      cart.forget();
      cleanup();
    }
  });

  it("offers single sign-on only when the install has it", async () => {
    await renderAt("/login", null, { "AuthService/GetEnvironment": { label: "test", ssoLabel: "Google" } });
    expect(await screen.findByRole("button", { name: /sign in with google/i })).toBeTruthy();
    cleanup();

    await renderAt("/login", null);
    await screen.findByLabelText(/email/i);
    expect(screen.queryByRole("button", { name: /sign in with google/i })).toBeNull();
  });

  it("takes a session back from single sign-on only when this tab started that sign-in", async () => {
    // A link carrying someone else's session: no sign-in was started here.
    window.history.replaceState(null, "", "/login#token=someone-elses&tab=0123456789abcdef0123456789abcdef");
    await renderAt("/login", null);
    expect(await screen.findByText(/wasn't started from this window/i)).toBeTruthy();
    expect(localStorage.getItem("token")).toBeNull();
    cleanup();

    // Back from the sign-in this tab started: its own value comes back.
    sessionStorage.setItem("vennir_sso_tab", "fedcba9876543210fedcba9876543210");
    window.history.replaceState(null, "", "/login#token=this-tabs&tab=fedcba9876543210fedcba9876543210");
    await renderAt("/login", null, { "AuthService/GetMe": MEMBER });
    await waitFor(() => {
      expect(localStorage.getItem("token")).toBe("this-tabs");
    });
    expect(sessionStorage.getItem("vennir_sso_tab")).toBeNull();
  });

  it("holds someone with a password set by someone else until they choose their own", async () => {
    let changed = false;
    await renderAt("/observe", { ...MEMBER, mustChangePassword: true }, {
      "AuthService/GetMe": () => ({ ...MEMBER, mustChangePassword: !changed }),
      "AuthService/ChangePassword": () => {
        changed = true;
        return { token: "their-own-session" };
      },
    });
    expect(await screen.findByRole("heading", { name: /choose your own password/i })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: /main/i })).toBeNull();
    expect(calls).not.toContain("ObserveService/GetSecurity");

    fireEvent.change(screen.getByLabelText(/temporary password/i), { target: { value: "from-the-admin" } });
    fireEvent.change(screen.getByLabelText(/^new password \*?$/i), { target: { value: "too-short" } });
    fireEvent.change(screen.getByLabelText(/new password, again/i), { target: { value: "too-short" } });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));
    expect(await screen.findByText(/at least 12 characters: this one has 9/i)).toBeTruthy();
    expect(calls).not.toContain("AuthService/ChangePassword");

    fireEvent.change(screen.getByLabelText(/^new password \*?$/i), { target: { value: "a-long-enough-one" } });
    fireEvent.change(screen.getByLabelText(/new password, again/i), { target: { value: "a-long-enough-one" } });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));
    expect(await screen.findByRole("navigation", { name: /main/i })).toBeTruthy();
    expect(localStorage.getItem("token")).toBe("their-own-session");
  });

  it("says when a team requires single sign-on instead of a password", async () => {
    await renderAt("/login", null, {
      "AuthService/GetEnvironment": { label: "test", ssoLabel: "Google" },
      "AuthService/Login": refused(403, "permission_denied", "payments signs in with Google: use that instead of a password.", "SSO_REQUIRED"),
    });
    fireEvent.change(await screen.findByLabelText(/email/i), { target: { value: "lee@acme.com" } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "their-password" } });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByText(/sign in with google instead/i)).toBeTruthy();
    expect(screen.getByText(/payments signs in with google/i)).toBeTruthy();
  });
});

describe("the Teams page", () => {
  it("sums up your teams, what needs them, and every other team for an admin", async () => {
    await renderAt("/teams", { ...ADMIN, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "TeamService/GetTeam": { team: { id: "t1", name: "payments", fromCatalog: true } },
      "TeamService/GetTeamProfile": { name: "payments", people: 7, description: "Takes card payments." },
      "TeamService/ListTeamSummaries": {
        teams: ["payments", "growth", "sandbox", "legacy"].map((name) => ({ name, owner: "@acme/growth", people: 14, running: 3, description: `What ${name} does.` })),
      },
      "TeamService/ListPods": { pods: [{ podName: "ek-1", state: "TASK_POD_STATE_RUNNING" }] },
      "SecretService/ListSecrets": { secrets: [{ id: "s1", secretName: "stripe-webhook", external: { status: "error" } }, { id: "s2", secretName: "db" }] },
      "TokenService/ListBots": { bots: [{ id: "b1", email: "payments-ci@bots.vennir.local" }] },
      "TemplateService/ListTemplates": { runnables: [{ kind: "KIND_TEMPLATE", team: "payments", name: "merchant-onboarding", shared: true }] },
      "ExecutionService/ListPendingApprovals": { approvals: [{ executionId: "r9", executionName: "refund-ledger for growth", taskId: "t", team: "payments", canDecide: true }] },
      "TeamService/ListTeams": {
        teams: [
          { id: "t1", name: "payments", fromCatalog: true },
          { id: "t2", name: "growth", fromCatalog: true },
          { id: "t3", name: "sandbox" },
          { id: "t4", name: "legacy", fromCatalog: true, retiredAt: "2026-10-21T12:00:00Z" },
        ],
      },
      "AdminService/GetCatalogStatus": { status: { problems: [{ item: "teams/sandbox", message: "made here", adoptableTeam: "sandbox" }] } },
    });
    const card = (await screen.findByRole("link", { name: "payments" })).closest("article") as HTMLElement;
    expect(within(card).getByText("You maintain it")).toBeTruthy();
    expect(await within(card).findByText("Takes card payments.")).toBeTruthy();
    expect(await within(card).findByText("merchant-onboarding")).toBeTruthy();
    expect(await within(card).findByText(/1 step waits for payments to approve/)).toBeTruthy();
    expect(within(card).getByRole("link", { name: "refund-ledger for growth" }).getAttribute("href")).toBe("/runs/r9");
    expect(await within(card).findByText("stripe-webhook")).toBeTruthy();
    expect(within(card).getByRole("link", { name: /^Bots/ }).getAttribute("href")).toBe("/teams/payments?tab=automation");

    const others = screen.getByRole("region", { name: /every other team · 3/i });
    expect(within(others).getByRole("link", { name: "Adopt…" }).getAttribute("href")).toBe("/admin/catalog");
    expect(within(others).getByRole("link", { name: "Restore or purge" }).getAttribute("href")).toBe("/teams/legacy?tab=settings");
    expect((await within(others).findAllByText("@acme/growth")).length).toBeGreaterThan(0);
    expect(within(others).getByText("What growth does.")).toBeTruthy();
    fireEvent.change(within(others).getByRole("searchbox", { name: "Find a team" }), { target: { value: "sand" } });
    expect(within(others).queryByRole("link", { name: "growth" })).toBeNull();
    expect(within(others).getByRole("link", { name: "sandbox" })).toBeTruthy();
  });
});

describe("a team's members", () => {
  it("say how each signs in, flag passwords a Google-only team refuses, and show an admin who joins by group", async () => {
    await renderAt("/teams/payments", { ...ADMIN, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "AuthService/GetEnvironment": { label: "test", ssoLabel: "Google" },
      "TeamService/GetTeam": { team: { id: "t2", name: "payments", requireSso: true } },
      "TeamService/ListMembers": {
        members: [
          { id: "u1", email: "ana@acme.com", hasPassword: true, usesSso: true, role: "TEAM_ROLE_MAINTAINER", isAdmin: true },
          { id: "u2", email: "lee@acme.com", hasPassword: true, role: "TEAM_ROLE_MEMBER" },
          { id: "u3", email: "sam@acme.com", usesSso: true, role: "TEAM_ROLE_MEMBER" },
        ],
      },
      "SsoService/ListSsoGroupMappings": {
        mappings: [
          { id: "m1", group: "payments-eng@acme.com", team: "payments", role: "TEAM_ROLE_MEMBER" },
          { id: "m2", group: "data-eng@acme.com", team: "data", role: "TEAM_ROLE_MEMBER" },
        ],
      },
    });
    expect(await screen.findByRole("heading", { name: "3 people" })).toBeTruthy();
    expect(screen.getByText("Password only")).toBeTruthy();
    expect(screen.getByText(/1 signs in with a password only, while payments requires Google/)).toBeTruthy();
    expect(await screen.findByText("payments-eng@acme.com")).toBeTruthy();
    expect(screen.queryByText("data-eng@acme.com")).toBeNull();
    // The role a new person gets: Member until Maintainer is chosen.
    fireEvent.click(screen.getByRole("button", { name: /^Maintainer/ }));
    expect(screen.getByRole("button", { name: /^Maintainer/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("offer no role change or removal for someone whose groups decide it", async () => {
    await renderAt("/teams/payments", { ...ADMIN, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
      "TeamService/ListMembers": {
        members: [
          { id: "u1", email: "ana@acme.com", hasPassword: true, role: "TEAM_ROLE_MAINTAINER" },
          { id: "u3", email: "sam@acme.com", usesSso: true, followsGroups: true, role: "TEAM_ROLE_MEMBER" },
          { id: "u4", email: "kim@acme.com", usesSso: true, followsGroups: true, viaGroups: ["payments-eng"], role: "TEAM_ROLE_MEMBER" },
        ],
      },
    });
    expect(await screen.findByRole("heading", { name: "3 people" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "ana@acme.com's role" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "sam@acme.com's role" })).toBeNull();
    // Which group, once a sign-in has recorded it.
    expect(screen.getByText("Set by their groups")).toBeTruthy();
    expect(screen.getByText("Set by their group payments-eng")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
  });
});

describe("the Teams pages' requests", () => {
  it("ask for every other team's facts in one call, and a tab's count again only when it's left", async () => {
    await renderAt("/teams", { ...ADMIN, teamNames: [], maintainerOf: [] }, {
      "TeamService/ListTeams": { teams: Array.from({ length: 10 }, (_, i) => ({ id: `t${String(i)}`, name: `team-${String(i)}` })) },
      "TeamService/ListTeamSummaries": { teams: [{ name: "team-3", people: 2, running: 5 }] },
    });
    const row = (await screen.findByRole("link", { name: "team-3" })).closest("tr") as HTMLElement;
    expect(await within(row).findByText("5")).toBeTruthy();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(calls.filter((c) => c === "TeamService/ListTeamSummaries").length).toBe(1);
    expect(calls.filter((c) => c === "TeamService/ListPods" || c === "TeamService/GetTeamProfile")).toEqual([]);
    cleanup();
    calls.length = 0;

    await renderAt("/teams/payments", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
    });
    await waitFor(() => { expect(calls).toContain("ApiService/ListApis"); });
    const apis = calls.filter((c) => c === "ApiService/ListApis").length;
    const members = calls.filter((c) => c === "TeamService/ListMembers").length;
    // Leaving Members reads its count again; nothing else is read again.
    fireEvent.click(screen.getByRole("tab", { name: /^Secrets/ }));
    await waitFor(() => { expect(calls.filter((c) => c === "TeamService/ListMembers").length).toBeGreaterThan(members); });
    expect(calls.filter((c) => c === "ApiService/ListApis").length).toBe(apis);
  });
});

describe("a team's bots", () => {
  it("call a bot whose only token has expired not active", async () => {
    await renderAt("/teams/payments?tab=automation", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
      "TokenService/ListBots": {
        bots: [{ id: "b1", email: "payments-ci@bots.vennir.local", tokens: [{ tokenId: "k1", label: "ci", expiresAt: "2020-01-01T00:00:00Z" }] }],
      },
    });
    expect(await screen.findByText(/No working token/)).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
  });
});

describe("a team's settings", () => {
  it("say a retired team is read-only, and offer an admin to restore it", async () => {
    await renderAt("/teams/old-team?tab=settings", ADMIN, {
      "TeamService/GetTeam": { team: { id: "t1", name: "old-team", retiredAt: "2026-10-21T12:00:00Z", retiredBy: "the catalog", fromCatalog: true } },
    });
    expect(await screen.findByText(/this team is retired: it's read-only/i)).toBeTruthy();
    expect(screen.getByText(/by the catalog\./)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Restore old-team" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /purge old-team/i })).toHaveProperty("disabled", false);
    // In the header, and in "Where it comes from".
    expect(screen.getAllByText("teams/old-team/")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Restore it" })).toBeTruthy();
  });

  it("name the members a Google-only rule would lock out, and keep the controls from non-admins", async () => {
    await renderAt("/teams/payments?tab=settings", { ...MEMBER, teamNames: ["payments"] }, {
      "AuthService/GetEnvironment": { label: "test", ssoLabel: "Google" },
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
      "TeamService/ListMembers": {
        members: [
          { id: "u1", email: "ana@acme.com", hasPassword: true, usesSso: true, role: "TEAM_ROLE_MAINTAINER" },
          { id: "u2", email: "lee@acme.com", hasPassword: true, usesSso: false, role: "TEAM_ROLE_MEMBER" },
          { id: "u3", email: "ci@bots.vennir.local", isBot: true, role: "TEAM_ROLE_MEMBER" },
        ],
      },
    });
    expect(await screen.findByText(/1 member signs in with a password only: lee@acme.com/i)).toBeTruthy();
    expect(screen.getByRole("switch", { name: /require google sign-in/i })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: /retire payments/i })).toBeNull();
  });

  it("say what the team does, from the catalog, under its name", async () => {
    await renderAt("/teams/payments", { ...MEMBER, teamNames: ["payments"] }, {
      "TeamService/GetTeam": { team: { id: "t2", name: "payments", fromCatalog: true } },
      "TeamService/GetTeamProfile": { name: "payments", fromCatalog: true, people: 3, description: "Takes card payments." },
    });
    expect(await screen.findByRole("heading", { name: "payments", level: 1 })).toBeTruthy();
    expect(await screen.findByText("Takes card payments.")).toBeTruthy();
  });

  it("show the install's limits beside a team's own", async () => {
    await renderAt("/teams/payments?tab=settings", { ...MEMBER, teamNames: ["payments"] }, {
      "TeamService/GetTeam": {
        team: { id: "t2", name: "payments", quota: { cpu: "16", pods: "50" }, quotaIsDefault: false, installQuota: { cpu: "4", memory: "8Gi", pods: "20" } },
      },
    });
    expect(await screen.findByText("16")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("8Gi")).toBeTruthy();
    expect(screen.getAllByText(/the install's:/)).toHaveLength(4);
  });

  it("let a maintainer set the team's chat webhook, which is never shown back", async () => {
    const saved: Record<string, unknown>[] = [];
    await renderAt("/teams/payments?tab=settings", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
      "NotificationService/GetTeamWebhook": { webhook: { configured: false }, allowedHosts: ["hooks.slack.com"] },
      "NotificationService/SetTeamWebhook": (request: Record<string, unknown>) => {
        saved.push(request);
        return { webhook: { configured: true, host: "hooks.slack.com", kinds: request["kinds"] } };
      },
    });
    fireEvent.change(await screen.findByLabelText(/webhook url/i), { target: { value: "https://hooks.slack.com/services/T/B/x" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /waits for the team's approval/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => { expect(saved).toEqual([{ team: "payments", url: "https://hooks.slack.com/services/T/B/x", kinds: ["run_failed", "product_not_ready", "step_refused"] }]); });
    expect(await screen.findByText("hooks.slack.com")).toBeTruthy();
    expect((screen.getByLabelText(/new webhook url/i) as HTMLInputElement).value).toBe("");
  });
});

describe("email", () => {
  it("lets you choose what's emailed, when the install sends email", async () => {
    const saved: Record<string, unknown>[] = [];
    await renderAt("/account", MEMBER, {
      "NotificationService/GetEmailPreferences": { available: true, kinds: ["run_failed"] },
      "NotificationService/SetEmailPreferences": (request: Record<string, unknown>) => {
        saved.push(request);
        return request;
      },
    });
    fireEvent.click(await screen.findByRole("checkbox", { name: "A run of mine finished" }));
    await waitFor(() => { expect(saved).toEqual([{ kinds: ["run_failed", "run_succeeded"] }]); });
  });
});

describe("another team's page", () => {
  it("says where to ask it, and what it offers you", async () => {
    await renderAt("/teams/gcp-platform", MEMBER, {
      "TeamService/GetTeamProfile": { name: "gcp-platform", fromCatalog: true, contact: "#gcp-platform", helpUrl: "https://wiki.example/gcp", people: 4 },
      "TemplateService/ListTemplates": {
        runnables: [
          { kind: "KIND_TEMPLATE", team: "gcp-platform", name: "app-on-cloud-run", displayName: "App on Cloud Run", shared: true, readiness: { state: "ready" } },
          { kind: "KIND_ACTION", team: "gcp-platform", name: "gcp-platform-sql-create", displayName: "Cloud SQL", shared: false, askForAccessUrl: "https://github.com/acme/catalog/issues/new" },
          { kind: "KIND_ACTION", team: "web", name: "web-site-deploy", displayName: "Site", shared: true },
        ],
      },
    });
    expect(await screen.findByText(/4 people, from the catalog\. Contact: #gcp-platform\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: /its help page/i }).getAttribute("href")).toBe("https://wiki.example/gcp");
    expect(await screen.findByText("App on Cloud Run")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByRole("link", { name: /ask for access/i }).getAttribute("href")).toBe("https://github.com/acme/catalog/issues/new");
    expect(screen.queryByText("Site")).toBeNull();
  });
});

describe("keyless bots", () => {
  it("let a maintainer have a bot sign in from a repository's CI jobs, with the job's snippet", async () => {
    const added: Record<string, unknown>[] = [];
    await renderAt("/teams/payments?tab=automation", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
      "TokenService/ListBots": { bots: [{ id: "b0b0b0b0-0000-4000-8000-000000000001", email: "payments-release@bots.vennir.local" }] },
      "TokenService/ListBotIdentities": { identities: [], issuers: ["https://token.actions.githubusercontent.com"], audience: "https://vennir.acme.dev" },
      "TokenService/AddBotIdentity": (request: Record<string, unknown>) => {
        added.push(request);
        return { identity: {} };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Sign in from CI…" }));
    fireEvent.change(screen.getByLabelText("Repository (owner/name)"), { target: { value: "acme/release" } });
    fireEvent.change(screen.getByLabelText(/only from this branch/i), { target: { value: "refs/heads/main" } });
    expect(screen.getByText(/audience=https:\/\/vennir\.acme\.dev/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => {
      expect(added).toEqual([
        { team: "payments", botId: "b0b0b0b0-0000-4000-8000-000000000001", issuer: "https://token.actions.githubusercontent.com", claims: { repository: "acme/release", ref: "refs/heads/main" } },
      ]);
    });
  });

  it("make a new bot that signs in only from CI, with no token", async () => {
    const made: Record<string, unknown>[] = [];
    await renderAt("/teams/payments?tab=automation", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
      "TokenService/ListBots": { bots: [] },
      "TokenService/ListBotIdentities": { identities: [], issuers: ["https://token.actions.githubusercontent.com"], audience: "https://vennir.acme.dev" },
      "TokenService/CreateKeylessBot": (request: Record<string, unknown>) => {
        made.push(request);
        return { email: "payments-deploy@bots.vennir.local", identity: { id: "i1" } };
      },
    });
    fireEvent.change(await screen.findByLabelText(/What will use it/), { target: { value: "deploy" } });
    expect(screen.getByRole("button", { name: "Create bot and token" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Keyless, from CI/ }));
    expect(screen.queryByRole("button", { name: "Create bot and token" })).toBeNull();
    const create = screen.getByRole("button", { name: "Create bot" });
    expect(create).toHaveProperty("disabled", true); // until the repository is named
    fireEvent.change(screen.getByLabelText(/Repository \(owner\/name\)/), { target: { value: "acme/deploy" } });
    fireEvent.click(create);
    await waitFor(() => {
      expect(made).toEqual([
        { team: "payments", email: "payments-deploy@bots.vennir.local", issuer: "https://token.actions.githubusercontent.com", claims: { repository: "acme/deploy" } },
      ]);
    });
    expect(calls).not.toContain("TokenService/CreateBotToken");
  });
});

describe("ordering bots", () => {
  it("list what they may order, and change it only after Edit", async () => {
    const saved: Record<string, unknown>[] = [];
    await renderAt("/teams/payments?tab=automation", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
      "TokenService/ListBots": {
        bots: [{ id: "b1", email: "payments-shop@bots.vennir.local", ordering: true, orderTemplates: ["payments/onboarding"], tokens: [{ id: "k1", label: "Shop" }] }],
      },
      "TokenService/SetBotOrders": (request: Record<string, unknown>) => {
        saved.push(request);
        return { templates: request["templates"] };
      },
    });
    const card = (await screen.findByRole("heading", { name: "payments-shop@bots.vennir.local" })).closest("article") as HTMLElement;
    expect(within(card).getByText("Ordering")).toBeTruthy();
    expect(within(card).getByText("payments/onboarding")).toBeTruthy();
    expect(within(card).queryByLabelText("Templates it may order")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(card).getByLabelText("Templates it may order"), { target: { value: "payments/onboarding\ndata/postgres-db" } });
    // The templates' Save, before the callback's.
    fireEvent.click(within(card).getAllByRole("button", { name: "Save" })[0] as HTMLElement);
    await waitFor(() => { expect(saved).toEqual([{ team: "payments", email: "payments-shop@bots.vennir.local", templates: ["payments/onboarding", "data/postgres-db"] }]); });
  });
});

describe("schedules", () => {
  it("are listed on the team's tab, and paused there", async () => {
    const changed: Record<string, unknown>[] = [];
    await renderAt("/teams/payments?tab=schedules", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
      "ScheduleService/ListSchedules": {
        schedules: [{ id: "s1", team: "payments", name: "nightly", kind: "template", runnableTeam: "gcp-platform", runnableName: "app-on-cloud-run", cron: "0 2 * * *", timeZone: "Europe/Berlin", botEmail: "payments-nightly@bots.vennir.local", enabled: true, nextRunAt: "2026-10-26T01:00:00Z", lastError: "Template gcp-platform/app-on-cloud-run isn't shared with you." }],
      },
      "ScheduleService/UpdateSchedule": (request: Record<string, unknown>) => {
        changed.push(request);
        return { schedule: {} };
      },
    });
    expect(await screen.findByText("Every day at 02:00")).toBeTruthy();
    expect(screen.getByText(/isn't shared with you/)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "nightly on" }));
    await waitFor(() => { expect(changed).toEqual([{ id: "s1", enabled: false }]); });
  });

  it("are edited there: when and as which bot, and their inputs on the run form", async () => {
    const changed: Record<string, unknown>[] = [];
    const nightly = {
      id: "s1", team: "payments", name: "nightly", kind: "template", runnableTeam: "gcp-platform", runnableName: "app-on-cloud-run",
      parameters: { projectId: "orders-api" }, cron: "0 2 * * *", timeZone: "Europe/Berlin", botId: "b1", botEmail: "payments-nightly@bots.vennir.local", enabled: true,
    };
    await renderAt("/teams/payments?tab=schedules", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
      "ScheduleService/ListSchedules": { schedules: [nightly] },
      "TokenService/ListBots": { bots: [{ id: "b1", email: "payments-nightly@bots.vennir.local" }, { id: "b2", email: "payments-release@bots.vennir.local" }] },
      "TemplateService/ListTemplates": {
        runnables: [{ kind: "KIND_TEMPLATE", team: "gcp-platform", name: "app-on-cloud-run", displayName: "App on Cloud Run", shared: true, actions: [],
          parameters: { type: "object", required: ["projectId"], properties: { projectId: { type: "string", title: "Project ID" } } } }],
      },
      "ScheduleService/UpdateSchedule": (request: Record<string, unknown>) => {
        changed.push(request);
        return { schedule: { ...nightly, ...request } };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit nightly" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit nightly" });
    expect(within(dialog).getByText("projectId: \"orders-api\"")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true); // nothing changed yet
    fireEvent.mouseDown(within(dialog).getByRole("combobox", { name: "When" }));
    fireEvent.click(await screen.findByRole("option", { name: "Weekdays at 09:00" }));
    fireEvent.mouseDown(within(dialog).getByRole("combobox", { name: "Runs as" }));
    fireEvent.click(await screen.findByRole("option", { name: "payments-release@bots.vennir.local" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => { expect(changed).toEqual([{ id: "s1", cron: "0 9 * * 1-5", timeZone: "Europe/Berlin", botId: "b2" }]); });
    await waitFor(() => { expect(screen.queryByRole("dialog")).toBeNull(); });

    // Its inputs: on the run form, filled in, saved back to it rather than run.
    fireEvent.click(screen.getByRole("button", { name: "Edit nightly" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Edit nightly" })).getByRole("link", { name: "Change inputs…" }));
    expect(await screen.findByText(/Changing the inputs of the schedule/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    const project = screen.getByLabelText(/project id/i);
    expect((project as HTMLInputElement).value).toBe("orders-api");
    fireEvent.change(project, { target: { value: "orders-api-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save to schedule" }));
    await waitFor(() => { expect(changed[1]).toEqual({ id: "s1", parameters: { projectId: "orders-api-2" } }); });
    expect(await screen.findByRole("button", { name: "Edit nightly" })).toBeTruthy(); // back on the team's schedules
  });
});

describe("Compose's cart", () => {
  it("asks which of several fills an input, in its card, and wires them again with the choice", async () => {
    const previews: Record<string, unknown>[] = [];
    const product = (name: string) => ({ id: name, name, image: `registry.example/apps/${name}@sha256:aa`, action: "create", teamName: "azure-apps", inputSchema: { type: "object" } });
    const step = (id: string, inputs: Record<string, unknown> = {}) => ({ id, product: id, inputs });
    const options = [
      { step: "deploy", input: "projectId", fromStep: "dev-project", fromOutput: "projectId", label: "dev-project's projectId" },
      { step: "deploy", input: "projectId", fromStep: "prod-project", fromOutput: "projectId", label: "prod-project's projectId" },
    ];
    await renderAt("/catalog/compose", MEMBER, {
      "ProductService/ListProducts": { products: ["deploy", "dev-project", "prod-project"].map(product) },
      "TemplateService/ListTemplates": {
        runnables: ["deploy", "dev-project", "prod-project"].map((name) => ({ kind: "KIND_ACTION", team: "azure-apps", name, actions: [`azure-apps/${name}.create`], shared: true })),
      },
      "OrderService/PreviewOrder": (request: Record<string, unknown>) => {
        previews.push(request);
        const chosen = Array.isArray(request["choices"]) && request["choices"].length > 0;
        const wired = { kind: "step", step: chosen ? "prod-project" : "dev-project", output: "projectId" };
        return chosen
          ? { steps: [step("dev-project"), step("prod-project"), step("deploy", { projectId: wired })] }
          : {
              steps: [step("dev-project"), step("prod-project"), step("deploy", { projectId: { kind: "unset" } })],
              problems: [{ code: "AMBIGUOUS", step: "deploy", input: "projectId", message: "Two steps provide a project: choose one.", options }],
            };
      },
    });
    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("option", { name: /^deploy/ }));
    fireEvent.click(screen.getByRole("button", { name: "Wire them" }));
    fireEvent.click(await screen.findByRole("radio", { name: /prod-project's projectId/ }));
    await waitFor(() => {
      expect(previews).toHaveLength(2);
    });
    expect(previews[1]).toMatchObject({ choices: [{ step: "deploy", input: "projectId", fromStep: "prod-project", fromOutput: "projectId" }] });
    // The choice stays shown, to change.
    expect(await screen.findByText("prod-project's projectId")).toBeTruthy();
  });
});

describe("a product's readiness", () => {
  it("says what it lacks here, and lets its team check it again", async () => {
    const checked: Record<string, unknown>[] = [];
    await renderAt("/products", { ...MEMBER, teamNames: ["gcp-platform"] }, {
      "ProductService/ListProducts": {
        products: [
          {
            id: "p1",
            name: "gcp-platform-project-create",
            image: "registry.example/gcp-platform/project@sha256:aa",
            action: "create",
            teamName: "gcp-platform",
            releases: [{ image: "registry.example/gcp-platform/project@sha256:aa" }],
            readiness: { state: "not_ready", principal: "project-sa@acme.iam", missing: ["roles/resourcemanager.projectCreator on folder 12"] },
          },
        ],
      },
      "ProductService/CheckProduct": (request: Record<string, unknown>) => {
        checked.push(request);
        return { started: true };
      },
    });
    // Its team's section is open (the first); then the product.
    fireEvent.click(await screen.findByRole("button", { name: "project" }));
    expect(await screen.findByText("roles/resourcemanager.projectCreator on folder 12")).toBeTruthy();
    expect(screen.getByText("project-sa@acme.iam")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => { expect(checked).toEqual([{ name: "gcp-platform-project-create" }]); });
    expect(await screen.findByText(/checking now/i)).toBeTruthy();
  });

  it("says, while it's checked again, that what it lacks is the last answer", async () => {
    await renderAt("/products", { ...MEMBER, teamNames: ["gcp-platform"] }, {
      "ProductService/ListProducts": {
        products: [
          {
            id: "p1",
            name: "gcp-platform-project-create",
            image: "registry.example/gcp-platform/project@sha256:aa",
            action: "create",
            teamName: "gcp-platform",
            releases: [{ image: "registry.example/gcp-platform/project@sha256:aa" }],
            readiness: { state: "checking", principal: "project-sa@acme.iam", missing: ["roles/resourcemanager.projectCreator on folder 12"] },
          },
        ],
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "project" }));
    expect(await screen.findByText("roles/resourcemanager.projectCreator on folder 12")).toBeTruthy();
    expect(screen.getByText(/its last check's answer, until this one finishes/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
  });
});

describe("notifications", () => {
  it("show how many are unread, and open what one is about", async () => {
    const read: Record<string, unknown>[] = [];
    await renderAt("/", MEMBER, {
      "NotificationService/ListNotifications": {
        notifications: [
          { id: "n1", kind: "run_failed", title: "billing-api staging failed", body: "Step deploy failed: QUOTA.", link: "/runs/0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11", createdAt: "2026-10-21T16:26:00Z", read: false },
          { id: "n2", kind: "run_succeeded", title: "orders finished", link: "/runs/x", createdAt: "2026-10-21T16:00:00Z", read: true },
        ],
        unreadCount: 1,
      },
      "NotificationService/MarkNotificationsRead": (request: Record<string, unknown>) => {
        read.push(request);
        return {};
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    // The bell's list, not Home's own: it's shown last, in a popover.
    fireEvent.click((await screen.findAllByText("billing-api staging failed")).at(-1) as HTMLElement);
    await waitFor(() => { expect(read).toEqual([{ ids: ["n1"] }]); });
    // On the run's page now.
    expect(await screen.findByLabelText("Loading the run")).toBeTruthy();
  });
});

describe("home for an admin", () => {
  it("shows the install at a glance and the deletes waiting for an admin", async () => {
    await renderAt("/", ADMIN, {
      "AdminService/GetCatalogStatus": { status: { release: "registry.example/catalog-release", version: "v1.18.0", commit: "3f2be1d0", problems: [] } },
      "ObserveService/GetSecurity": {
        images: [{ product: "flagger", team: "growth", image: "registry.example/growth/flagger:0.9@sha256:aa", scan: "failed" }],
        refusals: [{ what: "a step", team: "growth", code: "IMAGE_NOT_ALLOWED", source: "step", count: 3 }],
      },
      "ResourceService/ListDeleteRequests": { requests: [{ id: "d1", resources: [{ id: "r1", type: "pg/instance", externalId: "orders-db-stg", name: "orders-db-stg" }] }] },
    });
    expect(await screen.findByRole("heading", { name: /test at a glance/ })).toBeTruthy();
    expect(await screen.findByText("Catalog release v1.18.0 applied")).toBeTruthy();
    expect(screen.getByText("1 image fails its scan")).toBeTruthy();
    expect(screen.getByText("3 steps refused this week")).toBeTruthy();
    expect(await screen.findByText("1 delete waits for an admin")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Decide" }).getAttribute("href")).toBe("/runs/made");
  });
});

describe("the catalog's cart", () => {
  it("collects an action beside the catalog, says it's in, and removes it", async () => {
    await renderAt("/catalog", MEMBER, {
      "TemplateService/ListTemplates": { runnables: [{ kind: "KIND_ACTION", team: "gcp", name: "gcp-bucket-create", displayName: "Bucket", actions: ["gcp/bucket.create"], shared: true }] },
      "OrderService/PreviewOrder": { steps: [{ id: "bucket", product: "gcp-bucket-create", inputs: {} }] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add to cart" }));
    expect(await screen.findByRole("link", { name: "In your cart" })).toBeTruthy();
    expect(await screen.findByText("1 step, in the order they can run")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove Bucket" }));
    expect(await screen.findByRole("button", { name: "Add to cart" })).toBeTruthy();
  });
});

describe("Compose's drafts", () => {
  it("opens the draft a link names, its steps listed", async () => {
    await renderAt("/catalog/compose?draft=azure-apps%2Fnightly", MEMBER, {
      "ProductService/ListProducts": { products: [{ id: "p1", name: "deploy", displayName: "Deploy", image: "registry.example/apps/deploy@sha256:aa", action: "create", teamName: "azure-apps", inputSchema: { type: "object" } }] },
      "DraftService/ListDrafts": { drafts: [{ team: "azure-apps", name: "nightly", version: "1", body: { displayName: "Nightly", steps: [{ id: "deploy", product: "deploy", inputs: {} }] } }] },
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Nightly" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Deploy/, pressed: true })).toBeTruthy();
  });

  it("says beside Run now why it can't run yet", async () => {
    await renderAt("/catalog/compose", MEMBER);
    expect(await screen.findByText("Add a step to run it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run now" }).getAttribute("aria-describedby")).toBe("run-why");
  });

  it("drops wiring started for one draft when another is opened before it answers", async () => {
    let answer: (value: unknown) => void = () => {};
    const product = (name: string) => ({ id: name, name, image: `registry.example/apps/${name}@sha256:aa`, action: "create", teamName: "azure-apps", inputSchema: { type: "object" } });
    await renderAt("/catalog/compose?draft=azure-apps%2Fnightly", MEMBER, {
      "ProductService/ListProducts": { products: ["deploy", "check"].map(product) },
      "TemplateService/ListTemplates": { runnables: ["deploy", "check"].map((name) => ({ kind: "KIND_ACTION", team: "azure-apps", name, actions: [`azure-apps/${name}.create`], shared: true })) },
      "DraftService/ListDrafts": {
        drafts: [
          { team: "azure-apps", name: "nightly", version: "1", body: { displayName: "Nightly", steps: [] } },
          { team: "azure-apps", name: "weekly", version: "2", body: { displayName: "Weekly", steps: [{ id: "check", product: "check", inputs: {} }] } },
        ],
      },
      "OrderService/PreviewOrder": () => new Promise((resolve) => { answer = resolve; }),
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Nightly" })).toBeTruthy();
    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("option", { name: /^deploy/ }));
    fireEvent.click(screen.getByRole("button", { name: "Wire them" }));
    await waitFor(() => { expect(calls).toContain("OrderService/PreviewOrder"); });
    // Another draft opened while it wires; then the answer for the first arrives.
    fireEvent.click(screen.getByRole("button", { name: /^weekly/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Weekly" })).toBeTruthy();
    act(() => { answer({ steps: [{ id: "deploy", product: "deploy", inputs: {} }] }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1500)); });
    // Weekly keeps its own step, and nothing is saved over it or deleted.
    expect(screen.getByRole("button", { name: /check/i, pressed: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /deploy/i, pressed: true })).toBeNull();
    expect(calls).not.toContain("DraftService/SaveDraft");
    expect(calls).not.toContain("DraftService/DeleteDraft");
  });
});


describe("Observe's alerts", () => {
  it("show the charts' rules, firing first with what each fires for and since when", async () => {
    await renderAt("/observe?tab=metrics", MEMBER, {
      "ObserveService/ListAlerts": {
        configured: true,
        checkedAt: "2026-10-30T14:29:00Z",
        rules: [
          {
            name: "VennirGatewayBackendUnreachable",
            severity: "warning",
            summary: "The gateway can't reach …'s backend.",
            state: "firing",
            hidden: 1,
            instances: [{ state: "firing", activeAt: "2026-10-30T13:58:00Z", summary: "The gateway can't reach payments/orders's backend.", labels: { api: "payments/orders" } }],
          },
          { name: "VennirSchedulerDown", severity: "critical", summary: "No scheduler has finished a pass in 10 minutes.", state: "inactive" },
        ],
      },
    });
    const card = await screen.findByRole("region", { name: "Alerts" });
    expect(await within(card).findByText("The gateway can't reach payments/orders's backend.")).toBeTruthy();
    expect(within(card).getByText("api=payments/orders")).toBeTruthy();
    expect(within(card).getByText(/^Firing since/)).toBeTruthy();
    expect(within(card).getByText("And 1 about an API you can't see.")).toBeTruthy();
    expect(within(card).getByText("Quiet")).toBeTruthy();
    expect(within(card).getByText(/^1 firing · checked/)).toBeTruthy();
  });

  it("on Google Cloud's managed Prometheus, say where they're from, and what's missing when Google refuses", async () => {
    const rules = [
      {
        name: "VennirGatewayBackendUnreachable",
        severity: "critical",
        summary: "The gateway can't reach …'s backend.",
        state: "firing",
        instances: [{ state: "firing", activeAt: "2026-10-30T13:58:00Z", labels: { api: "payments/orders", namespace: "vennir-system" } }],
      },
      { name: "VennirSchedulerDown", severity: "critical", summary: "No scheduler has finished a pass in 10 minutes.", state: "inactive" },
    ];
    await renderAt("/observe?tab=metrics", MEMBER, {
      "ObserveService/ListAlerts": { configured: true, source: "google", project: "acyclix-dev", checkedAt: "2026-10-30T14:29:00Z", rules },
    });
    let card = await screen.findByRole("region", { name: "Alerts" });
    expect(await within(card).findByText(/^1 firing · from Google Cloud · checked/)).toBeTruthy();
    expect(within(card).getByText("acyclix-dev")).toBeTruthy();
    expect(within(card).getByText("api=payments/orders · namespace=vennir-system")).toBeTruthy();
    expect(within(card).getByText(/^Since /)).toBeTruthy();
    expect(within(card).getByText(/Google keeps which alerts fire and their labels/)).toBeTruthy();
    cleanup();

    const problem = "Google's managed Prometheus refused the console (403): its Google identity needs roles/monitoring.viewer on acyclix-dev, which vennir apply grants.";
    await renderAt("/observe?tab=metrics", MEMBER, {
      "ObserveService/ListAlerts": {
        configured: true, source: "google", project: "acyclix-dev", checkedAt: "2026-10-30T14:29:00Z", stateUnknown: true, problem,
        rules: rules.map((r) => ({ ...r, state: "unknown", instances: [] })),
      },
    });
    card = await screen.findByRole("region", { name: "Alerts" });
    expect(await within(card).findByText("Which ones fire can't be read")).toBeTruthy();
    expect(within(card).getByText(/needs roles\/monitoring.viewer on acyclix-dev/)).toBeTruthy();
    expect(within(card).getAllByText("Unknown")).toHaveLength(2);
    expect(within(card).getByText(/^state unknown · checked/)).toBeTruthy();
    expect(within(card).queryByText(/^Couldn't read the alerts/)).toBeNull();
  });

  it("say when the console reads no Prometheus, or it isn't answering", async () => {
    await renderAt("/observe?tab=metrics", MEMBER, { "ObserveService/ListAlerts": { configured: false } });
    expect(await screen.findByText(/reads no Prometheus here/)).toBeTruthy();
    cleanup();
    await renderAt("/observe?tab=metrics", MEMBER, { "ObserveService/ListAlerts": { configured: true, problem: "Prometheus isn't answering." } });
    expect(await screen.findByText("Couldn't read the alerts: Prometheus isn't answering.")).toBeTruthy();
  });
});

describe("Observe's usage", () => {
  const USAGE = {
    days: 7,
    runs: 630,
    previousRuns: 509,
    steps: 1738,
    teams: [
      { team: "growth", runs: 412, previousRuns: 300, byPeople: 38, byBots: 352, bySchedules: 22, steps: 1236, used: [{ name: "refund-ledger", count: 280 }], ranFor: [] },
      { team: "payments", runs: 214, previousRuns: 200, byPeople: 52, byBots: 140, bySchedules: 22, steps: 498, used: [{ name: "payouts-batch", count: 162 }], ranFor: [{ name: "growth", count: 280 }, { name: "payments", count: 162 }, { name: "", count: 3 }] },
      { team: "", runs: 4, previousRuns: 0, byPeople: 4, steps: 4, used: [], ranFor: [] },
      { team: "quiet", runs: 0, previousRuns: 9, steps: 0, used: [], ranFor: [] },
    ],
    products: [
      { product: "refund-ledger", team: "payments", action: "refund", registered: true, steps: 283, runs: 283, usedBy: [{ name: "growth", count: 280 }, { name: "", count: 3 }], lastUsed: "2026-10-31T12:00:00Z" },
      { product: "localhost:5001/sandbox/try-me", team: "sandbox", action: "run", registered: false, steps: 9, runs: 9, usedBy: [{ name: "sandbox", count: 9 }] },
    ],
  };

  it("adds up the period, lists teams busiest first, and switches to products and to a month", async () => {
    const asked: unknown[] = [];
    await renderAt("/observe?tab=usage", ADMIN, {
      "ObserveService/GetUsage": (request: Record<string, unknown>) => {
        asked.push(request["days"]);
        return USAGE;
      },
      "TeamService/ListTeams": { teams: [{ id: "1", name: "growth" }, { id: "2", name: "payments" }, { id: "3", name: "quiet" }] },
    });
    expect(await screen.findByText("630")).toBeTruthy();
    expect(screen.getByText("up from 509 the week before")).toBeTruthy();
    expect(await screen.findByText("2 of 3")).toBeTruthy();
    expect(screen.getByText("and 1 image that isn't a product")).toBeTruthy();
    expect(screen.getByRole("link", { name: "growth" })).toBeTruthy();
    expect(screen.getByText("No team")).toBeTruthy();
    expect(screen.getByText("bots 140 · people 52 · schedules 22")).toBeTruthy();
    expect(screen.getByText("growth 280 · itself 162 · No team 3")).toBeTruthy();
    // A team that ran nothing this period isn't a row.
    expect(screen.queryByRole("link", { name: "quiet" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "By product" }));
    expect(await screen.findByText("payments · refund")).toBeTruthy();
    expect(screen.getByText("not a registered product · ran in sandbox")).toBeTruthy();
    expect(screen.getByText("growth 280 · No team 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "30 days" }));
    await waitFor(() => {
      expect(asked).toEqual([7, 30]);
    });
  });

  it("gives each of your team cards its last 7 days", async () => {
    await renderAt("/teams", { ...MEMBER, teamNames: ["payments"] }, { "ObserveService/GetUsage": USAGE });
    expect(await screen.findByText(/runs started for payments: bots 140, people 52, schedules 22\./)).toBeTruthy();
    expect(screen.getByText(/Its products ran for growth 280, itself 162, No team 3\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Every team's usage" }).getAttribute("href")).toBe("/observe?tab=usage");
  });
});

describe("a run a schedule started", () => {
  const RUN = {
    executionId: "5c5c5c5c-0000-4000-8000-000000000005",
    name: "nightly uptime check",
    teams: ["payments"],
    createdAt: "2026-10-30T02:00:00Z",
    state: "EXECUTION_STATE_SUCCEEDED",
    submittedBy: "b0b0b0b0-0000-4000-8000-000000000001",
    submittedByEmail: "payments-nightly@bots.vennir.local",
    schedule: "nightly",
  };

  it("says which, in the Runs list", async () => {
    await renderAt("/runs", MEMBER, { "ExecutionService/ListExecutions": { executions: [RUN] } });
    expect(await screen.findByText("on the schedule nightly")).toBeTruthy();
  });

  it("links to it from the run's page", async () => {
    const execution = { executionId: RUN.executionId, name: RUN.name, state: RUN.state, tasks: [], submittedBy: RUN.submittedByEmail, onBehalfOf: "payments", schedule: "nightly", createdAt: RUN.createdAt };
    await renderAt(`/runs/${RUN.executionId}`, MEMBER, {
      "ExecutionService/GetExecution": { execution },
      "ExecutionService/WatchExecution": [{ execution }],
    });
    expect((await screen.findByRole("link", { name: "nightly" })).getAttribute("href")).toBe("/teams/payments?tab=schedules");
  });
});

describe("a bot's CI identities", () => {
  it("say when each was added, and when it was last used", async () => {
    await renderAt("/teams/payments?tab=automation", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
      "TokenService/ListBots": { bots: [{ id: "b0b0b0b0-0000-4000-8000-000000000001", email: "payments-release@bots.vennir.local" }] },
      "TokenService/ListBotIdentities": {
        identities: [{ id: "i1", botId: "b0b0b0b0-0000-4000-8000-000000000001", botEmail: "payments-release@bots.vennir.local", issuer: "https://token.actions.githubusercontent.com", claims: { repository: "acme/release" }, createdAt: "2026-10-02T09:00:00Z" }],
        issuers: ["https://token.actions.githubusercontent.com"],
        audience: "https://vennir.acme.dev",
      },
    });
    expect(await screen.findByText(/^added .+ · last used never$/)).toBeTruthy();
  });
});

describe("Admin's catalog section", () => {
  it("says what the applied release held", async () => {
    await renderAt("/admin/catalog", ADMIN, {
      "AdminService/GetCatalogStatus": {
        status: {
          release: "registry.example/catalog-release",
          commit: "c1",
          appliedAt: "2026-10-29T10:00:00Z",
          applied: { teams: 5, products: 14, actions: 20, templates: 6, secretStores: 4 },
        },
      },
    });
    expect(await screen.findByText("5 teams, 14 products (20 actions), 6 templates, 4 SecretStores")).toBeTruthy();
  });
});

describe("Observe's log search, for one API", () => {
  it("searches one API product's backend, its team chosen with it", async () => {
    const asked: Record<string, unknown>[] = [];
    await renderAt("/observe?tab=logs&from=api&team=payments&api=orders&hours=24", { ...MEMBER, teamNames: ["payments"] }, {
      "ApiService/ListApis": { apis: [{ team: "payments", name: "orders", state: "API_STATE_LIVE" }, { team: "payments", name: "ledger", state: "API_STATE_LIVE" }, { team: "ml", name: "scoring", state: "API_STATE_LIVE" }] },
      "ObserveService/SearchLogs": (request: Record<string, unknown>) => {
        asked.push(request);
        return { lines: [], searchDays: 30 };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Search/ }));
    await waitFor(() => { expect(asked.at(-1)).toMatchObject({ source: "api", team: "payments", api: "orders" }); });
    expect(await screen.findByText(/from payments\/orders’s backend/)).toBeTruthy();
    // Only the APIs of the caller's teams are offered.
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "API" }));
    expect(await screen.findByRole("option", { name: "payments/ledger" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "ml/scoring" })).toBeNull();
  });
});

describe("an API's limits", () => {
  it("say each calling team's, and everyone else's, to whoever sees it", async () => {
    const api = { team: "payments", name: "orders", displayName: "Orders API", state: "API_STATE_LIVE", mayCall: false, endpoints: [], limits: [{ team: "growth", perMinute: 1200 }], defaultPerMinute: 600 };
    await renderAt("/apis/payments/orders", MEMBER, { "ApiService/GetApi": { api, openapi: "{}" } });
    expect(await screen.findByText("growth · 1,200 a minute")).toBeTruthy();
    expect(screen.getByText("Every other team · 600 a minute")).toBeTruthy();
    expect(screen.getByText(/its api\.yaml's default/)).toBeTruthy();
  });
});

describe("Admin's image sources", () => {
  it("say who last saved them", async () => {
    await renderAt("/admin/images", ADMIN, {
      "ImageService/GetImagePolicy": { policy: { exists: true, source: "registry.example/", allowed: ["registry.example/"], lastSavedBy: "priya@acme.com", lastSavedAt: "2026-10-18T09:00:00Z" } },
    });
    expect(await screen.findByText(/^Last saved by priya@acme\.com, .+\. Admins are alerted when these change\.$/)).toBeTruthy();
  });
});

describe("an order's run", () => {
  it("says what its cart held, what the plan added, and which resource each choice took", async () => {
    const execution = {
      executionId: "6d6d6d6d-0000-4000-8000-000000000006",
      name: "Order: project, app-hosting",
      state: "EXECUTION_STATE_SUCCEEDED",
      tasks: [],
      submittedBy: "ana@acme.com",
      onBehalfOf: "payments",
      template: "order",
      templateParameters: {
        actions: ["gcp-platform-app-hosting-create"],
        choices: [{ step: "app-hosting", input: "projectId", resourceId: "r1" }],
        values: { "app-hosting": { serviceName: "orders-api-stg" } },
        steps: [
          { id: "identity", product: "identity-service-identity-create", added: true },
          { id: "app-hosting", product: "gcp-platform-app-hosting-create", added: false },
        ],
      },
      dag: {
        name: "Order",
        tasks: [
          { id: "identity", image: "registry.example/identity/service-identity@sha256:aa", action: "create", team: "identity" },
          { id: "app-hosting", image: "registry.example/gcp-platform/app-hosting@sha256:bb", action: "create", team: "gcp-platform" },
        ],
      },
    };
    await renderAt(`/runs/${execution.executionId}`, MEMBER, {
      "ExecutionService/GetExecution": { execution },
      "ExecutionService/WatchExecution": [{ execution }],
      "ResourceService/ListResources": { resources: [{ id: "r1", type: "gcp/project", externalId: "orders-api", name: "orders-api", executionId: "1e1e1e1e-0000-4000-8000-000000000001", ownerTeam: "payments", firstReportedAt: "2026-10-20T10:00:00Z" }] },
    });
    const card = await screen.findByRole("region", { name: "Ordered from the cart, for payments" });
    expect(within(card).getByText("app-hosting · create")).toBeTruthy();
    expect(within(card).getByText("gcp-platform · serviceName orders-api-stg")).toBeTruthy();
    expect(within(card).getByText("Added")).toBeTruthy();
    expect(within(card).getByText(/^identity · the plan added it/)).toBeTruthy();
    expect((await within(card).findByRole("link", { name: "orders-api" })).getAttribute("href")).toBe("/runs/1e1e1e1e-0000-4000-8000-000000000001");
    expect(within(card).getByText(/^gcp\/project, made .+ for payments$/)).toBeTruthy();
  });
});

describe("a cart Ask proposes", () => {
  it("shows each line's team, product and verb, and what it takes from an earlier step", async () => {
    await renderAt("/", MEMBER, {
      "ChatService/GetChatSettings": { enabled: true, model: "claude-haiku-5-5" },
      "ChatService/AskStream": () => [{ answer: { text: "I've filled a cart.", cart: { team: "payments", actions: ["data-platform-postgres-db-create", "gcp-platform-app-hosting-deploy"] } } }],
      "OrderService/PreviewOrder": {
        steps: [
          { id: "postgres-db", product: "data-platform-postgres-db-create", inputs: {} },
          { id: "app-hosting", product: "gcp-platform-app-hosting-deploy", inputs: { database: { kind: "step", step: "postgres-db", output: "connection" } } },
        ],
      },
      "TemplateService/ListTemplates": {
        runnables: [
          { kind: "KIND_ACTION", team: "data-platform", name: "data-platform-postgres-db-create", actions: ["data-platform/postgres-db.create"], shared: true },
          { kind: "KIND_ACTION", team: "gcp-platform", name: "gcp-platform-app-hosting-deploy", actions: ["gcp-platform/app-hosting.deploy"], shared: true },
        ],
      },
    });
    fireEvent.change(await screen.findByRole("textbox", { name: "Ask Vennir" }), { target: { value: "A database and app hosting?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    const proposed = await screen.findByRole("region", { name: "Proposed cart" });
    expect(await within(proposed).findByText("gcp-platform/app-hosting")).toBeTruthy();
    expect(within(proposed).getByText("data-platform/postgres-db")).toBeTruthy();
    expect(within(proposed).getByText(/· deploy, its database from step 1/)).toBeTruthy();
  });
});

describe("products for other installs", () => {
  // A gcp install's catalog with an aws-only action, shared with you.
  const GCP = { label: "gke-prod", cloud: "gcp" };
  const S3 = {
    kind: "KIND_ACTION",
    team: "aws-platform",
    name: "aws-platform-s3-bucket-create",
    displayName: "S3 bucket",
    actions: ["aws-platform/s3-bucket.create"],
    parameters: { type: "object", properties: { name: { type: "string" }, region: { type: "string" } } },
    shared: true,
    clouds: ["aws"],
    sourceUrl: "https://github.com/acme/vennir-catalog/blob/main/teams/aws-platform/s3-bucket/product.yaml",
  };
  const BUCKET = { kind: "KIND_ACTION", team: "data-platform", name: "data-platform-object-bucket-create", displayName: "Object bucket", actions: ["data-platform/object-bucket.create"], shared: true, runsHere: true };

  it("are listed last in the catalog, in a group of their own, with Run and Add to cart off and why", async () => {
    await renderAt("/catalog", MEMBER, { "AuthService/GetEnvironment": GCP, "TemplateService/ListTemplates": { runnables: [S3, BUCKET] } });
    const group = await screen.findByRole("region", { name: /For other installs/ });
    expect(within(group).getByText(/gke-prod is on gcp\. These are for installs on other clouds/)).toBeTruthy();
    expect(within(group).getByRole("heading", { name: "S3 bucket" })).toBeTruthy();
    expect(within(group).getByText("For aws installs")).toBeTruthy();
    const why = "Can't run here: it's for aws installs, and gke-prod is on gcp.";
    expect(within(group).getByText(why)).toBeTruthy();
    for (const name of ["Run", "Add to cart"]) {
      const button = within(group).getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-describedby")).toBe("not-here-aws-platform-s3-bucket-create");
    }
    expect(screen.getByText(/the 1 for other installs last/)).toBeTruthy();
    // What runs here stays where it was.
    expect(within(group).queryByRole("heading", { name: "Object bucket" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Object bucket" })).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /only what i can run/i }));
    expect(screen.queryByRole("region", { name: /For other installs/ })).toBeNull();
  });

  it("say on Every product where their clouds are set, in place of a check, with Run off", async () => {
    await renderAt("/products", MEMBER, {
      "AuthService/GetEnvironment": GCP,
      "TemplateService/ListTemplates": { runnables: [S3] },
      "ProductService/ListProducts": {
        products: [
          {
            id: "p1",
            name: "aws-platform-s3-bucket-create",
            displayName: "S3 bucket",
            image: "registry.example/aws-platform/s3-bucket:1.0.2@sha256:aa",
            action: "create",
            teamName: "aws-platform",
            shareWith: ["*"],
            serviceAccount: "aws-s3-bucket",
            releases: [{ image: "registry.example/aws-platform/s3-bucket:1.0.2@sha256:aa" }],
            clouds: ["aws"],
            cloudsFrom: "team",
          },
        ],
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "S3 bucket" }));
    expect(await screen.findByText("This install is on gcp, so it isn't checked or run here.")).toBeTruthy();
    expect(screen.getByText(/for all its products; its/)).toBeTruthy();
    expect(screen.getByText("clouds: [aws]")).toBeTruthy();
    expect(screen.getByText("Runs only on aws installs.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Run on its own" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Add to cart" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: /^For other installs/ })).toBeTruthy();
  });

  it("stop an order in the cart, saying so at the top with Remove, and Place order is off until it's gone", async () => {
    const { cart } = await import("./cart");
    cart.add(BUCKET.name);
    cart.add(S3.name);
    await renderAt("/catalog/cart", MEMBER, {
      "AuthService/GetEnvironment": GCP,
      "TemplateService/ListTemplates": { runnables: [BUCKET, S3] },
      "OrderService/PreviewOrder": (request: Record<string, unknown>) => ({
        steps: (request["actions"] as string[]).map((product) => ({ id: product, product, inputs: {} })),
      }),
    });
    const alert = await screen.findByText("S3 bucket is for aws installs, so this order can't run here.");
    expect(alert.closest("[role=alert]")?.textContent).toContain("gke-prod is on gcp. Remove it to order the rest.");
    expect(screen.getByText("1 step for aws installs: can't run on gke-prod")).toBeTruthy();
    const place = screen.getByRole("button", { name: "Place order" }) as HTMLButtonElement;
    expect(place.disabled).toBe(true);
    expect(screen.getByText("Remove S3 bucket first: it's for aws installs, and gke-prod is on gcp.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove S3 bucket" }));
    await waitFor(() => { expect((screen.getByRole("button", { name: "Place order" }) as HTMLButtonElement).disabled).toBe(false); });
    expect(screen.queryByText(/so this order can't run here/)).toBeNull();
    cart.clear();
  });

  it("refuse a template with a step for them when it's run: what it means, what to do, and that nothing ran", async () => {
    await renderAt("/catalog/run?template=payments%2Forders-exports", MEMBER, {
      "AuthService/GetEnvironment": GCP,
      "TemplateService/ListTemplates": {
        runnables: [
          { kind: "KIND_TEMPLATE", team: "payments", name: "orders-exports", displayName: "Orders exports", shared: true, runsHere: true, actions: ["data-platform/object-bucket.create", "aws-platform/s3-bucket.create"] },
          S3,
        ],
      },
      "TemplateService/RunTemplate": () =>
        refused(400, "failed_precondition", "aws-platform-s3-bucket-create is for aws installs; this install is on gcp.", "NOT_FOR_THIS_INSTALL", { product: "aws-platform-s3-bucket-create" }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Run" }));
    expect(await screen.findByRole("heading", { name: "Not run: S3 bucket is for aws installs" })).toBeTruthy();
    expect(screen.getByText("NOT_FOR_THIS_INSTALL · nothing ran")).toBeTruthy();
    expect(screen.getByText("aws-platform-s3-bucket-create is for aws installs; this install is on gcp.")).toBeTruthy();
    expect(screen.getByText(/aws-platform says S3 bucket is for aws installs, and gke-prod is on gcp\. The run was refused before any step started\./)).toBeTruthy();
    expect(screen.getByText("Run it on an aws install, or ask payments to leave S3 bucket out of this template on gcp installs.")).toBeTruthy();
    expect(screen.getByText("Nothing was made. It's refused the same way until the template changes.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ask payments" }).getAttribute("href")).toBe("/teams/payments");
    expect(screen.getByText("Refused: not for this install")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("are why the Admin page's Console card names the install's cloud, and it's left out when not known", async () => {
    const install = { "AdminService/GetInstall": { version: "0.4.0", environmentLabel: "Kubernetes on GKE, us-central1", scanning: true, runRetentionDays: 90 } };
    await renderAt("/admin", ADMIN, { "AuthService/GetEnvironment": GCP, ...install });
    expect(await screen.findByText("Cloud: gcp (set by vennir)")).toBeTruthy();
    cleanup();
    await renderAt("/admin", ADMIN, install);
    expect(await screen.findByText("0.4.0")).toBeTruthy();
    expect(screen.queryByText(/^Cloud:/)).toBeNull();
  });
});
