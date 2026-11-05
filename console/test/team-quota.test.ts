// SPDX-License-Identifier: MIT
/**
 * Teams' resource limits (teamQuota.ts): a new team's namespace gets the
 * install's; an admin sets a team's own (written at once) or goes back to
 * the install's; nobody else can, and a value that isn't a quantity is
 * refused; the policy resync writes every team's. The cluster's side
 * (k8s.ts) is stubbed.
 */
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam } from "../src/db/queries.js";
import { teams } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { writeTeamQuota } from "../src/k8s.js";
import { syncTeamQuotas } from "../src/teamQuota.js";
import { caller, rpcClient } from "./rpc.js";

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  setTeamNamespace: vi.fn(() => Promise.resolve(true)),
  setApiNamespace: vi.fn(() => Promise.resolve(true)),
  writeTeamPullSecret: vi.fn(() => Promise.resolve(true)),
  writeTeamNetworkPolicy: vi.fn(() => Promise.resolve(true)),
  writeTeamQuota: vi.fn(() => Promise.resolve(true)),
}));

const prefix = `quo-${randomUUID().slice(0, 6)}`;
const INSTALL = { cpu: "4", memory: "8Gi", pods: "20", stepMemory: "2Gi" };
const original = { ...config.teamNamespaces };
let app: FastifyInstance;
const people = rpcClient(() => app);
const call = caller(() => app);
let admin: string;
let maintainer: string;

interface TeamBody {
  team?: { quota?: Record<string, string>; quotaIsDefault?: boolean; installQuota?: Record<string, string> };
}

beforeAll(async () => {
  Object.assign(config.teamNamespaces, { manage: true, quota: INSTALL });
  app = await buildApp();
  await app.ready();
  const own = await createTeam(`${prefix}-own`);
  const a = await people.makeUser({ admin: true });
  const m = await people.makeUser();
  await addTeamMember(m.id, own.id, "maintainer");
  [admin, maintainer] = await Promise.all([a, m].map((u) => people.signIn(u.email)));
});

beforeEach(() => {
  vi.mocked(writeTeamQuota).mockClear();
});

afterAll(async () => {
  Object.assign(config.teamNamespaces, original);
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await people.cleanUp();
  await app.close();
});

describe("a team's resource limits", () => {
  it("are the install's for a new team", async () => {
    expect((await call(admin, "TeamService/CreateTeam", { name: `${prefix}-new` })).code).toBe("ok");
    expect(writeTeamQuota).toHaveBeenCalledWith(`${prefix}-new`, INSTALL);
    const got = await call<TeamBody>(admin, "TeamService/GetTeam", { name: `${prefix}-new` });
    expect(got.body.team).toMatchObject({ quota: INSTALL, quotaIsDefault: true });
  });

  it("are set by an admin, written at once, and go back to the install's", async () => {
    const own = { cpu: "16", memory: "", pods: "50", stepMemory: "8Gi" };
    const set = await call<TeamBody>(admin, "TeamService/SetTeamQuota", { team: `${prefix}-own`, quota: own });
    expect(set.code).toBe("ok");
    expect(set.body.team).toMatchObject({ quotaIsDefault: false, quota: { cpu: "16", pods: "50", stepMemory: "8Gi" } });
    expect(writeTeamQuota).toHaveBeenLastCalledWith(`${prefix}-own`, own);
    // The install's beside the team's own, for its members to compare.
    const seen = await call<TeamBody>(maintainer, "TeamService/GetTeam", { name: `${prefix}-own` });
    expect(seen.body.team).toMatchObject({ quotaIsDefault: false, quota: { cpu: "16" }, installQuota: INSTALL });

    const back = await call<TeamBody>(admin, "TeamService/SetTeamQuota", { team: `${prefix}-own`, useDefault: true });
    expect(back.body.team).toMatchObject({ quota: INSTALL, quotaIsDefault: true });
    expect(writeTeamQuota).toHaveBeenLastCalledWith(`${prefix}-own`, INSTALL);
  });

  it("aren't anyone else's to set, and must be quantities", async () => {
    expect((await call(maintainer, "TeamService/SetTeamQuota", { team: `${prefix}-own`, quota: { cpu: "64" } })).code).toBe("permission_denied");
    expect((await call(admin, "TeamService/SetTeamQuota", { team: `${prefix}-own`, quota: { memory: "lots" } })).failure).toBe("BAD_QUOTA");
    expect((await call(admin, "TeamService/SetTeamQuota", { team: `${prefix}-own`, quota: { pods: "2.5" } })).failure).toBe("BAD_QUOTA");
    expect(writeTeamQuota).not.toHaveBeenCalled();
  });

  it("are written into every team's namespace by the policy resync", async () => {
    await syncTeamQuotas();
    const written = vi.mocked(writeTeamQuota).mock.calls.map(([team]) => team);
    expect(written).toEqual(expect.arrayContaining([`${prefix}-own`, `${prefix}-new`]));
  });
});
