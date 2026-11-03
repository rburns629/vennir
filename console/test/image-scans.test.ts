// SPDX-License-Identifier: MIT
/**
 * Scanning every image before it's registered or run (scanning.ts): reading
 * Trivy's output, verdicts per digest, what a failed one blocks, and an
 * admin accepting one. Kubernetes is faked: a scan "Job" finishes with
 * whatever output the test sets; what the real Job and Trivy server do is
 * proven on kind.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { createUser, setUserAdmin } from "../src/db/queries.js";
import { imageScans, products, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller } from "./rpc.js";

const call = caller(() => app);
import { createScanJob, readScanJob, scaleScanner, updateScanPolicy } from "../src/k8s.js";
import { combineScanOutputs, parseScanOutput, reconcileScans, requestScan, RETRY_ERRORED_MINUTES, scanBlocker, scanTarget, syncScanPolicy, verdictOf } from "../src/scanning.js";

/** What each scan Job (by target) prints when it finishes. */
const outputs = new Map<string, string>();
const jobs = new Map<string, string>(); // job name -> target
let policyWritten: string | undefined;
/** The Trivy server's Deployment, for the idling tests. */
const scanner = { replicas: 1, ready: 1 };

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  createScanJob: vi.fn((spec: { name: string; target: string }) => {
    jobs.set(spec.name, spec.target);
    return Promise.resolve();
  }),
  readScanJob: vi.fn((_namespace: string, name: string) => {
    const output = outputs.get(jobs.get(name) ?? "");
    return Promise.resolve(output === undefined ? { state: "running" } : { state: "succeeded", output });
  }),
  deleteScanJob: vi.fn(() => Promise.resolve()),
  readScanner: vi.fn(() => Promise.resolve({ ...scanner })),
  scaleScanner: vi.fn((_namespace: string, _name: string, replicas: number) => {
    scanner.replicas = replicas;
    if (replicas === 0) scanner.ready = 0;
    return Promise.resolve();
  }),
  updateScanPolicy: vi.fn(async (_name: string, build: () => Promise<string>) => {
    policyWritten = await build();
    return true;
  }),
}));

const prefix = `scan-${randomUUID().slice(0, 6)}`;
const emails: string[] = [];
let app: FastifyInstance;
let admin: string;
const original = { ...config.scanning };

const CLEAN = "V|HIGH||CVE-2026-0001|libfoo|1.0\nEND\n";
const VULNERABLE = "V|CRITICAL|1.2.3|CVE-2026-0002|openssl|1.2.0\nV|HIGH||CVE-2026-0003|zlib|1.0\nEND\n";
const LEAKY = "S|CRITICAL|private-key|Asymmetric Private Key\nEND\n";

/** A fresh pinned image, so scans never collide across tests. */
function image(): string {
  const hex = randomUUID().replace(/-/g, "");
  return `registry.example/${prefix}/app:latest@sha256:${(hex + hex).slice(0, 64)}`;
}

beforeAll(async () => {
  Object.assign(config.scanning, { enabled: true, waitSeconds: 0, policyName: "kernel-execution-kernel-scan", image: "trivy", serverUrl: "http://trivy:4954" });
  app = await buildApp();
  await app.ready();
  const email = `${prefix}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  await setUserAdmin(user.id, true);
  admin = app.jwt.sign({ userId: user.id });
});

afterAll(async () => {
  Object.assign(config.scanning, original);
  await db.delete(imageScans).where(like(imageScans.image, `%${prefix}%`));
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(users).where(inArray(users.email, emails));
  await app.close();
});

beforeEach(() => {
  vi.mocked(createScanJob).mockClear();
  vi.mocked(readScanJob).mockClear();
  vi.mocked(updateScanPolicy).mockClear();
  policyWritten = undefined;
});

/** Starts the image's scan, lets its Job finish with `output`, and records it. */
async function scanned(img: string, output: string): Promise<void> {
  outputs.set(scanTarget(img).target, output);
  await scanBlocker([img]);
  await reconcileScans();
}

describe("reading a scan", () => {
  it("blocks on a fixable HIGH/CRITICAL or a secret, and only reports the unfixable", () => {
    const clean = parseScanOutput(CLEAN);
    expect(clean).toMatchObject({ fixable: 0, unfixable: 1, secrets: 0 });
    expect(clean && verdictOf(clean)).toBe("passed");
    const vulnerable = parseScanOutput(VULNERABLE);
    expect(vulnerable).toMatchObject({ fixable: 1, unfixable: 1 });
    expect(vulnerable?.findings[0]).toMatchObject({ id: "CVE-2026-0002", fixedIn: "1.2.3" });
    expect(vulnerable && verdictOf(vulnerable)).toBe("failed");
    const leaky = parseScanOutput(LEAKY);
    expect(leaky && verdictOf(leaky)).toBe("failed");
  });

  it("never reads a cut-off output as clean", () => {
    expect(parseScanOutput("V|CRITICAL|1.2.3|CVE-1|x|1\n")).toBeNull();
    expect(parseScanOutput("")).toBeNull();
  });

  it("fails a multi-platform image if any platform's image does, counting what they share once", () => {
    const amd64 = "V|HIGH||CVE-2026-0001|libfoo|1.0\nEND\n";
    const arm64 = "V|HIGH||CVE-2026-0001|libfoo|1.0\nS|CRITICAL|private-key|Asymmetric Private Key\nEND\n";
    const both = combineScanOutputs([amd64, arm64]);
    expect(both).toMatchObject({ findings: { unfixable: 1, secrets: 1 } });
    expect("findings" in both && verdictOf(both.findings)).toBe("failed");
  });

  it("skips a platform the image has no image for, but not every one, nor an incomplete scan", () => {
    const absent = "FATAL\tremote error: no child with platform linux/arm64 in index registry.example/app";
    expect(combineScanOutputs([CLEAN, absent])).toMatchObject({ findings: { fixable: 0, unfixable: 1 } });
    expect(combineScanOutputs([absent])).toHaveProperty("error");
    expect(combineScanOutputs([CLEAN, "dial tcp 10.0.0.9:5000: i/o timeout"])).toEqual({ error: "dial tcp 10.0.0.9:5000: i/o timeout" });
  });

  it("scans through a registry's mirror", () => {
    config.registryMirrors.set("localhost:5001", "http://kind-registry:5000");
    try {
      expect(scanTarget(`localhost:5001/team/app:latest@sha256:${"a".repeat(64)}`)).toEqual({
        target: `kind-registry:5000/team/app:latest@sha256:${"a".repeat(64)}`,
        insecure: true,
      });
    } finally {
      config.registryMirrors.clear();
    }
  });
});

describe("what a verdict allows", () => {
  it("asks the caller to wait while a first scan runs, then lets a clean image run", async () => {
    const img = image();
    expect((await scanBlocker([img]))?.error).toBe("IMAGE_SCAN_PENDING");
    expect(createScanJob).toHaveBeenCalledOnce();
    outputs.set(scanTarget(img).target, CLEAN);
    await reconcileScans();
    expect(await scanBlocker([img])).toBeNull();
    expect(createScanJob).toHaveBeenCalledOnce(); // no second scan while the verdict is fresh
  });

  it("blocks a failed image, and tells the cluster", async () => {
    const img = image();
    await scanned(img, VULNERABLE);
    const blocker = await scanBlocker([img]);
    expect(blocker?.error).toBe("IMAGE_SCAN_FAILED");
    expect(blocker?.images[0]?.findings?.fixable).toBe(1);
    expect(JSON.parse(policyWritten ?? "[]")).toContain(img.split("@")[1]);
  });

  it("refuses to register a failed image", async () => {
    const img = image();
    await scanned(img, LEAKY);
    const registered = await call(admin, "ProductService/RegisterProduct", { name: `${prefix}-leaky`, image: img, action: "run" });
    expect(registered.code).toBe("invalid_argument");
    expect(registered.failure).toBe("IMAGE_SCAN_FAILED");
  });

  it("lets an admin accept a failed image with a reason, and only an admin", async () => {
    const img = image();
    const digest = img.split("@")[1] ?? "";
    await scanned(img, VULNERABLE);
    const member = (await createUser(`${prefix}-m@example.com`, await hashPassword("correct-horse-battery"))).id;
    emails.push(`${prefix}-m@example.com`);
    const accept = (token: string, reason: string) => call(token, "ImageService/AcceptImageScan", { digest, reason });
    expect((await accept(app.jwt.sign({ userId: member }), "No fix applies to how we use it.")).code).toBe("permission_denied");
    expect((await accept(admin, "ok")).code).toBe("invalid_argument"); // a real reason
    expect((await accept(admin, "Not reachable: the binary never parses untrusted input.")).code).toBe("ok");
    expect(await scanBlocker([img])).toBeNull();
    expect(JSON.parse(policyWritten ?? "[]")).not.toContain(digest);
  });

  it("waits before trying again a rescan that couldn't scan, keeping the last verdict meanwhile", async () => {
    const img = image();
    const { target } = scanTarget(img);
    const digest = img.split("@")[1] ?? "";
    await scanned(img, CLEAN);
    const startsOfThis = () => vi.mocked(createScanJob).mock.calls.filter(([spec]) => spec.target === target).length;
    const longAgo = new Date(Date.now() - 48 * 3_600_000);
    await db.update(imageScans).set({ scannedAt: longAgo, requestedAt: longAgo }).where(eq(imageScans.digest, digest));
    vi.mocked(createScanJob).mockClear();

    await reconcileScans(); // due: started
    expect(startsOfThis()).toBe(1);
    // The registry can't be reached: every attempt fails.
    vi.mocked(readScanJob).mockImplementation(() => Promise.resolve({ state: "failed", output: "dial tcp 10.0.0.9:5000: i/o timeout" }));
    try {
      await reconcileScans();
      await reconcileScans();
      expect(startsOfThis()).toBe(1);
      const [row] = await db.select().from(imageScans).where(eq(imageScans.digest, digest));
      expect(row?.status).toBe("passed");

      await db.update(imageScans).set({ requestedAt: new Date(Date.now() - (RETRY_ERRORED_MINUTES + 1) * 60_000) }).where(eq(imageScans.digest, digest));
      await reconcileScans();
      expect(startsOfThis()).toBe(2);
    } finally {
      vi.mocked(readScanJob).mockImplementation((_namespace: string, name: string) => {
        const output = outputs.get(jobs.get(name) ?? "");
        return Promise.resolve(output === undefined ? { state: "running" } : { state: "succeeded", output });
      });
    }
  });

  it("forgets an image the registry no longer has, rather than trying it again", async () => {
    const img = image();
    const digest = img.split("@")[1] ?? "";
    await scanned(img, CLEAN);
    const longAgo = new Date(Date.now() - 48 * 3_600_000);
    await db.update(imageScans).set({ scannedAt: longAgo, requestedAt: longAgo }).where(eq(imageScans.digest, digest));
    await reconcileScans(); // due: started
    vi.mocked(readScanJob).mockImplementation(() =>
      Promise.resolve({ state: "failed", output: `remote error: GET https://registry.example/v2/app/manifests/${digest}: MANIFEST_UNKNOWN: manifest unknown` }),
    );
    try {
      await reconcileScans();
      expect(await db.select().from(imageScans).where(eq(imageScans.digest, digest))).toEqual([]);
    } finally {
      vi.mocked(readScanJob).mockImplementation((_namespace: string, name: string) => {
        const output = outputs.get(jobs.get(name) ?? "");
        return Promise.resolve(output === undefined ? { state: "running" } : { state: "succeeded", output });
      });
    }
  });

  it("keeps a failed verdict when the registry no longer has the image, so the cluster still refuses it", async () => {
    const img = image();
    const digest = img.split("@")[1] ?? "";
    await scanned(img, VULNERABLE);
    const longAgo = new Date(Date.now() - 48 * 3_600_000);
    await db.update(imageScans).set({ scannedAt: longAgo, requestedAt: longAgo }).where(eq(imageScans.digest, digest));
    await reconcileScans(); // due: started
    vi.mocked(readScanJob).mockImplementation(() =>
      Promise.resolve({ state: "failed", output: `remote error: GET https://registry.example/v2/app/manifests/${digest}: MANIFEST_UNKNOWN: manifest unknown` }),
    );
    try {
      await reconcileScans();
      const [row] = await db.select().from(imageScans).where(eq(imageScans.digest, digest));
      expect(row).toMatchObject({ status: "failed", jobName: null });
      expect((row?.findings as { fixable?: number } | null)?.fixable).toBe(1);
      await syncScanPolicy();
      expect(JSON.parse(policyWritten ?? "[]")).toContain(digest);
    } finally {
      vi.mocked(readScanJob).mockImplementation((_namespace: string, name: string) => {
        const output = outputs.get(jobs.get(name) ?? "");
        return Promise.resolve(output === undefined ? { state: "running" } : { state: "succeeded", output });
      });
    }
  });

  it("never lets a reconcile holding a finished scan overwrite the next one", async () => {
    const img = image();
    const { target } = scanTarget(img);
    const digest = img.split("@")[1] ?? "";
    expect((await scanBlocker([img]))?.error).toBe("IMAGE_SCAN_PENDING");
    const first = vi.mocked(createScanJob).mock.calls.find(([spec]) => spec.target === target)?.[0].name ?? "";
    outputs.set(target, CLEAN);
    // A reconcile that read the first Job's row, and is slow to hear back
    // from the cluster: by then the Job is gone.
    let answer: (state: { state: "missing" }) => void = () => {};
    const slow = new Promise<{ state: "missing" }>((resolve) => (answer = resolve));
    let held = false;
    vi.mocked(readScanJob).mockImplementation((_namespace: string, name: string) => {
      if (name === first && !held) {
        held = true;
        return slow;
      }
      const output = outputs.get(jobs.get(name) ?? "");
      return Promise.resolve(output === undefined ? { state: "running" } : { state: "succeeded", output });
    });
    try {
      const stale = reconcileScans();
      await vi.waitFor(() => expect(held).toBe(true));
      await reconcileScans(); // records the first scan
      await requestScan(img, { force: true }); // and a rescan starts
      const [rescanning] = await db.select().from(imageScans).where(eq(imageScans.digest, digest));
      expect(rescanning?.jobName).not.toBeNull();
      expect(rescanning?.jobName).not.toBe(first);
      outputs.delete(target); // the rescan is still running
      answer({ state: "missing" });
      await stale;
      const [row] = await db.select().from(imageScans).where(eq(imageScans.digest, digest));
      expect(row).toMatchObject({ status: "passed", jobName: rescanning?.jobName });
    } finally {
      vi.mocked(readScanJob).mockImplementation((_namespace: string, name: string) => {
        const output = outputs.get(jobs.get(name) ?? "");
        return Promise.resolve(output === undefined ? { state: "running" } : { state: "succeeded", output });
      });
    }
  });

  it("scans every platform, and records the verdict of a Job whose other platform the image hasn't", async () => {
    const img = image();
    const digest = img.split("@")[1] ?? "";
    const platforms = config.scanning.platforms;
    config.scanning.platforms = ["linux/amd64", "linux/arm64", "linux/s390x"];
    try {
      expect((await scanBlocker([img]))?.error).toBe("IMAGE_SCAN_PENDING");
      expect(vi.mocked(createScanJob).mock.calls.at(-1)?.[0].platforms).toEqual(["linux/amd64", "linux/arm64", "linux/s390x"]);
      vi.mocked(readScanJob).mockImplementation(() =>
        Promise.resolve({ state: "failed", output: CLEAN, outputs: [CLEAN, LEAKY, "no child with platform linux/s390x in index"] }),
      );
      await reconcileScans();
      const [row] = await db.select().from(imageScans).where(eq(imageScans.digest, digest));
      expect(row?.status).toBe("failed");
      expect((row?.findings as { secrets?: number } | null)?.secrets).toBe(1);
    } finally {
      config.scanning.platforms = platforms;
      vi.mocked(readScanJob).mockImplementation((_namespace: string, name: string) => {
        const output = outputs.get(jobs.get(name) ?? "");
        return Promise.resolve(output === undefined ? { state: "running" } : { state: "succeeded", output });
      });
    }
  });

  it("asks for the scan's output to be waited for, and says when it couldn't be read", async () => {
    const img = image();
    const digest = img.split("@")[1] ?? "";
    expect((await scanBlocker([img]))?.error).toBe("IMAGE_SCAN_PENDING");
    vi.mocked(readScanJob).mockClear();
    vi.mocked(readScanJob).mockImplementation(() => Promise.resolve({ state: "succeeded", output: "", unread: "scan-x-abcde: Running" }));
    try {
      await reconcileScans();
      // Scans expect output (a log readable a little after the Job says it's done).
      expect(vi.mocked(readScanJob).mock.calls.some((c) => c[3] === true)).toBe(true);
      const [row] = await db.select().from(imageScans).where(eq(imageScans.digest, digest));
      expect(row?.status).toBe("error");
      expect((row?.findings as { error?: string } | null)?.error).toContain("couldn't be read (scan-x-abcde: Running)");
    } finally {
      vi.mocked(readScanJob).mockImplementation((_namespace: string, name: string) => {
        const output = outputs.get(jobs.get(name) ?? "");
        return Promise.resolve(output === undefined ? { state: "running" } : { state: "succeeded", output });
      });
    }
  });

  it("rescans an image now, its time unset until the new scan finishes", async () => {
    const img = image();
    const digest = img.split("@")[1] ?? "";
    await scanned(img, CLEAN);
    const again = await call<{ scan?: { scannedAt?: string } }>(admin, "ImageService/RescanImage", { digest });
    expect(again.code).toBe("ok");
    const listed = await call<{ scans?: { digest: string; scannedAt?: string }[] }>(admin, "ImageService/ListImageScans");
    expect(listed.body.scans?.find((x) => x.digest === digest)?.scannedAt).toBeUndefined();
  });
});

describe("an idle scanner", () => {
  beforeEach(() => {
    config.scanning.scannerDeployment = "console-execution-console-trivy";
    vi.mocked(scaleScanner).mockClear();
  });
  afterEach(() => {
    config.scanning.scannerDeployment = "";
    config.scanning.idleMinutes = original.idleMinutes;
  });

  it("is woken for a first scan, which starts once it's ready", async () => {
    Object.assign(scanner, { replicas: 0, ready: 0 });
    const img = image();
    expect((await scanBlocker([img]))?.error).toBe("IMAGE_SCAN_PENDING");
    expect(scaleScanner).toHaveBeenCalledWith(expect.any(String), "console-execution-console-trivy", 1);
    expect(createScanJob).not.toHaveBeenCalled();

    scanner.ready = 1;
    outputs.set(scanTarget(img).target, CLEAN);
    await reconcileScans(); // the pending scan is due: started
    expect(createScanJob).toHaveBeenCalledOnce();
    await reconcileScans(); // and read
    expect(await scanBlocker([img])).toBeNull();
  });

  it("stays up while scans are recent, and idles once none have been", async () => {
    Object.assign(scanner, { replicas: 1, ready: 1 });
    await scanned(image(), CLEAN);
    await reconcileScans();
    expect(scaleScanner).not.toHaveBeenCalledWith(expect.any(String), expect.any(String), 0);

    config.scanning.idleMinutes = 0.005; // 300 ms
    // Any scan counts, so another test file's (retention, observe) written
    // meanwhile keeps it up a moment longer, as it should: checked again
    // until every scan is older than that.
    for (let tries = 0; tries < 20; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await reconcileScans();
      if (vi.mocked(scaleScanner).mock.calls.some((call) => call[2] === 0)) break;
    }
    expect(scaleScanner).toHaveBeenCalledWith(expect.any(String), "console-execution-console-trivy", 0);
    expect(scanner.replicas).toBe(0);
  });
});
