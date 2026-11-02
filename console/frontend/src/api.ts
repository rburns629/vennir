// SPDX-License-Identifier: MIT
/**
 * The console API for the pages: plain objects over the generated Connect
 * clients (./gen, from proto/vertra/console/v1). Pages use these
 * functions and types, never the messages, so the wire contract can change
 * without touching them.
 *
 * In dev, requests go through Vite's proxy (vite.config.ts) so they're
 * same-origin as far as the browser is concerned; in production the built
 * assets are served by the same Fastify process as the API (see
 * ../../src/index.ts), so they're genuinely same-origin. Either way this
 * client never needs to know the API's origin.
 */
import { createClient, Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { fromJson, type JsonObject, type JsonValue } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { AdminService } from "./gen/vertra/console/v1/admin_pb.js";
import { AuthService } from "./gen/vertra/console/v1/auth_pb.js";
import { ApiService, ApiState } from "./gen/vertra/console/v1/api_pb.js";
import { ObserveService } from "./gen/vertra/console/v1/observe_pb.js";
import {
  DagSchema,
  ExecutionService,
  ExecutionState,
  TaskState,
  type Dag,
  type Execution,
} from "./gen/vertra/console/v1/execution_pb.js";
import { GuideService } from "./gen/vertra/console/v1/guide_pb.js";
import { ImageService, ScanStatus, type ImagePolicy as ImagePolicyMessage, type ImageScan as ImageScanMessage } from "./gen/vertra/console/v1/image_pb.js";
import { ProductService } from "./gen/vertra/console/v1/product_pb.js";
import { SecretService, SecretSource } from "./gen/vertra/console/v1/secret_pb.js";
import { TaskPodState, TeamRole, TeamService, type Team as TeamMessage } from "./gen/vertra/console/v1/team_pb.js";
import { TokenService } from "./gen/vertra/console/v1/token_pb.js";
import { UserService } from "./gen/vertra/console/v1/user_pb.js";
import { FailureSchema, ProblemSchema } from "./gen/vertra/console/v1/common_pb.js";
import { Runnable_Kind, TemplateService } from "./gen/vertra/console/v1/template_pb.js";
import { ResourceService } from "./gen/vertra/console/v1/resource_pb.js";
import { NotificationService } from "./gen/vertra/console/v1/notification_pb.js";
import { ScheduleService } from "./gen/vertra/console/v1/schedule_pb.js";
import { DraftService, type Draft as DraftMessage } from "./gen/vertra/console/v1/draft_pb.js";
import { OrderService } from "./gen/vertra/console/v1/order_pb.js";
import { ChatService, type AskResponse, type ChatConfig as ChatConfigMessage } from "./gen/vertra/console/v1/chat_pb.js";
import type { BuiltStep } from "./compose";
import { SsoService, type SsoSettings as SsoSettingsMessage } from "./gen/vertra/console/v1/sso_pb.js";

/** A refusal or failure, with the HTTP status REST would have used. */
export class ApiError extends Error {
  readonly status: number;
  /** The server's stable code (INVALID_PARAMETERS, TEAM_RETIRED, ...), when it sent one. */
  readonly code: string | undefined;
  /** More about it (the Failure detail). */
  readonly detail: Record<string, unknown> | undefined;
  /** Each thing wrong with the request (Problem details), on its field when it's about one. */
  readonly problems: { field: string; message: string }[];

  constructor(
    status: number,
    message: string,
    code?: string,
    detail?: Record<string, unknown>,
    problems: { field: string; message: string }[] = [],
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.problems = problems;
  }
}

/** Dispatched on `window` when an authenticated request comes back unauthenticated. */
export const SESSION_EXPIRED_EVENT = "auth:session-expired";

const HTTP_STATUS: Partial<Record<Code, number>> = {
  [Code.Canceled]: 499,
  [Code.InvalidArgument]: 400,
  [Code.DeadlineExceeded]: 504,
  [Code.NotFound]: 404,
  [Code.AlreadyExists]: 409,
  [Code.PermissionDenied]: 403,
  [Code.ResourceExhausted]: 429,
  [Code.FailedPrecondition]: 409,
  [Code.Aborted]: 409,
  [Code.OutOfRange]: 400,
  [Code.Unimplemented]: 501,
  [Code.Unavailable]: 503,
  [Code.Unauthenticated]: 401,
};

/**
 * Sends the session token. An unauthenticated answer to a request that
 * *carried* one means the session is over (expired, or revoked by a
 * password change): AuthContext signs the user out instead of every page
 * showing its own error. Without a token (a failed login) it's just that.
 */
const session: Interceptor = (next) => async (req) => {
  const token = localStorage.getItem("token");
  if (token) req.header.set("Authorization", `Bearer ${token}`);
  try {
    return await next(req);
  } catch (error) {
    if (token && ConnectError.from(error).code === Code.Unauthenticated) {
      localStorage.removeItem("token");
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
    throw error;
  }
};

// Every API route lives under /api (see ../../src/index.ts), so it can never
// collide with a same-named React Router page on a hard refresh.
const transport = createConnectTransport({ baseUrl: "/api", interceptors: [session] });
const auth = createClient(AuthService, transport);
const chatApi = createClient(ChatService, transport);
const apisApi = createClient(ApiService, transport);
const observe = createClient(ObserveService, transport);
const admin = createClient(AdminService, transport);
const executions = createClient(ExecutionService, transport);
const guides = createClient(GuideService, transport);
const images = createClient(ImageService, transport);
const productsApi = createClient(ProductService, transport);
const secrets = createClient(SecretService, transport);
const teams = createClient(TeamService, transport);
const tokens = createClient(TokenService, transport);
const users = createClient(UserService, transport);
const templates = createClient(TemplateService, transport);
const resourcesApi = createClient(ResourceService, transport);
const notificationsApi = createClient(NotificationService, transport);
const schedulesApi = createClient(ScheduleService, transport);
const draftsApi = createClient(DraftService, transport);
const ordersApi = createClient(OrderService, transport);
const ssoApi = createClient(SsoService, transport);

function apiError(error: unknown): ApiError {
  const connect = ConnectError.from(error);
  const [failure] = connect.findDetails(FailureSchema);
  const problems = connect.findDetails(ProblemSchema).map((p) => ({ field: p.field, message: p.message }));
  return new ApiError(HTTP_STATUS[connect.code] ?? 500, connect.rawMessage, failure?.code, failure?.detail, problems);
}

/** Runs a call, turning a Connect error into an ApiError with its message alone. */
async function call<T>(rpc: () => Promise<T>): Promise<T> {
  try {
    return await rpc();
  } catch (error) {
    throw apiError(error);
  }
}

const iso = (timestamp: Timestamp | undefined): string | null =>
  timestamp ? timestampDate(timestamp).toISOString() : null;

export interface Environment {
  label: string;
  /** Whether /auth/register is open; otherwise admins create accounts. */
  selfRegistration: boolean;
  /** Single sign-on's provider ("Google") when it's on. Passwords still work, except for teams that require it. */
  ssoLabel: string;
  /** The cloud this install is on (gcp, aws, azure, kind, existing), as vertra set it; empty when it isn't known. */
  cloud: string;
}

/** Unauthenticated -- see ../../src/index.ts's /environment route. */
export async function getEnvironment(): Promise<Environment> {
  const environment = await call(() => auth.getEnvironment({}));
  return { label: environment.label, selfRegistration: environment.selfRegistration, ssoLabel: environment.ssoLabel, cloud: environment.cloud };
}

/** Where a browser goes to sign in with single sign-on (../../src/auth/oidc.ts). */
export const SSO_START = "/api/auth/oidc/start";

export interface Me {
  id: string;
  email: string;
  teamNames: string[];
  /** The teams in teamNames this person maintains (manages). */
  maintainerOf: string[];
  isAdmin: boolean;
  /** Signed in with a password someone else set: nothing works until it's changed. */
  mustChangePassword: boolean;
  /** How they sign in: a password of their own, single sign-on, or both. */
  hasPassword: boolean;
  usesSso: boolean;
}

export interface Team {
  id: string;
  name: string;
  createdAt: string;
  /** Set while the team is retired: read-only, its platform being wound
   * down (see ../../src/db/schema.ts). */
  retiredAt: string | null;
  /** Who retired it: an email, or "the catalog"; "" when not known. */
  retiredBy: string;
  /** Set once the team has been purged; its name stays reserved. */
  deletedAt: string | null;
  /** Its members sign in with single sign-on only, while it's on. */
  requireSso: boolean;
  /** Made by the catalog; else made here, and left alone by it until adopted. */
  fromCatalog: boolean;
  /** What its steps may use together: its own, else the install's. */
  quota: TeamQuota;
  /** True when the quota is the install's, not one an admin set for it. */
  quotaIsDefault: boolean;
  /** The install's limits, which a team without its own has. */
  installQuota: TeamQuota;
}

/** A team's resource limits, as Kubernetes quantities; "" for no limit. */
export interface TeamQuota {
  cpu: string;
  memory: string;
  pods: string;
  stepMemory: string;
}

export async function register(email: string, password: string): Promise<{ id: string; email: string }> {
  const created = await call(() => auth.register({ email, password }));
  return { id: created.userId, email: created.email };
}

export async function login(email: string, password: string): Promise<string> {
  return (await call(() => auth.login({ email, password }))).token;
}

/** Ends this session on the server too, so a copy of its token stops working. */
export async function signOut(): Promise<void> {
  await call(() => auth.signOut({}));
}

export async function getMe(): Promise<Me> {
  const me = await call(() => auth.getMe({}));
  return {
    id: me.userId,
    email: me.email,
    teamNames: me.teamNames,
    maintainerOf: me.maintainerOf,
    isAdmin: me.isAdmin,
    mustChangePassword: me.mustChangePassword,
    hasPassword: me.hasPassword,
    usesSso: me.usesSso,
  };
}

export async function createTeam(name: string): Promise<Team> {
  return team((await call(() => teams.createTeam({ name }))).team);
}

function team(message: TeamMessage | undefined): Team {
  return {
    id: message?.id ?? "",
    name: message?.name ?? "",
    createdAt: iso(message?.createdAt) ?? "",
    retiredAt: iso(message?.retiredAt),
    retiredBy: message?.retiredBy ?? "",
    deletedAt: iso(message?.deletedAt),
    requireSso: message?.requireSso ?? false,
    fromCatalog: message?.fromCatalog ?? false,
    quota: { cpu: message?.quota?.cpu ?? "", memory: message?.quota?.memory ?? "", pods: message?.quota?.pods ?? "", stepMemory: message?.quota?.stepMemory ?? "" },
    quotaIsDefault: message?.quotaIsDefault ?? true,
    installQuota: {
      cpu: message?.installQuota?.cpu ?? "",
      memory: message?.installQuota?.memory ?? "",
      pods: message?.installQuota?.pods ?? "",
      stepMemory: message?.installQuota?.stepMemory ?? "",
    },
  };
}

/** Admins: a team's own resource limits, or (null) the install's again. */
export async function setTeamQuota(teamName: string, quota: TeamQuota | null): Promise<Team> {
  return team((await call(() => teams.setTeamQuota({ team: teamName, quota: quota ?? undefined, useDefault: quota === null }))).team);
}

/** Admins: whether a team's members must sign in with single sign-on. */
export async function setTeamSignIn(teamName: string, requireSso: boolean): Promise<void> {
  await call(() => teams.setTeamSignIn({ team: teamName, requireSso }));
}

/** A maintainer manages the team (people, secrets, bots, raw DAGs); a
 * member sees its work and runs its actions. See ../../src/auth/access.ts. */
export type Role = "maintainer" | "member";

const toTeamRole = { maintainer: TeamRole.MAINTAINER, member: TeamRole.MEMBER } as const;

export async function addTeamMember(teamName: string, email: string, role: Role = "member"): Promise<void> {
  await call(() => teams.addMember({ team: teamName, email, role: toTeamRole[role] }));
}

export interface TeamMember {
  id: string;
  email: string;
  isBot: boolean;
  /** A Vertra admin (platform-wide), not just this team's member. */
  isAdmin: boolean;
  role: Role;
  addedAt: string;
  /** How they sign in: a password of their own, single sign-on, or both (a bot neither). */
  hasPassword: boolean;
  usesSso: boolean;
  /** Their membership follows their single sign-on groups: not changed here. */
  followsGroups: boolean;
  /** Which of their groups give them their role here; empty when unknown, or not by groups. */
  viaGroups: string[];
}

export async function listTeamMembers(teamName: string): Promise<TeamMember[]> {
  const { members } = await call(() => teams.listMembers({ team: teamName }));
  return members.map((m) => ({
    id: m.id,
    email: m.email,
    isBot: m.isBot,
    isAdmin: m.isAdmin,
    role: m.role === TeamRole.MAINTAINER ? "maintainer" : "member",
    addedAt: iso(m.addedAt) ?? "",
    hasPassword: m.hasPassword,
    usesSso: m.usesSso,
    followsGroups: m.followsGroups,
    viaGroups: m.viaGroups,
  }));
}

/** Refused (409) for a team's last maintainer -- see ../../src/core/teams.ts. */
export async function removeTeamMember(teamName: string, userId: string): Promise<void> {
  await call(() => teams.removeMember({ team: teamName, userId }));
}

/** Refused (409) when it would leave the team with no maintainer. */
export async function setTeamMemberRole(teamName: string, userId: string, role: Role): Promise<void> {
  await call(() => teams.setMemberRole({ team: teamName, userId, role: toTeamRole[role] }));
}

/** Admin-only -- see ../../src/core/teams.ts. A non-admin's own teams
 * come from Me.teamNames instead; this is for browsing every team. */
export async function listAllTeams(): Promise<Team[]> {
  return (await call(() => teams.listTeams({}))).teams.map(team);
}

export async function getTeam(teamName: string): Promise<Team> {
  return team((await call(() => teams.getTeam({ name: teamName }))).team);
}

/** Reversible: the team becomes read-only and its products are
 * unregistered. Admin only (a catalog release retires the teams it drops). */
export async function retireTeam(teamName: string): Promise<void> {
  await call(() => teams.retireTeam({ name: teamName }));
}

export async function unretireTeam(teamName: string): Promise<void> {
  await call(() => teams.unretireTeam({ name: teamName }));
}

/** Which images tasks may run: only those under `allowed` (the source
 * registry plus any additional sources). The cluster enforces the same
 * list; see ../../src/imagePolicy.ts. */
export interface ImagePolicy {
  /** False when the policy ConfigMap is missing (the kernel isn't installed). */
  exists: boolean;
  source: string;
  additional: string[];
  allowed: string[];
  version: string;
  /** Admins only: who last saved them, and when; "" and null when nobody has (or for anyone else). */
  lastSavedBy: string;
  lastSavedAt: string | null;
}

export async function getImagePolicy(): Promise<ImagePolicy> {
  return imagePolicy((await call(() => images.getImagePolicy({}))).policy);
}

function imagePolicy(policy: ImagePolicyMessage | undefined): ImagePolicy {
  return {
    exists: policy?.exists ?? false,
    source: policy?.source ?? "",
    additional: policy?.additional ?? [],
    allowed: policy?.allowed ?? [],
    version: policy?.version ?? "",
    lastSavedBy: policy?.lastSavedBy ?? "",
    lastSavedAt: iso(policy?.lastSavedAt),
  };
}

/** One image digest's scan: its verdict, what it found, and whether an admin accepted a failure. */
export interface ImageScan {
  digest: string;
  image: string;
  status: "pending" | "passed" | "failed" | "error";
  fixable: number;
  unfixable: number;
  secrets: number;
  /** At most 25. */
  findings: { kind: string; id: string; severity: string; package: string; installed: string; fixedIn: string; title: string }[];
  /** Why it couldn't scan. */
  error: string | null;
  requestedAt: string | null;
  scannedAt: string | null;
  lastUsedAt: string | null;
  acceptedBy: string | null;
  acceptedReason: string | null;
  acceptedAt: string | null;
}

const SCAN_STATUS: Partial<Record<ScanStatus, ImageScan["status"]>> = {
  [ScanStatus.PENDING]: "pending",
  [ScanStatus.PASSED]: "passed",
  [ScanStatus.FAILED]: "failed",
  [ScanStatus.ERROR]: "error",
};

function imageScanOf(s: ImageScanMessage | undefined): ImageScan {
  return {
    digest: s?.digest ?? "",
    image: s?.image ?? "",
    status: SCAN_STATUS[s?.status ?? ScanStatus.UNSPECIFIED] ?? "pending",
    fixable: s?.findings?.fixable ?? 0,
    unfixable: s?.findings?.unfixable ?? 0,
    secrets: s?.findings?.secrets ?? 0,
    findings: (s?.findings?.findings ?? []).map((f) => ({
      kind: f.kind,
      id: f.id,
      severity: f.severity,
      package: f.package ?? "",
      installed: f.installed ?? "",
      fixedIn: f.fixedIn ?? "",
      title: f.title ?? "",
    })),
    error: s?.findings?.error ?? null,
    requestedAt: iso(s?.requestedAt),
    scannedAt: iso(s?.scannedAt),
    lastUsedAt: iso(s?.lastUsedAt),
    acceptedBy: s?.acceptedBy ?? null,
    acceptedReason: s?.acceptedReason ?? null,
    acceptedAt: iso(s?.acceptedAt),
  };
}

/** Every image digest's scan. Admins only. */
export async function listImageScans(): Promise<ImageScan[]> {
  return (await call(() => images.listImageScans({}))).scans.map(imageScanOf);
}

/** Accepts a failed scan, with why (10 to 2,000 characters): the image may run until a rescan finds something new. Admins only. */
export async function acceptImageScan(digest: string, reason: string): Promise<ImageScan> {
  return imageScanOf((await call(() => images.acceptImageScan({ digest, reason }))).scan);
}

/** Scans an image again now; null when scanning is off. Admins only. */
export async function rescanImage(digest: string): Promise<ImageScan | null> {
  const { scan } = await call(() => images.rescanImage({ digest }));
  return scan ? imageScanOf(scan) : null;
}

/** Admin only. `version` is the one loaded, so a concurrent change is
 * refused (409) instead of overwritten. */
export async function updateImagePolicy(source: string, additional: string[], version: string): Promise<ImagePolicy> {
  return imagePolicy((await call(() => images.setImagePolicy({ source, additional, version }))).policy);
}

/** Irreversible, console side only: a retired team with nothing still
 * running. Its namespace stays, labelled retired, for a cluster
 * administrator to delete. Admin only. */
export async function purgeTeam(teamName: string): Promise<void> {
  await call(() => teams.purgeTeam({ name: teamName }));
}

/** A human account and its active teams (Admin page; admin only). */
export interface UserAccount {
  email: string;
  isAdmin: boolean;
  createdAt: string;
  teamNames: string[];
  /** How they sign in: a password of their own, single sign-on, or both. */
  hasPassword: boolean;
  usesSso: boolean;
  /** Their password is still the temporary one an admin set. */
  mustChangePassword: boolean;
  lastSignedInAt: string | null;
}

export async function listUsers(): Promise<UserAccount[]> {
  const { users: accounts } = await call(() => users.listUsers({}));
  return accounts.map((u) => ({
    email: u.email,
    isAdmin: u.isAdmin,
    createdAt: iso(u.createdAt) ?? "",
    teamNames: u.teamNames,
    hasPassword: u.hasPassword,
    usesSso: u.usesSso,
    mustChangePassword: u.mustChangePassword,
    lastSignedInAt: iso(u.lastSignedInAt),
  }));
}

/** This install: the console's version and which optional parts are on (AdminService.GetInstall). */
export interface InstallInfo {
  version: string;
  environmentLabel: string;
  /** "Google", or "" when single sign-on is off. */
  ssoProvider: string;
  logs: boolean;
  logSearchDays: number;
  auditCopy: boolean;
  gateway: boolean;
  catalog: boolean;
  catalogSigned: boolean;
  scanning: boolean;
  runRetentionDays: number;
  /** latest, newest, or a version; "" with no catalog. */
  catalogVersion: string;
  catalogPollSeconds: number;
  /** How many public keys may sign a release, and a keyless signer's issuer and subject pattern. */
  catalogSignerKeys: number;
  catalogKeylessIssuer: string;
  catalogKeylessSubject: string;
  /** Another install's catalog registry, as configured (not confirmed); "" when this install's own. */
  externalCatalog: string;
  email: boolean;
  emailHost: string;
  emailFrom: string;
  /** operator, google or bundled; "" when monitoring is off. */
  monitoringProvider: string;
  grafanaUrl: string;
  /** How long a session lasts: 8h, 30m, 1d. */
  sessionLength: string;
  /** As configured: the console can't read the bucket's own. 0: not known here. */
  auditKeepDays: number;
  auditLock: boolean;
  policySyncSeconds: number;
  /** Whether the kernel's signature policy is in the cluster; null when the console couldn't tell. */
  imageSignaturesRequired: boolean | null;
  /** 0 with scanning off. */
  rescanHours: number;
}

export async function getInstall(): Promise<InstallInfo> {
  const i = await call(() => admin.getInstall({}));
  return {
    version: i.version,
    environmentLabel: i.environmentLabel,
    ssoProvider: i.ssoProvider,
    logs: i.logs,
    logSearchDays: i.logSearchDays,
    auditCopy: i.auditCopy,
    gateway: i.gateway,
    catalog: i.catalog,
    catalogSigned: i.catalogSigned,
    scanning: i.scanning,
    runRetentionDays: i.runRetentionDays,
    catalogVersion: i.catalogVersion,
    catalogPollSeconds: i.catalogPollSeconds,
    catalogSignerKeys: i.catalogSignerKeys,
    catalogKeylessIssuer: i.catalogKeylessIssuer,
    catalogKeylessSubject: i.catalogKeylessSubject,
    externalCatalog: i.externalCatalog,
    email: i.email,
    emailHost: i.emailHost,
    emailFrom: i.emailFrom,
    monitoringProvider: i.monitoringProvider,
    grafanaUrl: i.grafanaUrl,
    sessionLength: i.sessionLength,
    auditKeepDays: i.auditKeepDays,
    auditLock: i.auditLock,
    policySyncSeconds: i.policySyncSeconds,
    imageSignaturesRequired: i.imageSignaturesRequired ?? null,
    rescanHours: i.rescanHours,
  };
}

/** One of the cluster's admission policies the console keeps current. */
export interface PolicySync {
  /** identityPolicy, scanPolicy, ... */
  name: string;
  /** False: nothing to write to (not configured, or not installed). */
  applies: boolean;
  ok: boolean;
  at: string | null;
  error: string | null;
}

function policySync(outcomes: Record<string, { applies: boolean; ok: boolean; at?: Timestamp; error?: string }>): PolicySync[] {
  return Object.entries(outcomes)
    .map(([name, o]) => ({ name, applies: o.applies, ok: o.ok, at: iso(o.at), error: o.error ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Admins: whether each policy was written since the console started. */
export async function getPolicySync(): Promise<PolicySync[]> {
  return policySync((await call(() => admin.getPolicySync({}))).outcomes);
}

/** Admins: writes every policy again now. */
export async function syncPolicies(): Promise<PolicySync[]> {
  return policySync((await call(() => admin.syncPolicies({}))).outcomes);
}

/** The audit log's write-once copy (ObserveService.GetAuditCopy). */
export interface AuditCopy {
  enabled: boolean;
  /** gs:// or s3://; admins only. */
  destination: string;
  copiedThrough: number;
  copiedAt: string | null;
  waiting: number;
  checkedAt: string | null;
  /** The entry where the chain broke; 0 while it holds. */
  brokenAt: number;
  problem: string;
  /** The database compared with the copy, entry by entry: this round's progress. */
  comparedThrough: number;
  comparedAt: string | null;
  /** The first entry the database changed since it was copied; 0 while they agree. */
  differsAt: number;
  compareProblem: string;
}

export async function getAuditCopy(): Promise<AuditCopy> {
  const c = await call(() => observe.getAuditCopy({}));
  return {
    enabled: c.enabled,
    destination: c.destination,
    copiedThrough: Number(c.copiedThrough),
    copiedAt: iso(c.copiedAt),
    waiting: Number(c.waiting),
    checkedAt: iso(c.checkedAt),
    brokenAt: Number(c.brokenAt),
    problem: c.problem,
    comparedThrough: Number(c.comparedThrough),
    comparedAt: iso(c.comparedAt),
    differsAt: Number(c.differsAt),
    compareProblem: c.compareProblem,
  };
}

/** Admin only. The temporary password comes back exactly once; hand it
 * over out of band and have the user change it after signing in. */
export async function createAccount(
  email: string,
  teamNames: string[],
  admin: boolean,
): Promise<{ email: string; temporaryPassword: string }> {
  const created = await call(() => users.createUser({ email, teams: teamNames, admin }));
  return { email: created.email, temporaryPassword: created.temporaryPassword };
}

/** Admin only. The account's executions stay in the history. */
export async function deleteAccount(email: string): Promise<void> {
  await call(() => users.deleteUser({ email }));
}

/** Admin-only both ways -- see ../../src/core/users.ts. */
export async function grantAdmin(email: string): Promise<void> {
  await call(() => users.setAdmin({ email, admin: true }));
}

export async function revokeAdmin(email: string): Promise<void> {
  await call(() => users.setAdmin({ email, admin: false }));
}

/** Must match NewPassword in ../../src/auth/password.ts. */
export const PASSWORD_MIN_LENGTH = 12;

/** Returns a fresh session token -- every earlier session for this account,
 * including the one that made this call, is revoked by the change. */
export async function changePassword(currentPassword: string, newPassword: string): Promise<string> {
  return (await call(() => auth.changePassword({ currentPassword, newPassword }))).token;
}

export async function resetUserPassword(email: string, newPassword: string): Promise<void> {
  await call(() => users.resetPassword({ email, newPassword }));
}

export interface SecretGrantInput {
  namespace: string;
  secretName: string;
  data: Record<string, string>;
}

export async function registerSecret(input: SecretGrantInput): Promise<void> {
  await call(() => secrets.putSecret({ team: input.namespace, secretName: input.secretName, data: input.data }));
}

/** Syncs from a `SecretStore` already in this namespace (see
 * listSecretStores) rather than a pasted value. Only the reference is
 * sent; no secret value passes through this request. `property` picks one
 * field of the remote secret (a 1Password item's field, a key of a JSON
 * secret). */
export interface ExternalSecretGrantInput {
  namespace: string;
  secretName: string;
  secretStoreName: string;
  keys: { secretKey: string; remoteKey: string; property?: string }[];
}

export async function registerExternalSecret(input: ExternalSecretGrantInput): Promise<void> {
  await call(() =>
    secrets.syncSecret({
      team: input.namespace,
      secretName: input.secretName,
      secretStoreName: input.secretStoreName,
      keys: input.keys,
    }),
  );
}

/** A team's secret source -- see ../../src/k8s.ts's SecretStoreSummary. */
export interface SecretStoreSummary {
  name: string;
  provider: string;
  providerLabel: string;
  location: string | null;
  identity: string | null;
  usesStoredCredential: boolean;
  /** Null until ESO has checked it once. */
  ready: boolean | null;
  message: string | null;
  /** How many other teams' stores sign in as the same identity. */
  sharedWithCount: number;
  /** Which teams: only filled in for an admin. */
  sharedWith: string[] | null;
}

export async function listSecretStores(teamName: string): Promise<SecretStoreSummary[]> {
  const { stores } = await call(() => secrets.listSecretStores({ team: teamName }));
  return stores.map((store) => ({
    name: store.name,
    provider: store.provider,
    providerLabel: store.providerLabel,
    location: store.location ?? null,
    identity: store.identity ?? null,
    usesStoredCredential: store.usesStoredCredential,
    ready: store.ready ?? null,
    message: store.message ?? null,
    sharedWithCount: store.sharedWithCount,
    // Only an admin is told which teams; to anyone else the list is empty.
    sharedWith: store.sharedWith.length > 0 ? store.sharedWith : null,
  }));
}

/** Live from the cluster on every call -- see ../../src/k8s.ts. */
export interface ExternalSecretDetails {
  name: string;
  storeName: string | null;
  entries: { secretKey: string; remoteKey: string; property: string | null }[];
  refreshInterval: string | null;
  lastSyncedAt: string | null;
  status: "synced" | "syncing" | "error";
  message: string | null;
}

/** One row of a team's secrets: key names only, never values. `managed`
 * is false for an ExternalSecret created outside the console, which no step
 * can mount until it's registered here. */
export interface TeamSecret {
  id: string;
  secretName: string;
  keys: string[];
  source: "literal" | "external";
  managed: boolean;
  updatedAt: string | null;
  external: ExternalSecretDetails | null;
}

export async function listTeamSecrets(teamName: string): Promise<TeamSecret[]> {
  const { secrets: rows } = await call(() => secrets.listSecrets({ team: teamName }));
  return rows.map((secret) => ({
    id: secret.id,
    secretName: secret.secretName,
    keys: secret.keys,
    source: secret.source === SecretSource.EXTERNAL ? "external" : "literal",
    managed: secret.managed,
    updatedAt: iso(secret.updatedAt),
    external: (secret.external ?? null) as ExternalSecretDetails | null,
  }));
}

/** Removes the grant, the ServiceAccount's access, and the Secret the
 * console created. Tasks already running keep what they mounted. */
export async function revokeSecret(teamName: string, secretName: string): Promise<void> {
  await call(() => secrets.revokeSecret({ team: teamName, secretName }));
}

/** Deployment facts for the "Connect a source" wizard -- see
 * ../../src/config.ts's secretSources. Empty strings mean "not available
 * on this cluster". */
export interface PlatformInfo {
  secretSources: {
    catalogRepo: string;
    clusterIssuer: string;
    gcpWorkloadIdentityPool: string;
    gkeClusterName: string;
    gkeClusterLocation: string;
  };
}

export async function getPlatform(): Promise<PlatformInfo> {
  const { catalogRepo, clusterIssuer, gcpWorkloadIdentityPool, gkeClusterName, gkeClusterLocation } = await call(() =>
    secrets.getSecretSources({}),
  );
  return {
    secretSources: { catalogRepo, clusterIssuer, gcpWorkloadIdentityPool, gkeClusterName, gkeClusterLocation },
  };
}

export interface Product {
  id: string;
  name: string;
  image: string;
  action: string;
  teamId: string | null;
  /** The owning team's name, i.e. the product's platform. Null for a
   * platform-provided product that no team owns. */
  teamName: string | null;
  inputSchema: Record<string, unknown>;
  /** The rest of its product.yaml, as its catalog's release registers it
   * (null or empty when it doesn't say): see the catalog's docs/product-schema.md. */
  displayName: string | null;
  description: string | null;
  outputSchema: Record<string, unknown>;
  serviceAccount: string | null;
  /** The team secrets it uses: its bindings in product.yaml. */
  secretRefs: string[];
  /** Audiences its steps get a short-lived ServiceAccount token for, to
   * sign in to another cloud (product.yaml's tokenAudiences). */
  tokenAudiences: string[];
  /** The other teams that may use it, or "*" for every team; empty, only its own. */
  shareWith: string[];
  /** Why it's deprecated and what to use instead, or null. */
  deprecated: string | null;
  createdAt: string;
  /** Every image this product has been registered with, newest first.
   * `image` above is the current one, which the UI marks "latest". */
  releases: ProductRelease[];
  /** Whether it's ready on this install, by its check; null when it has none (always, when it doesn't run here). */
  readiness: Readiness | null;
  /** The clouds of the installs it's for (product.yaml's clouds, else its team.yaml's); empty, every install. */
  clouds: string[];
  /** Which file set clouds: its product.yaml, its team's team.yaml, or neither. */
  cloudsFrom: "product" | "team" | "";
  /** Whether it's for this install: one that isn't is listed, never checked or run (NOT_FOR_THIS_INSTALL). */
  runsHere: boolean;
}

/** "aws", "aws and azure", "aws, azure and gcp": the clouds a product is for, in words. */
export function cloudList(clouds: readonly string[]): string {
  return clouds.length <= 1 ? (clouds[0] ?? "") : `${clouds.slice(0, -1).join(", ")} and ${clouds.at(-1) ?? ""}`;
}

/** A product's check's last answer on this install (proto/vertra/console/v1/product.proto). */
export interface Readiness {
  state: "ready" | "not_ready" | "failed" | "checking" | "unchecked";
  principal: string | null;
  missing: string[];
  detail: string | null;
  checkedAt: string | null;
  executionId: string | null;
}

function readinessOf(r: { state: string; principal: string; missing: string[]; detail: string; checkedAt?: Parameters<typeof iso>[0]; executionId: string } | undefined): Readiness | null {
  return r
    ? {
        state: r.state as Readiness["state"],
        principal: r.principal || null,
        missing: r.missing,
        detail: r.detail || null,
        checkedAt: iso(r.checkedAt),
        executionId: r.executionId || null,
      }
    : null;
}

/** Runs a product's check now; false when one is already under way. */
export async function checkProduct(name: string): Promise<boolean> {
  return (await call(() => productsApi.checkProduct({ name }))).started;
}

export interface ProductRelease {
  image: string;
  registeredAt: string;
}

/** Open to any authenticated user -- discovering what products exist to
 * build a DAG from isn't scoped the way registering one is. Normally
 * populated by the catalog's release (see ../../src/catalogSync.ts), not by hand. */
export async function listProducts(): Promise<Product[]> {
  const { products } = await call(() => productsApi.listProducts({}));
  return products.map((p) => ({
    id: p.id,
    name: p.name,
    image: p.image,
    action: p.action,
    teamId: p.teamId ?? null,
    teamName: p.teamName ?? null,
    inputSchema: p.inputSchema ?? {},
    displayName: p.displayName ?? null,
    description: p.description ?? null,
    outputSchema: p.outputSchema ?? {},
    serviceAccount: p.serviceAccount ?? null,
    secretRefs: p.secretRefs,
    tokenAudiences: p.tokenAudiences,
    shareWith: p.shareWith,
    deprecated: p.deprecated || null,
    createdAt: iso(p.createdAt) ?? "",
    releases: p.releases.map((r) => ({ image: r.image, registeredAt: iso(r.registeredAt) ?? "" })),
    readiness: readinessOf(p.readiness),
    clouds: p.clouds,
    cloudsFrom: p.cloudsFrom === "product" || p.cloudsFrom === "team" ? p.cloudsFrom : "",
    // Only a product for some clouds can be for other installs (../../src/core/clouds.ts).
    runsHere: p.runsHere || p.clouds.length === 0,
  }));
}

export interface ApiTokenMeta {
  id: string;
  label: string;
  createdAt: string;
  /** Recorded to within a few minutes; null if never used. */
  lastUsedAt: string | null;
  /** Null: until revoked. */
  expiresAt: string | null;
}

export interface Bot {
  id: string;
  email: string;
  tokens: ApiTokenMeta[];
  /** An ordering bot (decision 23): it may run only orderTemplates (<team>/<name>). */
  ordering: boolean;
  orderTemplates: string[];
  /** Where its orders' outcomes are posted (its host only), if anywhere. */
  callback: { host: string; lastSentAt: string | null; lastError: string } | null;
}

export async function listBots(teamName: string): Promise<Bot[]> {
  const { bots } = await call(() => tokens.listBots({ team: teamName }));
  return bots.map((bot) => ({
    id: bot.id,
    email: bot.email,
    tokens: bot.tokens.map((t) => ({
      id: t.id,
      label: t.label,
      createdAt: iso(t.createdAt) ?? "",
      lastUsedAt: iso(t.lastUsedAt),
      expiresAt: iso(t.expiresAt),
    })),
    ordering: bot.ordering,
    orderTemplates: bot.orderTemplates,
    callback: bot.callbackHost
      ? { host: bot.callbackHost, lastSentAt: iso(bot.callbackLastSentAt), lastError: bot.callbackLastError }
      : null,
  }));
}

/** The raw `token` in the response is shown to the caller exactly once --
 * this client never stores or logs it, same as the backend never persists
 * it in plaintext (see ../../src/db/schema.ts's apiTokens). */
export async function createBot(
  teamName: string,
  email: string,
  label: string,
  orderTemplates?: string[],
  expiresInDays?: number,
): Promise<{ email: string; token: string; tokenId: string }> {
  const ordering = orderTemplates !== undefined;
  const created = await call(() =>
    tokens.createBotToken({ team: teamName, email, label, ordering, orderTemplates: orderTemplates ?? [], expiresInDays }),
  );
  return { email: created.email, token: created.token, tokenId: created.tokenId };
}

/** Sets what an ordering bot may order: <team>/<name> each. */
export async function setBotOrders(teamName: string, email: string, templates: string[]): Promise<string[]> {
  return (await call(() => tokens.setBotOrders({ team: teamName, email, templates }))).templates;
}

/** Sets (or, with an empty url, removes) an ordering bot's callback. The
 * signing secret comes back only when it's new: shown once, never stored here. */
export async function setBotCallback(
  teamName: string,
  email: string,
  url: string,
  rotateSecret = false,
): Promise<{ host: string; signingSecret: string }> {
  const { host, signingSecret } = await call(() => tokens.setBotCallback({ team: teamName, email, url, rotateSecret }));
  return { host, signingSecret };
}

export async function revokeToken(tokenId: string): Promise<void> {
  await call(() => tokens.revokeToken({ tokenId }));
}

/** Must match SCOPES in ../../src/auth/scopes.ts. Catalog CI needs none of
 * these: each console pulls the catalog's release itself. They're for
 * automation of your own. */
export const AUTOMATION_SCOPES = [
  { scope: "teams:create", description: "Create teams and their namespaces", defaultOn: false },
  { scope: "products:register", description: "Register and update any team's products", defaultOn: false },
  { scope: "teams:retire", description: "Retire or un-retire a team (reversible)", defaultOn: false },
  {
    scope: "teams:delete",
    description: "Purge a retired team for good, namespace included. Give this to a token of its own",
    defaultOn: false,
  },
  { scope: "secret-stores:apply", description: "Apply a team's reviewed SecretStore file", defaultOn: false },
] as const;

export interface AutomationToken {
  id: string;
  label: string;
  scopes: string[];
  botEmail: string;
  createdAt: string;
  expiresAt: string | null;
}

export async function listAutomationTokens(): Promise<AutomationToken[]> {
  const { tokens: rows } = await call(() => tokens.listAutomationTokens({}));
  return rows.map((t) => ({
    id: t.id,
    label: t.label,
    scopes: t.scopes,
    botEmail: t.botEmail,
    createdAt: iso(t.createdAt) ?? "",
    expiresAt: iso(t.expiresAt),
  }));
}

/** The raw `token` is only ever returned here, once. */
export async function createAutomationToken(
  label: string,
  scopes: string[],
  expiresInDays?: number,
): Promise<{ tokenId: string; label: string; scopes: string[]; token: string }> {
  const created = await call(() => tokens.createAutomationToken({ label, scopes, expiresInDays }));
  return { tokenId: created.tokenId, label: created.label, scopes: created.scopes, token: created.token };
}

/** console/'s own record of an execution -- who submitted it and which teams'
 * tasks it contains (see ../../src/db/schema.ts's submittedExecutions).
 * This, not kernel-api, is what a listing comes from: kernel-api has no
 * concept of "which executions can this caller see." */
export interface ExecutionSummary {
  executionId: string;
  teams: string[];
  submittedBy: string;
  name: string;
  createdAt: string;
  /** Live, fetched from kernel-api in bulk on every list load -- `null`
   * only if that lookup itself failed (kernel-api briefly unreachable),
   * not a real execution state. */
  state: string | null;
  /** Run from a template: <team>/<template>, or <team>/<product>.<action>; "" for a DAG. */
  template: string;
  /** How many of its steps are in each state (PENDING, RUNNING, SUCCEEDED, ...). */
  steps: Record<string, number>;
  /** When it finished, once it has. */
  finishedAt: string | null;
  /** The submitter's email; "" once that account is deleted. */
  submittedByEmail: string;
  /** The steps claimed or running now, in the order they were submitted. */
  running: RunningStep[];
  /** The schedule that started it, by name; null when none did (or it's deleted). */
  schedule: string | null;
}

/** A step claimed or running, and which attempt. */
export interface RunningStep {
  taskId: string;
  action: string;
  attempt: number;
  maxAttempts: number;
}

export interface ExecutionPage {
  executions: ExecutionSummary[];
  /** Pass back as `cursor` for the next page; null on the last. */
  nextCursor: string | null;
  /** How many days runs' records are kept; 0 keeps them forever. */
  runRetentionDays: number;
}

export interface ExecutionListQuery {
  limit?: number;
  cursor?: string;
  /** ISO date-time: only executions submitted since. */
  since?: string;
  team?: string;
  /** Part of the name. */
  search?: string;
  /** Only your own runs. */
  mine?: boolean;
}

/** The executions you can see, newest first, a page at a time. */
export async function listExecutions(query: ExecutionListQuery = {}): Promise<ExecutionPage> {
  const page = await call(() =>
    executions.listExecutions({
      page: { limit: query.limit ?? 0, cursor: query.cursor ?? "" },
      team: query.team ?? "",
      search: query.search ?? "",
      mine: query.mine ?? false,
      ...(query.since ? { since: timestampFromDate(new Date(query.since)) } : {}),
    }),
  );
  return {
    executions: page.executions.map((row) => ({
      executionId: row.executionId,
      teams: row.teams,
      submittedBy: row.submittedBy ?? "",
      name: row.name,
      createdAt: iso(row.createdAt) ?? "",
      state: row.state === ExecutionState.UNSPECIFIED ? null : ExecutionState[row.state],
      template: row.template,
      steps: { ...row.steps },
      finishedAt: iso(row.finishedAt),
      submittedByEmail: row.submittedByEmail ?? "",
      running: row.running.map((r) => ({ taskId: r.taskId, action: r.action, attempt: r.attempt, maxAttempts: r.maxAttempts })),
      schedule: row.schedule ?? null,
    })),
    nextCursor: page.nextCursor || null,
    runRetentionDays: page.runRetentionDays,
  };
}

/** `payload` is deliberately `unknown`, not a typed submission: the server
 * is the one authority on the full shape, and this client only needs to
 * pass it through, not re-validate it. */
export async function submitExecution(payload: unknown): Promise<{ executionId: string; state: string }> {
  let dag: Dag;
  try {
    dag = fromJson(DagSchema, payload as JsonValue);
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : "This isn't a DAG the console accepts.");
  }
  const submitted = await call(() => executions.submitExecution({ dag }));
  return { executionId: submitted.executionId, state: ExecutionState[submitted.state] };
}

export interface TaskStatus {
  taskId: string;
  state: string;
  attemptCount: number;
  outputs: Record<string, unknown> | null;
  failure: { code: string; message: string; retryable: boolean } | null;
  /** The real DAG edges, from the kernel's own `task_dependencies` table --
   * not derived or re-inferred client-side. */
  dependsOn: string[];
  /** The current attempt's real timing, from `task_attempts` --
   * `completedAt` is null while a task is still running or hasn't
   * started yet. */
  startedAt: string | null;
  completedAt: string | null;
  /** Every attempt, first to last: who asked for it and what acted in it. */
  attempts: TaskAttempt[];
  /** Once it failed: what that means, what to do, whether retrying is safe, whom to ask. */
  help: FailureHelp | null;
  /** Set when the step needs a maintainer of its team to approve it. */
  approval: TaskApproval | null;
  /** While it's ready but waiting its turn behind another step with its concurrency key: the key's inputs and values. */
  waitingFor: Record<string, unknown> | null;
  /** While it's ready but waiting because its product already has its most steps running. */
  waitingForCap: boolean;
}

export interface TaskApproval {
  /** The email of who approved it; "" while it hasn't been. */
  approvedBy: string;
  approvedAt: string | null;
  /** While it awaits approval: since when. */
  awaitingSince: string | null;
  /** Whether the signed-in user may approve or decline it now. */
  canDecide: boolean;
  /** Whether they can preview what it would do first (previewStep). */
  canPreview: boolean;
}

export interface FailureHelp {
  means: string;
  whatToDo: string;
  /** The owning team's words, not the platform's. */
  fromOwner: boolean;
  retry: "safe" | "unsafe" | "unknown" | string;
  team: string;
  contact: string;
  chat: string;
  url: string;
}

export interface TaskAttempt {
  number: number;
  startedAt: string | null;
  completedAt: string | null;
  failure: { code: string; message: string; retryable: boolean } | null;
  /** The email of who asked for it; "" for an automatic retry. */
  requestedBy: string;
  trigger: "submitted" | "retried" | "automatic_retry" | string;
  /** <team>/<serviceAccount>. */
  actedAs: string;
  image: string;
}

/** One task as submitted (images pinned) -- this is *input*, kept for
 * reference alongside TaskStatus's live *outcome*; the two are joined
 * client-side by `id`/`taskId`. timeoutSeconds, maxAttempts and
 * serviceAccount are absent when the submission left them to their
 * defaults. */
export interface SubmittedTaskPayload {
  id: string;
  image: string;
  action: string;
  dependsOn?: string[];
  inputs?: Record<string, unknown>;
  timeoutSeconds?: number;
  maxAttempts?: number;
  team: string;
  serviceAccount?: string;
  secretRefs?: string[];
}

/** As stored at submission. */
export interface SubmittedExecutionPayload {
  name: string;
  /** Empty when the submission had none. */
  requestId: string;
  tasks: SubmittedTaskPayload[];
}

/** Proxied live from kernel-api (see ../../src/core/executions.ts) --
 * state/tasks are real-time, not a cached copy of ExecutionSummary.
 * teams/submittedBy/createdAt are merged in by console/ from its own
 * submitted-executions index -- kernel-api itself has no concept of
 * either. `submittedBy` is `null` only if that user's account has since
 * been deleted. `payload` is the exact original submission body, `null`
 * only for executions submitted before console/ started storing it. */
export interface ExecutionDetail {
  executionId: string;
  name: string;
  state: string;
  tasks: TaskStatus[];
  teams: string[];
  submittedBy: string | null;
  createdAt: string;
  payload: SubmittedExecutionPayload | null;
  /** Why rerun and task retry are refused (a purged or retired team, or an
   * image the registry says is gone), or null when they aren't. */
  runBlocked: {
    error: "TEAM_PURGED" | "TEAM_RETIRED" | "IMAGE_NOT_FOUND" | "IMAGE_NOT_ALLOWED" | "IMAGE_POLICY_NOT_CONFIGURED";
    message: string;
    missingImages?: string[];
    disallowedImages?: string[];
  } | null;
  /** Run from a template: <team>/<template>, or <team>/<product>.<action>
   * for an action run on its own; null for a DAG submitted as such. */
  template: string | null;
  templateParameters: Record<string, unknown> | null;
  /** Which of the submitter's teams it ran for, if any. */
  onBehalfOf: string | null;
  /** The schedule that started it, by name; null when none did (or it's deleted). */
  schedule: string | null;
}

export async function getExecution(executionId: string): Promise<ExecutionDetail> {
  const { execution } = await call(() => executions.getExecution({ executionId }));
  if (!execution) throw new ApiError(404, "Execution not found.");
  return executionDetail(execution);
}

/**
 * The execution each time it changes (and every 15s regardless), until it
 * finishes; then the iteration ends. It also ends, unfinished, when the
 * server's time limit for one stream is reached, or throws if the
 * connection drops: either way, watch again. Stops when `signal` aborts.
 */
export async function* watchExecution(executionId: string, signal: AbortSignal): AsyncGenerator<ExecutionDetail> {
  try {
    for await (const { execution } of executions.watchExecution({ executionId }, { signal })) {
      if (execution) yield executionDetail(execution);
    }
  } catch (error) {
    throw apiError(error);
  }
}

function executionDetail(execution: Execution): ExecutionDetail {
  const dag = execution.dag;
  return {
    executionId: execution.executionId,
    name: execution.name,
    state: ExecutionState[execution.state],
    tasks: execution.tasks.map((task) => ({
      taskId: task.taskId,
      state: TaskState[task.state],
      attemptCount: task.attemptCount,
      outputs: task.outputs ?? null,
      failure: task.failure
        ? { code: task.failure.code, message: task.failure.message, retryable: task.failure.retryable }
        : null,
      dependsOn: task.dependsOn,
      startedAt: iso(task.startedAt),
      completedAt: iso(task.completedAt),
      attempts: task.attempts.map((attempt) => ({
        number: attempt.number,
        startedAt: iso(attempt.startedAt),
        completedAt: iso(attempt.completedAt),
        failure: attempt.failure
          ? { code: attempt.failure.code, message: attempt.failure.message, retryable: attempt.failure.retryable }
          : null,
        requestedBy: attempt.requestedBy,
        trigger: attempt.trigger,
        actedAs: attempt.actedAs,
        image: attempt.image,
      })),
      help: task.help
        ? {
            means: task.help.means,
            whatToDo: task.help.whatToDo,
            fromOwner: task.help.fromOwner,
            retry: task.help.retry,
            team: task.help.team,
            contact: task.help.contact,
            chat: task.help.chat,
            url: task.help.url,
          }
        : null,
      approval: task.approval
        ? {
            approvedBy: task.approval.approvedBy,
            approvedAt: iso(task.approval.approvedAt),
            awaitingSince: iso(task.approval.awaitingSince),
            canDecide: task.approval.canDecide,
            canPreview: task.approval.canPreview,
          }
        : null,
      waitingFor: task.waitingFor ?? null,
      waitingForCap: task.waitingForCap,
    })),
    teams: execution.teams,
    submittedBy: execution.submittedBy || null,
    createdAt: iso(execution.createdAt) ?? "",
    payload: dag
      ? {
          name: dag.name,
          requestId: dag.requestId,
          tasks: dag.tasks.map((task) => ({
            id: task.id,
            image: task.image,
            action: task.action,
            dependsOn: task.dependsOn,
            inputs: task.inputs ?? {},
            timeoutSeconds: task.timeoutSeconds,
            maxAttempts: task.maxAttempts,
            team: task.team,
            serviceAccount: task.serviceAccount,
            secretRefs: task.secretRefs,
          })),
        }
      : null,
    runBlocked: execution.runBlocked
      ? {
          error: execution.runBlocked.code as NonNullable<ExecutionDetail["runBlocked"]>["error"],
          message: execution.runBlocked.message,
          missingImages: execution.runBlocked.missingImages,
          disallowedImages: execution.runBlocked.disallowedImages,
        }
      : null,
    template: execution.template ?? null,
    templateParameters: execution.templateParameters ?? null,
    onBehalfOf: execution.onBehalfOf ?? null,
    schedule: execution.schedule ?? null,
  };
}

export async function cancelExecution(executionId: string): Promise<{ executionId: string; state: string }> {
  const result = await call(() => executions.cancelExecution({ executionId }));
  return { executionId: result.executionId, state: ExecutionState[result.state] };
}

export async function retryTask(executionId: string, taskId: string): Promise<{ executionId: string; state: string }> {
  const result = await call(() => executions.retryTask({ executionId, taskId }));
  return { executionId: result.executionId, state: ExecutionState[result.state] };
}

/** Approves (approve) or declines a step awaiting approval; a decline may say why. */
export async function decideApproval(
  executionId: string,
  taskId: string,
  approve: boolean,
  reason = "",
): Promise<{ executionId: string; state: string }> {
  const result = await call(() => executions.decideApproval({ executionId, taskId, approve, reason }));
  return { executionId: result.executionId, state: ExecutionState[result.state] };
}

export interface PendingApproval {
  executionId: string;
  executionName: string;
  taskId: string;
  team: string;
  image: string;
  action: string;
  /** The email of who submitted the run. */
  requestedBy: string;
  awaitingSince: string | null;
  /** False when the signed-in user submitted it: someone else decides. */
  canDecide: boolean;
}

/** The steps awaiting approval in the teams the signed-in user maintains. */
export async function listPendingApprovals(): Promise<PendingApproval[]> {
  const result = await call(() => executions.listPendingApprovals({}));
  return result.approvals.map((a) => ({
    executionId: a.executionId,
    executionName: a.executionName,
    taskId: a.taskId,
    team: a.team,
    image: a.image,
    action: a.action,
    requestedBy: a.requestedBy,
    awaitingSince: iso(a.awaitingSince),
    canDecide: a.canDecide,
  }));
}

/** Resubmits the execution's original task graph as a brand-new execution
 * (a new executionId, not a reset of this one -- see
 * ../../src/core/executions.ts's own comment on why). Fails with a 422
 * if this execution predates rerun support and has no stored submission to
 * replay. */
export async function rerunExecution(executionId: string): Promise<{ executionId: string; state: string }> {
  const result = await call(() => executions.rerunExecution({ executionId }));
  return { executionId: result.executionId, state: ExecutionState[result.state] };
}

export interface ExecutionEvent {
  id: number;
  eventType: string;
  taskId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** Cursor-paginated (ListExecutionEvents): `after` is an event id, not an offset, so polling
 * with the previous page's nextCursor never re-fetches or skips events
 * even if more were inserted in between polls. */
export async function getExecutionEvents(
  executionId: string,
  after?: number,
): Promise<{ events: ExecutionEvent[]; nextCursor: number | null }> {
  const page = await call(() => executions.listExecutionEvents({ executionId, after: BigInt(after ?? 0) }));
  return {
    events: page.events.map((event) => ({
      id: Number(event.id),
      eventType: event.eventType,
      taskId: event.taskId ?? null,
      payload: event.payload ?? {},
      createdAt: iso(event.createdAt) ?? "",
    })),
    nextCursor: page.nextCursor === 0n ? null : Number(page.nextCursor),
  };
}

/** One task's captured container stdout, as actually run -- distinct from
 * ExecutionEvent, which only records scheduler-level transitions
 * (TASK_STARTED, TASK_SUCCEEDED, ...) and never what the container itself
 * printed. `lines` is `[]` for a task that hasn't completed an attempt yet,
 * not an error. */
export interface TaskLogs {
  taskId: string;
  /** What you may see: every line for the step's team, else its INFO lines. */
  lines: string[];
  /** Lines held back from you, and the team that sees them. */
  hidden: number;
  visibleTo: string;
}

/** Every task's logs in one call, not one call per task. */
export async function getExecutionLogs(executionId: string): Promise<{ tasks: TaskLogs[] }> {
  const { tasks } = await call(() => executions.getExecutionLogs({ executionId }));
  return { tasks: tasks.map((t) => ({ taskId: t.taskId, lines: t.lines, hidden: t.hidden, visibleTo: t.visibleTo })) };
}

/** Admin-only -- see ../../src/core/admin.ts. A non-admin's home view
 * derives its own numbers from data it fetches anyway (Me.teamNames,
 * its own already-scoped executions list). */
export interface PlatformStats {
  teams: number;
  users: number;
  products: number;
  executions: number;
}

export async function getStats(): Promise<PlatformStats> {
  const stats = await call(() => admin.getStats({}));
  return {
    teams: Number(stats.teams),
    users: Number(stats.users),
    products: Number(stats.products),
    executions: Number(stats.executions),
  };
}

/** The catalog this console registers from -- see ../../src/catalogSync.ts.
 * Admin-only. */
export interface CatalogStatus {
  /** Where the release is read from; "" when no catalog is configured. */
  release: string;
  /** Whether it follows the newest version instead of release's tag. */
  newestVersion: boolean;
  digest: string;
  /** The version applied (vX.Y.Z), "" when it wasn't one. */
  version: string;
  commit: string;
  repository: string;
  appliedAt: string | null;
  /** adoptableTeam: a team the catalog didn't make, which an admin may
   * adopt (adoptCatalogTeam); "" for any other problem. */
  problems: { item: string; message: string; adoptableTeam: string }[];
  checkedAt: string | null;
  error: string;
  /** What the applied release held; null before one was applied. */
  applied: CatalogCounts | null;
}

/** What a catalog release held: products by image, each with its actions. */
export interface CatalogCounts {
  teams: number;
  products: number;
  actions: number;
  templates: number;
  apis: number;
  secretStores: number;
}

function catalogStatus(status: {
  release: string;
  newestVersion: boolean;
  version: string;
  digest: string;
  commit: string;
  repository: string;
  appliedAt?: Timestamp;
  problems: { item: string; message: string; adoptableTeam: string }[];
  checkedAt?: Timestamp;
  error: string;
  applied?: CatalogCounts;
} | undefined): CatalogStatus {
  return {
    release: status?.release ?? "",
    newestVersion: status?.newestVersion ?? false,
    digest: status?.digest ?? "",
    version: status?.version ?? "",
    commit: status?.commit ?? "",
    repository: status?.repository ?? "",
    appliedAt: iso(status?.appliedAt),
    problems: (status?.problems ?? []).map((p) => ({ item: p.item, message: p.message, adoptableTeam: p.adoptableTeam })),
    checkedAt: iso(status?.checkedAt),
    error: status?.error ?? "",
    applied: status?.applied
      ? { teams: status.applied.teams, products: status.applied.products, actions: status.applied.actions, templates: status.applied.templates, apis: status.applied.apis, secretStores: status.applied.secretStores }
      : null,
  };
}

export async function getCatalogStatus(): Promise<CatalogStatus> {
  const { status } = await call(() => admin.getCatalogStatus({}));
  return catalogStatus(status);
}

/** Reads and applies the catalog's release now. */
export async function syncCatalog(): Promise<CatalogStatus> {
  const { status } = await call(() => admin.syncCatalog({}));
  return catalogStatus(status);
}

/** Lets the catalog's release manage an existing team it didn't make (its
 * namespace, secrets and products), then syncs. */
export async function adoptCatalogTeam(name: string): Promise<CatalogStatus> {
  const { status } = await call(() => admin.adoptCatalogTeam({ name }));
  return catalogStatus(status);
}

/** The stored credential (a vault provider's token) the team's
 * SecretStores may use: this install's own, never the catalog's. */
export async function setSecretStoreCredential(team: string, credential: string): Promise<void> {
  await call(() => teams.setSecretStoreCredential({ team, credential }));
}

/** One task attempt in a team's namespace -- see ../../src/core/teams.ts.
 * Read-only, no secret data, never another team's. */
export interface TaskPod {
  podName: string;
  executionId: string | null;
  taskKey: string | null;
  attempt: number | null;
  image: string | null;
  serviceAccount: string | null;
  state: "starting" | "running" | "cant-start" | "finished" | "failed";
  problem: { title: string; detail: string } | null;
  restarts: number;
  startedAt: string | null;
  finishedAt: string | null;
  execution: { name: string; taskNumber: number | null; taskCount: number | null } | null;
}

const POD_STATE: Record<TaskPodState, TaskPod["state"]> = {
  [TaskPodState.UNSPECIFIED]: "starting",
  [TaskPodState.STARTING]: "starting",
  [TaskPodState.RUNNING]: "running",
  [TaskPodState.CANT_START]: "cant-start",
  [TaskPodState.FINISHED]: "finished",
  [TaskPodState.FAILED]: "failed",
};

export async function listTeamPods(teamName: string): Promise<TaskPod[]> {
  const { pods } = await call(() => teams.listPods({ team: teamName }));
  return pods.map((pod) => ({
    podName: pod.podName,
    executionId: pod.executionId ?? null,
    taskKey: pod.taskId ?? null,
    attempt: pod.attempt ?? null,
    image: pod.image ?? null,
    serviceAccount: pod.serviceAccount ?? null,
    state: POD_STATE[pod.state],
    problem: pod.problem ? { title: pod.problem.title, detail: pod.problem.detail } : null,
    restarts: pod.restarts,
    startedAt: iso(pod.startedAt),
    finishedAt: iso(pod.finishedAt),
    execution: pod.execution
      ? {
          name: pod.execution.name,
          taskNumber: pod.execution.taskNumber ?? null,
          taskCount: pod.execution.taskCount ?? null,
        }
      : null,
  }));
}

/** The in-app Docs page -- see ../../src/rpc/services/guide.ts. Any
 * authenticated user, no team scoping. */
export interface DocSummary {
  id: string;
  title: string;
  /** guides: for using Vertra; reference: the platform's own docs. */
  section: "guides" | "reference";
  /** guide, current (how it works now), operating (running it), or history (decisions: why, not what is). */
  kind: string;
  /** Its ## headings, in order, with their anchors: a long doc is shown a section to a page. */
  sections: { title: string; anchor: string }[];
}

export async function listDocs(): Promise<DocSummary[]> {
  return (await call(() => guides.listGuides({}))).guides.map((g) => ({
    id: g.id,
    title: g.title,
    section: g.section === "reference" ? "reference" : "guides",
    kind: g.kind,
    sections: g.sections.map((x) => ({ title: x.title, anchor: x.anchor })),
  }));
}

/** A section of a guide or reference doc that matches a question. */
export interface DocHit {
  guide: string;
  title: string;
  heading: string;
  excerpt: string;
  kind: string;
}

/** The sections that best match a question's words, best first, design history included (labelled). */
export async function searchDocs(query: string): Promise<DocHit[]> {
  return (await call(() => guides.searchGuides({ query, limit: 8, includeHistory: true }))).hits.map((h) => ({
    guide: h.guide,
    title: h.title,
    heading: h.heading,
    excerpt: h.excerpt,
    kind: h.kind,
  }));
}

/** A guide's markdown. */
export async function getDoc(id: string): Promise<string> {
  return (await call(() => guides.getGuide({ id }))).markdown;
}

/** A figure the docs draw (architecture/6-the-pieces.svg), as a data: URL an <img> shows (the CSP allows those, and an SVG shown as an image runs nothing). */
export async function getDocImage(path: string): Promise<string> {
  const { svg } = await call(() => guides.getGuideImage({ path }));
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** A template, or an action that can run on its own, that the caller may
 * run (TemplateService: ../../src/core/templates.ts). */
export interface Runnable {
  kind: "template" | "action";
  /** RunTemplate names it by team and name; RunAction by its product's name. */
  team: string;
  name: string;
  displayName: string;
  description: string;
  /** A JSON Schema for an object: the form to fill in. */
  parameters: Record<string, unknown>;
  /** Its steps' actions, as <team>/<product>.<action>. */
  actions: string[];
  deprecated: string | null;
  /** The caller's teams it may run on behalf of; one is needed when required. */
  onBehalfOf: string[];
  onBehalfOfRequired: boolean;
  /** Whether you may run it. Ones that aren't shared with you are listed too, unless hidden. */
  shared: boolean;
  /** The other teams it's shared with, or "*" for every team. */
  shareWith: string[];
  /** Its file in the catalog repository, when known. */
  sourceUrl: string | null;
  /** Not shared with you: GitHub's new-issue page asking its team for it. */
  askForAccessUrl: string | null;
  /** Its parameters that name another team's targets, with what yours may give. */
  targets: { parameter: string; type: string; allowed: string[] }[];
  /** Preview says what it would do: it (or a step of it) has a plan. */
  previewable: boolean;
  /** Whether it's ready here; null when nothing in it has a check. */
  readiness: Readiness | null;
  /** Examples of running it: an action's passing contract tests. */
  examples: { name: string; inputs: Record<string, unknown>; outputs: Record<string, unknown> }[];
  /** An action's product's clouds (Product.clouds); empty for a template, or a product for every install. */
  clouds: string[];
  /** Whether an action's product is for this install; always true for a template, whose steps are checked when it's run. */
  runsHere: boolean;
  /** Where an action's clouds are set: "product", "team", or "". */
  cloudsFrom: string;
}

export async function listRunnables(): Promise<Runnable[]> {
  const { runnables } = await call(() => templates.listTemplates({}));
  return runnables.map((r) => ({
    kind: r.kind === Runnable_Kind.ACTION ? "action" : "template",
    team: r.team,
    name: r.name,
    displayName: r.displayName,
    description: r.description,
    parameters: (r.parameters ?? {}) as Record<string, unknown>,
    actions: r.actions,
    deprecated: r.deprecated || null,
    onBehalfOf: r.onBehalfOf,
    onBehalfOfRequired: r.onBehalfOfRequired,
    shared: r.shared,
    shareWith: r.shareWith,
    sourceUrl: r.sourceUrl || null,
    askForAccessUrl: r.askForAccessUrl || null,
    targets: r.targets.map((t) => ({ parameter: t.parameter, type: t.type, allowed: t.allowed })),
    previewable: r.previewable,
    readiness: readinessOf(r.readiness),
    examples: r.examples.map((e) => ({ name: e.name, inputs: (e.inputs ?? {}) as Record<string, unknown>, outputs: (e.outputs ?? {}) as Record<string, unknown> })),
    clouds: r.clouds,
    runsHere: r.runsHere || r.clouds.length === 0,
    cloudsFrom: r.cloudsFrom,
  }));
}

/** Runs a template, or an action on its own, with these parameters; returns the execution's id. */
export async function runRunnable(
  runnable: Pick<Runnable, "kind" | "team" | "name">,
  parameters: Record<string, unknown>,
  onBehalfOf?: string,
): Promise<string> {
  const values = parameters as JsonObject;
  const result =
    runnable.kind === "template"
      ? await call(() => templates.runTemplate({ team: runnable.team, name: runnable.name, parameters: values, onBehalfOf }))
      : await call(() => templates.runAction({ product: runnable.name, inputs: values, onBehalfOf }));
  return result.executionId;
}

export interface ApiEndpoint {
  method: string;
  path: string;
  summary: string;
}

/** An API product (proto/vertra/console/v1/api.proto). */
export interface ApiProduct {
  team: string;
  name: string;
  displayName: string;
  description: string;
  state: "LIVE" | "HELD" | "PAUSED" | "UNAVAILABLE" | "UNSPECIFIED";
  heldReason: string;
  /** Unavailable: why the gateway can't use its OpenAPI document, and since when. */
  problem: string;
  problemFoundAt: string | null;
  pausedMessage: string;
  mayCall: boolean;
  shareWith: string[];
  hidden: boolean;
  deprecated: string;
  internet: boolean;
  url: string;
  publicUrl: string;
  endpoints: ApiEndpoint[];
  perMinute: number;
  timeoutSeconds: number;
  maxRequestBytes: number;
  sourcePath: string;
  /** Its own team only. */
  backendUrl: string;
  backendAuth: string;
  specTitle: string;
  specVersion: string;
  /** When the caller may not call it: an issue asking its team to share it, on the catalog repository. */
  askForAccessUrl: string | null;
  /** Each team its api.yaml names a limit for; everyone else gets defaultPerMinute (api.yaml's, else the gateway's own). */
  limits: { team: string; perMinute: number }[];
  defaultPerMinute: number;
  defaultFromGateway: boolean;
}

function apiProduct(a: Awaited<ReturnType<typeof apisApi.listApis>>["apis"][number]): ApiProduct {
  return {
    team: a.team,
    name: a.name,
    displayName: a.displayName,
    description: a.description,
    state: ApiState[a.state] as ApiProduct["state"],
    heldReason: a.heldReason,
    problem: a.problem,
    problemFoundAt: iso(a.problemFoundAt),
    pausedMessage: a.pausedMessage,
    mayCall: a.mayCall,
    shareWith: a.shareWith,
    hidden: a.hidden,
    deprecated: a.deprecated,
    internet: a.internet,
    url: a.url,
    publicUrl: a.publicUrl,
    endpoints: a.endpoints.map((e) => ({ method: e.method, path: e.path, summary: e.summary })),
    perMinute: a.perMinute,
    timeoutSeconds: a.timeoutSeconds,
    maxRequestBytes: a.maxRequestBytes,
    sourcePath: a.sourcePath,
    backendUrl: a.backendUrl,
    backendAuth: a.backendAuth,
    specTitle: a.specTitle,
    specVersion: a.specVersion,
    askForAccessUrl: a.askForAccessUrl || null,
    limits: a.limits.map((l) => ({ team: l.team, perMinute: l.perMinute })),
    defaultPerMinute: a.defaultPerMinute,
    defaultFromGateway: a.defaultFromGateway,
  };
}

/** Every API the signed-in user may see. */
export async function listApis(): Promise<ApiProduct[]> {
  const result = await call(() => apisApi.listApis({}));
  return result.apis.map(apiProduct);
}

/** One API, and its OpenAPI document as JSON. */
export async function getApi(team: string, name: string): Promise<{ api: ApiProduct; openapi: string }> {
  const result = await call(() => apisApi.getApi({ team, name }));
  if (!result.api) throw new ApiError(404, `No API "${team}/${name}".`);
  return { api: apiProduct(result.api), openapi: result.openapi };
}

export async function pauseApi(team: string, name: string, message: string): Promise<void> {
  await call(() => apisApi.pauseApi({ team, name, message }));
}

export async function resumeApi(team: string, name: string): Promise<void> {
  await call(() => apisApi.resumeApi({ team, name }));
}

export interface ApiTraffic {
  requests: number;
  forwarded: number;
  stopped: number;
  backendErrors: number;
  endpoints: { endpoint: string; requests: number; invalid: number; backend4xx: number; backend5xx: number; averageMs: number }[];
  blocked: { request: string; count: number; teams: string[]; last: string | null }[];
  teams: { team: string; requests: number; peakPerMinute: number; limitPerMinute: number }[];
}

/** An API's traffic over the last `hours`: its own team's, and admins'. */
export async function getApiTraffic(team: string, name: string, hours: number): Promise<ApiTraffic> {
  const t = await call(() => apisApi.getApiTraffic({ team, name, hours }));
  return {
    requests: Number(t.requests),
    forwarded: Number(t.forwarded),
    stopped: Number(t.stopped),
    backendErrors: Number(t.backendErrors),
    endpoints: t.endpoints.map((e) => ({
      endpoint: e.endpoint,
      requests: Number(e.requests),
      invalid: Number(e.invalid),
      backend4xx: Number(e.backend4xx),
      backend5xx: Number(e.backend5xx),
      averageMs: Number(e.averageMs),
    })),
    blocked: t.blocked.map((b) => ({ request: b.request, count: Number(b.count), teams: b.teams, last: iso(b.last) })),
    teams: t.teams.map((x) => ({ team: x.team, requests: Number(x.requests), peakPerMinute: Number(x.peakPerMinute), limitPerMinute: x.limitPerMinute })),
  };
}

export interface GatewayInfo {
  enabled: boolean;
  backendHosts: string[];
  internetTeams: string[];
  url: string;
  publicUrl: string;
  closedMessage: string;
  closedBy: string;
  closedAt: string | null;
  apis: number;
  requests24h: number;
  refused: { outcome: string; count: number; mostly: string }[];
}

/** The gateway's settings and state: admins. */
export async function getGateway(): Promise<GatewayInfo> {
  const g = await call(() => apisApi.getGateway({}));
  return {
    enabled: g.enabled,
    backendHosts: g.backendHosts,
    internetTeams: g.internetTeams,
    url: g.url,
    publicUrl: g.publicUrl,
    closedMessage: g.closedMessage,
    closedBy: g.closedBy,
    closedAt: iso(g.closedAt),
    apis: g.apis,
    requests24h: Number(g.requests24h),
    refused: g.refused.map((r) => ({ outcome: r.outcome, count: Number(r.count), mostly: r.mostly })),
  };
}

/** Closes the gateway with a message, or reopens it (""). */
export async function setGatewayClosed(message: string): Promise<void> {
  await call(() => apisApi.setGatewayClosed({ message }));
}

export interface SecurityView {
  checks: { name: string; state: "enforced" | "off" | "not_yet" | string; text: string }[];
  /** source: step (the cluster), catalog (the console) or gateway; count: how many, for the gateway's (grouped). */
  /** what: the step or the calls refused; detail: under it, the step's image, the endpoint or the release. */
  refusals: { at: string | null; what: string; detail: string; team: string; code: string; why: string; executionId: string; source: string; count: number }[];
  images: {
    product: string;
    team: string;
    image: string;
    scan: string;
    scannedAt: string | null;
    fixable: number;
    unfixable: number;
    secrets: number;
    acceptedReason: string;
  }[];
}

/** What this install enforces, what it refused this week, and every image allowed to run. */
/** An image's SBOM (CycloneDX JSON) as catalog CI attached it; ApiError NO_SBOM when there's none. */
export async function getImageSbom(image: string): Promise<string> {
  return (await call(() => observe.getImageSbom({ image }))).sbom;
}

export async function getSecurity(): Promise<SecurityView> {
  const s = await call(() => observe.getSecurity({}));
  return {
    checks: s.checks.map((c) => ({ name: c.name, state: c.state, text: c.text })),
    refusals: s.refusals.map((r) => ({
      at: iso(r.at),
      what: r.what,
      detail: r.detail,
      team: r.team,
      code: r.code,
      why: r.why,
      executionId: r.executionId,
      source: r.source || "step",
      count: r.count || 1,
    })),
    images: s.images.map((i) => ({
      product: i.product,
      team: i.team,
      image: i.image,
      scan: i.scan,
      scannedAt: iso(i.scannedAt),
      fixable: i.fixable,
      unfixable: i.unfixable,
      secrets: i.secrets,
      acceptedReason: i.acceptedReason,
    })),
  };
}

export interface MetricsView {
  hours: { hour: string | null; started: number; waitP95Seconds: number }[];
  failures: { code: string; count: number; retried: boolean; means: string }[];
  products: { product: string; action: string; team: string; steps: number; succeeded: number; p50Seconds: number; p95Seconds: number }[];
  ready: number;
  running: number;
}

/** One alerting rule, as the Prometheus the console reads has it now. */
export interface AlertRuleView {
  name: string;
  severity: string;
  /** Its summary for no one instance, what varies left out. */
  summary: string;
  state: "inactive" | "pending" | "firing";
  instances: { state: string; activeAt: string | null; summary: string; description: string; labels: Record<string, string> }[];
  /** Pending or firing for something the caller can't see. */
  hidden: number;
}

export interface AlertsView {
  /** Whether the console reads a Prometheus at all. */
  configured: boolean;
  problem: string;
  checkedAt: string | null;
  rules: AlertRuleView[];
}

/** The install's alerts: the charts' rules, firing first (ObserveService.ListAlerts). */
export async function listAlerts(): Promise<AlertsView> {
  const a = await call(() => observe.listAlerts({}));
  return {
    configured: a.configured,
    problem: a.problem,
    checkedAt: iso(a.checkedAt),
    rules: a.rules.map((r) => ({
      name: r.name,
      severity: r.severity,
      summary: r.summary,
      state: r.state === "firing" || r.state === "pending" ? r.state : "inactive",
      instances: r.instances.map((i) => ({ state: i.state, activeAt: iso(i.activeAt), summary: i.summary, description: i.description, labels: { ...i.labels } })),
      hidden: r.hidden,
    })),
  };
}

/** Steps started and their waits by hour, why steps failed, and each product's step times. */
export async function getMetrics(): Promise<MetricsView> {
  const m = await call(() => observe.getMetrics({}));
  return {
    hours: m.hours.map((h) => ({ hour: iso(h.hour), started: h.started, waitP95Seconds: h.waitP95Seconds })),
    failures: m.failures.map((f) => ({ code: f.code, count: f.count, retried: f.retried, means: f.means })),
    products: m.products.map((p) => ({
      product: p.product,
      action: p.action,
      team: p.team,
      steps: p.steps,
      succeeded: p.succeeded,
      p50Seconds: p.p50Seconds,
      p95Seconds: p.p95Seconds,
    })),
    ready: m.ready,
    running: m.running,
  };
}

export interface UsageCount {
  /** A product, or a team ("" for runs started for no team). */
  name: string;
  count: number;
}

export interface TeamUsageView {
  /** "" for runs started for no team. */
  team: string;
  runs: number;
  /** In the period before, as long. */
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

export interface ProductUsageView {
  product: string;
  team: string;
  action: string;
  registered: boolean;
  steps: number;
  runs: number;
  usedBy: UsageCount[];
  lastUsed: string | null;
}

export interface UsageView {
  since: string | null;
  days: number;
  /** The runs the caller sees, each once however many teams it counts for; in the period before; their steps. */
  runs: number;
  previousRuns: number;
  steps: number;
  teams: TeamUsageView[];
  products: ProductUsageView[];
}

/** Who ran what over the last `days` (1, 7 or 30), as far as the caller may see (ObserveService.GetUsage). */
export async function getUsage(days: 1 | 7 | 30): Promise<UsageView> {
  const u = await call(() => observe.getUsage({ days }));
  const counts = (list: { name: string; count: number }[]) => list.map((c) => ({ name: c.name, count: c.count }));
  return {
    since: iso(u.since),
    days: u.days,
    runs: u.runs,
    previousRuns: u.previousRuns,
    steps: u.steps,
    teams: u.teams.map((t) => ({
      team: t.team,
      runs: t.runs,
      previousRuns: t.previousRuns,
      byPeople: t.byPeople,
      byBots: t.byBots,
      bySchedules: t.bySchedules,
      steps: t.steps,
      used: counts(t.used),
      ranFor: counts(t.ranFor),
    })),
    products: u.products.map((p) => ({
      product: p.product,
      team: p.team,
      action: p.action,
      registered: p.registered,
      steps: p.steps,
      runs: p.runs,
      usedBy: counts(p.usedBy),
      lastUsed: iso(p.lastUsed),
    })),
  };
}

export interface AuditEntryView {
  id: string;
  at: string | null;
  actorEmail: string | null;
  actorIsBot: boolean;
  route: string;
  target: Record<string, unknown>;
  status: number;
}

export interface AuditPage {
  entries: AuditEntryView[];
  /** Pass as `before` for the next page; "" on the last. */
  nextBefore: string;
}

/** Who changed what: everything for an admin; for anyone else their own, and what was done to their teams and runs. */
export async function listAudit(filters: { before?: string; team?: string; mine?: boolean; refusedOnly?: boolean }): Promise<AuditPage> {
  const page = await call(() =>
    observe.listAudit({
      before: BigInt(filters.before || 0),
      team: filters.team ?? "",
      mine: filters.mine ?? false,
      refusedOnly: filters.refusedOnly ?? false,
    }),
  );
  return {
    entries: page.entries.map((e) => ({
      id: String(e.id),
      at: iso(e.at),
      actorEmail: e.actorEmail ?? null,
      actorIsBot: e.actorIsBot,
      route: e.route,
      target: (e.target ?? {}) as Record<string, unknown>,
      status: e.status,
    })),
    nextBefore: page.nextBefore ? String(page.nextBefore) : "",
  };
}

export interface LogLineView {
  at: string | null;
  team: string;
  executionId: string;
  task: string;
  attempt: number;
  level: string;
  app: string;
  line: string;
}

export interface LogSearch {
  text?: string;
  team?: string;
  executionId?: string;
  level?: string;
  source?: "step" | "api" | "platform";
  /** With source api: one API product's backend, by name. */
  api?: string;
  /** How far back, in hours, from now. */
  hours: number;
}

/** Steps' and API backends' logs as the caller may see them (and the platform's, for admins). Throws ApiError LOGS_OFF when none are kept. */
export async function searchLogs(search: LogSearch): Promise<{ lines: LogLineView[]; truncated: boolean; searchDays: number }> {
  const found = await call(() =>
    observe.searchLogs({
      text: search.text ?? "",
      team: search.team ?? "",
      executionId: search.executionId ?? "",
      level: search.level ?? "",
      source: search.source ?? "",
      api: search.api ?? "",
      since: timestampFromDate(new Date(Date.now() - search.hours * 3_600_000)),
      limit: 500,
    }),
  );
  return {
    lines: found.lines.map((l) => ({
      at: iso(l.at),
      team: l.team,
      executionId: l.executionId,
      task: l.task,
      attempt: l.attempt,
      level: l.level,
      app: l.app,
      line: l.line,
    })),
    truncated: found.truncated,
    searchDays: found.searchDays,
  };
}

/** Something a run made, as its step reported it (proto/vertra/console/v1/resource.proto). */
export interface MadeResource {
  id: string;
  type: string;
  externalId: string;
  name: string | null;
  link: string | null;
  product: string;
  productTeam: string;
  /** The team it was made for; null when for whoever ran it alone. */
  ownerTeam: string | null;
  ownerEmail: string | null;
  executionId: string;
  taskId: string;
  firstReportedAt: string;
  state: "exists" | "deleting" | "delete_failed" | "deleted";
  deletingExecutionId: string | null;
  deletedAt: string | null;
  canDelete: boolean;
  /** What its step provided, by wiring type. */
  provides: { type: string; value: string; output: string }[];
  /** What it depends on, and what still depends on it (decision 25), of what you may see. */
  dependsOn: ResourceRef[];
  dependents: ResourceRef[];
  /** Live dependents you may not see. */
  hiddenDependents: number;
}

/** Another resource, at the end of a dependency. */
export interface ResourceRef {
  id: string;
  type: string;
  externalId: string;
  name: string | null;
  executionId: string;
  input: string;
}

function resourceRef(r: { id: string; type: string; externalId: string; name: string; executionId: string; input: string }): ResourceRef {
  return { id: r.id, type: r.type, externalId: r.externalId, name: r.name || null, executionId: r.executionId, input: r.input };
}

export async function listResources(filter: { executionId?: string; team?: string; query?: string; includeDeleted?: boolean; ids?: string[] }): Promise<MadeResource[]> {
  const { resources } = await call(() => resourcesApi.listResources(filter));
  return resources.map((r) => ({
    id: r.id,
    type: r.type,
    externalId: r.externalId,
    name: r.name || null,
    link: r.link || null,
    product: r.product,
    productTeam: r.productTeam,
    ownerTeam: r.ownerTeam || null,
    ownerEmail: r.ownerEmail || null,
    executionId: r.executionId,
    taskId: r.taskId,
    firstReportedAt: iso(r.firstReportedAt) ?? "",
    state: r.state as MadeResource["state"],
    deletingExecutionId: r.deletingExecutionId || null,
    deletedAt: iso(r.deletedAt),
    canDelete: r.canDelete,
    provides: r.provides.map((p) => ({ type: p.type, value: p.value, output: p.output })),
    dependsOn: r.dependsOn.map(resourceRef),
    dependents: r.dependents.map(resourceRef),
    hiddenDependents: r.hiddenDependents,
  }));
}

/** A delete waiting for an admin because others depended on it, or one decided. */
export interface DeleteRequest {
  id: string;
  resources: ResourceRef[];
  dependents: ResourceRef[];
  ownerTeam: string | null;
  requestedBy: string | null;
  createdAt: string;
  decision: "approved" | "denied" | "deleted" | null;
  decidedBy: string | null;
  executionId: string | null;
}

/** Waiting deletes and recent decisions: every one for an admin, else your own. */
export async function listDeleteRequests(): Promise<DeleteRequest[]> {
  const { requests } = await call(() => resourcesApi.listDeleteRequests({}));
  return requests.map((r) => ({
    id: r.id,
    resources: r.resources.map(resourceRef),
    dependents: r.dependents.map(resourceRef),
    ownerTeam: r.ownerTeam || null,
    requestedBy: r.requestedBy || null,
    createdAt: iso(r.createdAt) ?? "",
    decision: (r.decision || null) as DeleteRequest["decision"],
    decidedBy: r.decidedBy || null,
    executionId: r.executionId || null,
  }));
}

/** An admin approves (the cleanup run's id) or denies a waiting delete. */
export async function decideDeleteRequest(id: string, approve: boolean): Promise<string | null> {
  return (await call(() => resourcesApi.decideDeleteRequest({ id, approve }))).executionId || null;
}

/** Deletes resources made for one team; returns the cleanup run. */
export async function deleteResources(resourceIds: string[]): Promise<string> {
  return (await call(() => resourcesApi.deleteResources({ resourceIds }))).executionId;
}

/** Deletes what a run made that's still there, newest first; returns the cleanup run. */
export async function deleteRunResources(executionId: string): Promise<string> {
  return (await call(() => resourcesApi.deleteRunResources({ executionId }))).executionId;
}

/** Something you'd want to know (proto/vertra/console/v1/notification.proto). */
export interface Notification {
  id: string;
  kind: "run_failed" | "run_succeeded" | "approval_waiting" | "catalog_failing" | "product_not_ready" | "step_refused" | "platform_alert";
  title: string;
  body: string;
  /** The console page it's about; null when it's about nothing in particular. */
  link: string | null;
  createdAt: string;
  read: boolean;
}

export async function listNotifications(): Promise<{ notifications: Notification[]; unreadCount: number }> {
  const response = await call(() => notificationsApi.listNotifications({}));
  return {
    notifications: response.notifications.map((n) => ({
      id: n.id,
      kind: n.kind as Notification["kind"],
      title: n.title,
      body: n.body,
      link: n.link || null,
      createdAt: iso(n.createdAt) ?? "",
      read: n.read,
    })),
    unreadCount: response.unreadCount,
  };
}

export async function markNotificationsRead(ids: string[] | "all"): Promise<void> {
  await call(() => notificationsApi.markNotificationsRead(ids === "all" ? { all: true } : { ids }));
}

/** A team's chat webhook, as its members see it: never its URL. */
export interface TeamWebhook {
  configured: boolean;
  host: string;
  kinds: string[];
  lastSentAt: string | null;
  lastError: string | null;
}

function webhookOf(w: { configured: boolean; host: string; kinds: string[]; lastSentAt?: Parameters<typeof iso>[0]; lastError: string } | undefined): TeamWebhook {
  return { configured: w?.configured ?? false, host: w?.host ?? "", kinds: w?.kinds ?? [], lastSentAt: iso(w?.lastSentAt), lastError: w?.lastError || null };
}

export async function getTeamWebhook(team: string): Promise<{ webhook: TeamWebhook; allowedHosts: string[]; adminChannel: boolean }> {
  const response = await call(() => notificationsApi.getTeamWebhook({ team }));
  return { webhook: webhookOf(response.webhook), allowedHosts: response.allowedHosts, adminChannel: response.adminChannel };
}

/** The team whose webhook also gets admins' alerts; "" for none (admins only). */
export async function getAdminChannel(): Promise<string> {
  return (await call(() => notificationsApi.getAdminChannel({}))).team;
}

export async function setAdminChannel(team: string): Promise<string> {
  return (await call(() => notificationsApi.setAdminChannel({ team }))).team;
}

/** Sets it: a new URL, or (url "") only the kinds. */
export async function setTeamWebhook(team: string, url: string, kinds: string[]): Promise<TeamWebhook> {
  return webhookOf((await call(() => notificationsApi.setTeamWebhook({ team, url, kinds }))).webhook);
}

export interface TeamCallback {
  configured: boolean;
  host: string;
  lastSentAt: string | null;
  lastError: string | null;
}

function teamCallbackOf(c: { configured: boolean; host: string; lastSentAt?: Parameters<typeof iso>[0]; lastError: string } | undefined): TeamCallback {
  return { configured: c?.configured ?? false, host: c?.host ?? "", lastSentAt: iso(c?.lastSentAt), lastError: c?.lastError || null };
}

/** A team's outcome webhook (for its systems), and the hosts this install allows. */
export async function getTeamCallback(team: string): Promise<{ callback: TeamCallback; allowedHosts: string[] }> {
  const response = await call(() => notificationsApi.getTeamCallback({ team }));
  return { callback: teamCallbackOf(response.callback), allowedHosts: response.allowedHosts };
}

/** Sets (or, with an empty url, removes) it; the signing secret only when it's new. */
export async function setTeamCallback(team: string, url: string, rotateSecret: boolean): Promise<string> {
  return (await call(() => notificationsApi.setTeamCallback({ team, url, rotateSecret }))).signingSecret;
}

export async function deleteTeamWebhook(team: string): Promise<void> {
  await call(() => notificationsApi.deleteTeamWebhook({ team }));
}

export async function testTeamWebhook(team: string): Promise<{ sent: boolean; error: string }> {
  const { sent, error } = await call(() => notificationsApi.testTeamWebhook({ team }));
  return { sent, error };
}

/** Steps a preview left out, and why. */
export interface NotPreviewed {
  step: string;
  why: string;
}

/** Previews a runnable with these inputs: a run of its plan actions. */
export async function previewRunnable(
  runnable: Pick<Runnable, "kind" | "team" | "name">,
  parameters: Record<string, unknown>,
  onBehalfOf?: string,
): Promise<{ executionId: string; notPreviewed: NotPreviewed[] }> {
  const values = parameters as JsonObject;
  if (runnable.kind === "template") {
    const { executionId, notPreviewed } = await call(() => templates.previewTemplate({ team: runnable.team, name: runnable.name, parameters: values, onBehalfOf }));
    return { executionId, notPreviewed: notPreviewed.map((n) => ({ step: n.step, why: n.why })) };
  }
  const { executionId } = await call(() => templates.previewAction({ product: runnable.name, inputs: values, onBehalfOf }));
  return { executionId, notPreviewed: [] };
}

/** Previews a step waiting for an approval; returns the preview run. */
export async function previewStep(executionId: string, taskId: string): Promise<string> {
  return (await call(() => executions.previewStep({ executionId, taskId }))).executionId;
}

/** A team's schedule (proto/vertra/console/v1/schedule.proto). */
export interface Schedule {
  id: string;
  team: string;
  name: string;
  kind: "template" | "action";
  runnableTeam: string;
  runnableName: string;
  parameters: Record<string, unknown>;
  cron: string;
  timeZone: string;
  botId: string;
  botEmail: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastExecutionId: string | null;
  lastError: string | null;
}

type ScheduleMessage = Awaited<ReturnType<typeof schedulesApi.listSchedules>>["schedules"][number];

function scheduleOf(s: ScheduleMessage | undefined): Schedule {
  return {
    id: s?.id ?? "",
    team: s?.team ?? "",
    name: s?.name ?? "",
    kind: s?.kind === "template" ? "template" : "action",
    runnableTeam: s?.runnableTeam ?? "",
    runnableName: s?.runnableName ?? "",
    parameters: (s?.parameters ?? {}) as Record<string, unknown>,
    cron: s?.cron ?? "",
    timeZone: s?.timeZone ?? "UTC",
    botId: s?.botId ?? "",
    botEmail: s?.botEmail ?? "",
    enabled: s?.enabled ?? false,
    nextRunAt: iso(s?.nextRunAt),
    lastRunAt: iso(s?.lastRunAt),
    lastExecutionId: s?.lastExecutionId || null,
    lastError: s?.lastError || null,
  };
}

export async function listSchedules(team: string): Promise<Schedule[]> {
  return (await call(() => schedulesApi.listSchedules({ team }))).schedules.map(scheduleOf);
}

export async function createSchedule(input: {
  team: string;
  name: string;
  runnable: Pick<Runnable, "kind" | "team" | "name">;
  parameters: Record<string, unknown>;
  cron: string;
  timeZone: string;
  botId: string;
}): Promise<Schedule> {
  const { schedule } = await call(() =>
    schedulesApi.createSchedule({
      team: input.team,
      name: input.name,
      kind: input.runnable.kind,
      runnableTeam: input.runnable.team,
      runnableName: input.runnable.name,
      parameters: input.parameters as JsonObject,
      cron: input.cron,
      timeZone: input.timeZone,
      botId: input.botId,
    }),
  );
  return scheduleOf(schedule);
}

export async function updateSchedule(
  id: string,
  change: { enabled?: boolean; cron?: string; timeZone?: string; botId?: string; parameters?: Record<string, unknown> },
): Promise<Schedule> {
  const { parameters, ...rest } = change;
  return scheduleOf((await call(() => schedulesApi.updateSchedule({ id, ...rest, ...(parameters ? { parameters: parameters as JsonObject } : {}) }))).schedule);
}

export async function deleteSchedule(id: string): Promise<void> {
  await call(() => schedulesApi.deleteSchedule({ id }));
}

/** A CI identity a bot signs in with, instead of a stored token. */
export interface BotIdentity {
  id: string;
  botId: string;
  botEmail: string;
  issuer: string;
  claims: Record<string, string>;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export async function listBotIdentities(team: string): Promise<{ identities: BotIdentity[]; issuers: string[]; audience: string }> {
  const r = await call(() => tokens.listBotIdentities({ team }));
  return {
    identities: r.identities.map((i) => ({ id: i.id, botId: i.botId, botEmail: i.botEmail, issuer: i.issuer, claims: { ...i.claims }, createdAt: iso(i.createdAt), lastUsedAt: iso(i.lastUsedAt) })),
    issuers: r.issuers,
    audience: r.audience,
  };
}

/** A bot that signs in only from CI, keyless: no token, made with its identity. */
export async function createKeylessBot(
  team: string,
  email: string,
  issuer: string,
  claims: Record<string, string>,
  orderTemplates?: string[],
): Promise<{ email: string; identityId: string }> {
  const ordering = orderTemplates !== undefined;
  const made = await call(() => tokens.createKeylessBot({ team, email, issuer, claims, ordering, orderTemplates: orderTemplates ?? [] }));
  return { email: made.email, identityId: made.identity?.id ?? "" };
}

export async function addBotIdentity(team: string, botId: string, issuer: string, claims: Record<string, string>): Promise<void> {
  await call(() => tokens.addBotIdentity({ team, botId, issuer, claims }));
}

export async function removeBotIdentity(id: string): Promise<void> {
  await call(() => tokens.removeBotIdentity({ id }));
}

/** What anyone signed in may know of a team (TeamService.GetTeamProfile). */
export interface TeamProfile {
  name: string;
  fromCatalog: boolean;
  retired: boolean;
  contact: string | null;
  /** team.yaml's owner in the catalog (a GitHub user or team). */
  owner: string | null;
  /** team.yaml's description, from the catalog; null for a team made here. */
  description: string | null;
  helpChat: string | null;
  helpUrl: string | null;
  people: number;
}

export async function getTeamProfile(name: string): Promise<TeamProfile> {
  const r = await call(() => teams.getTeamProfile({ name }));
  return { name: r.name, fromCatalog: r.fromCatalog, retired: r.retired, contact: r.contact || null, owner: r.owner || null, description: r.description || null, helpChat: r.helpChat || null, helpUrl: r.helpUrl || null, people: r.people };
}

/** What an admin's list of teams shows of each: owner and description (null when the catalog gives none), people, Pods running. */
export interface TeamSummary {
  name: string;
  owner: string | null;
  description: string | null;
  people: number;
  /** Null when the cluster couldn't be asked. */
  running: number | null;
}

export async function listTeamSummaries(): Promise<TeamSummary[]> {
  const r = await call(() => teams.listTeamSummaries({}));
  return r.teams.map((t) => ({ name: t.name, owner: t.owner || null, description: t.description || null, people: t.people, running: t.running ?? null }));
}

export async function getEmailPreferences(): Promise<{ available: boolean; kinds: string[] }> {
  const r = await call(() => notificationsApi.getEmailPreferences({}));
  return { available: r.available, kinds: r.kinds };
}

export async function setEmailPreferences(kinds: string[]): Promise<string[]> {
  return (await call(() => notificationsApi.setEmailPreferences({ kinds }))).kinds;
}

/** One of Compose's drafts, as the console keeps it for its team. */
export interface StoredDraft {
  team: string;
  name: string;
  /** The Compose page's own state. */
  body: Record<string, unknown>;
  /** Counts its saves: a save names the one it changed. */
  version: number;
  updatedBy: string;
  updatedAt: string | null;
}

function storedDraftOf(d: DraftMessage | undefined): StoredDraft {
  return {
    team: d?.team ?? "",
    name: d?.name ?? "",
    body: (d?.body ?? {}) as Record<string, unknown>,
    version: Number(d?.version ?? 0),
    updatedBy: d?.updatedBy ?? "",
    updatedAt: iso(d?.updatedAt),
  };
}

/** The drafts of every team you're in (every team, for an admin), newest first. */
export async function listDrafts(): Promise<StoredDraft[]> {
  return (await call(() => draftsApi.listDrafts({}))).drafts.map(storedDraftOf);
}

/** Saves a draft: version 0 for a new one, else the version it changed (DRAFT_CHANGED if someone saved since). */
export async function saveDraft(input: { team: string; name: string; body: Record<string, unknown>; version: number }): Promise<StoredDraft> {
  return storedDraftOf((await call(() => draftsApi.saveDraft({ ...input, body: input.body as JsonObject, version: BigInt(input.version) }))).draft);
}

export async function deleteDraft(team: string, name: string): Promise<void> {
  await call(() => draftsApi.deleteDraft({ team, name }));
}

/** Single sign-on as admins set it up: the provider, and where groups come from. */
export interface SsoSettings {
  enabled: boolean;
  /** The install set the provider (the console chart's sso): issuer to label are read-only. */
  setByInstall: boolean;
  issuer: string;
  clientId: string;
  /** Whether a client secret is stored; it's never sent back. */
  clientSecretSet: boolean;
  redirectUrl: string;
  allowedDomains: string[];
  label: string;
  groupsClaim: string;
  googleGroups: boolean;
  updatedBy: string;
  updatedAt: string | null;
  /** The Google account this console reads groups as; "" off Google Cloud. */
  googleIdentity: string;
}

function ssoSettingsOf(s: SsoSettingsMessage | undefined): SsoSettings {
  return {
    enabled: s?.enabled ?? false,
    setByInstall: s?.setByInstall ?? false,
    issuer: s?.issuer ?? "",
    clientId: s?.clientId ?? "",
    clientSecretSet: s?.clientSecretSet ?? false,
    redirectUrl: s?.redirectUrl ?? "",
    allowedDomains: s?.allowedDomains ?? [],
    label: s?.label ?? "",
    groupsClaim: s?.groupsClaim ?? "",
    googleGroups: s?.googleGroups ?? false,
    updatedBy: s?.updatedBy ?? "",
    updatedAt: iso(s?.updatedAt),
    googleIdentity: s?.googleIdentity ?? "",
  };
}

export async function getSsoSettings(): Promise<SsoSettings> {
  return ssoSettingsOf((await call(() => ssoApi.getSsoSettings({}))).settings);
}

/** Saves them; an empty clientSecret keeps the stored one. Admins only. */
export async function setSsoSettings(input: Omit<SsoSettings, "setByInstall" | "clientSecretSet" | "updatedBy" | "updatedAt" | "googleIdentity"> & { clientSecret: string }): Promise<SsoSettings> {
  return ssoSettingsOf((await call(() => ssoApi.setSsoSettings(input))).settings);
}

export interface SsoGroupMapping {
  id: string;
  group: string;
  team: string;
  role: "maintainer" | "member";
}

export async function listSsoGroupMappings(): Promise<SsoGroupMapping[]> {
  return (await call(() => ssoApi.listSsoGroupMappings({}))).mappings.map((m) => ({
    id: m.id,
    group: m.group,
    team: m.team,
    role: m.role === TeamRole.MAINTAINER ? "maintainer" : "member",
  }));
}

export async function setSsoGroupMapping(group: string, team: string, role: "maintainer" | "member"): Promise<void> {
  await call(() => ssoApi.setSsoGroupMapping({ group, team, role: toTeamRole[role] }));
}

export async function deleteSsoGroupMapping(id: string): Promise<void> {
  await call(() => ssoApi.deleteSsoGroupMapping({ id }));
}

/** What the order builder couldn't settle: an input two outputs could fill, nothing providing a type, or a cycle. */
/** One way to fill an input: another step's output, something already there, or a new one (proto's OrderChoice). */
export interface OrderOption {
  step: string;
  input: string;
  fromStep?: string;
  fromOutput?: string;
  resourceId?: string;
  addNew?: boolean;
  label: string;
}

export interface OrderProblem {
  /** AMBIGUOUS, NO_PROVIDER, CHOOSE_EXISTING or CYCLE. */
  code: string;
  step: string;
  input: string;
  message: string;
  options: OrderOption[];
}

/** An optional input nothing fills, and what could: a provider to add, or something already there. */
export interface OrderSuggestion {
  step: string;
  input: string;
  wiringType: string;
  provider: string | null;
  existing: OrderOption[];
}

function option(o: { step: string; input: string; fromStep: string; fromOutput: string; resourceId: string; addNew: boolean; label: string }): OrderOption {
  return {
    step: o.step,
    input: o.input,
    ...(o.fromStep ? { fromStep: o.fromStep, fromOutput: o.fromOutput } : {}),
    ...(o.resourceId ? { resourceId: o.resourceId } : {}),
    ...(o.addNew ? { addNew: true } : {}),
    label: o.label || (o.fromStep ? `${o.fromStep}.${o.fromOutput}` : ""),
  };
}

const choiceOf = (o: OrderOption) => ({
  step: o.step,
  input: o.input,
  fromStep: o.fromStep ?? "",
  fromOutput: o.fromOutput ?? "",
  resourceId: o.resourceId ?? "",
  addNew: o.addNew ?? false,
});

/**
 * The order builder (decision 25): a cart of actions for `team`, wired by
 * wiring type, in the order they can run, with what it couldn't settle
 * (each with its options, to send back chosen) and what's suggested. Runs
 * nothing.
 */
export async function previewOrder(
  team: string,
  actions: string[],
  choices: OrderOption[] = [],
): Promise<{ steps: BuiltStep[]; problems: OrderProblem[]; suggestions: OrderSuggestion[] }> {
  const response = await call(() => ordersApi.previewOrder({ team, actions, choices: choices.map(choiceOf) }));
  return {
    steps: response.steps.map((s) => ({
      id: s.id,
      product: s.product,
      added: s.added,
      inputs: Object.fromEntries(
        Object.entries(s.inputs).map(([name, i]) => [name, { kind: i.kind, step: i.step, output: i.output, parameter: i.parameter, value: i.value }]),
      ),
    })),
    problems: response.problems.map((p) => ({ code: p.code, step: p.step, input: p.input, message: p.message, options: p.options.map(option) })),
    suggestions: response.suggestions.map((s) => ({ step: s.step, input: s.input, wiringType: s.wiringType, provider: s.provider || null, existing: s.existing.map(option) })),
  };
}

/** Places a cart as one run for `team`; its id. */
export async function placeOrder(order: {
  team: string;
  actions: string[];
  choices: OrderOption[];
  values: Record<string, Record<string, unknown>>;
  parameters: Record<string, unknown>;
  requestId: string;
}): Promise<string> {
  const response = await call(() =>
    ordersApi.placeOrder({
      team: order.team,
      actions: order.actions,
      choices: order.choices.map(choiceOf),
      values: order.values as JsonObject,
      parameters: order.parameters as JsonObject,
      requestId: order.requestId,
    }),
  );
  return response.executionId;
}

/** Whether the chat agent is on here, and its model (ChatService). */
export async function getChatSettings(): Promise<{ enabled: boolean; model: string }> {
  const r = await call(() => chatApi.getChatSettings({}));
  return { enabled: r.enabled, model: r.model };
}

/** A source an answer cites: a doc's section, linked by the console. */
export interface ChatCitation {
  id: string;
  title: string;
  heading: string;
  kind: string;
  link: string;
}

export interface ChatAnswer {
  text: string;
  citations: ChatCitation[];
  /** It found nothing to answer from: the text says so, in the console's words. */
  uncited: boolean;
  /** Not about Vertra: the text says what it helps with. */
  offTopic: boolean;
  /** How much of the chat's context window the conversation takes, 0 to 100. */
  contextPercent: number;
  cart: ProposedCart | null;
  steps: { tool: string; ok: boolean }[];
}

/** A cart the chat agent proposes: its actions, and the choices and values the person gave, for them to check and place. */
export interface ProposedCart {
  team: string;
  actions: string[];
  choices: OrderOption[];
  /** By step, then input. */
  values: Record<string, Record<string, unknown>>;
}

/**
 * The chat agent's answer to the conversation's last message, each step
 * it takes handed to `onStep` as it's taken (ChatService/AskStream).
 */
export async function askChatStream(
  team: string | null,
  messages: { role: "user" | "assistant"; content: string }[],
  onStep: (step: { tool: string; ok: boolean }) => void,
  signal: AbortSignal,
): Promise<ChatAnswer> {
  try {
    for await (const { event } of chatApi.askStream({ team: team ?? "", messages }, { signal })) {
      if (event.case === "step") onStep({ tool: event.value.tool, ok: event.value.ok });
      if (event.case === "answer") return chatAnswer(event.value);
    }
  } catch (error) {
    throw apiError(error);
  }
  throw new ApiError(502, "The answer didn't arrive.");
}

/** The chat agent's answer to the conversation's last message. */
export async function askChat(team: string | null, messages: { role: "user" | "assistant"; content: string }[]): Promise<ChatAnswer> {
  return chatAnswer(await call(() => chatApi.ask({ team: team ?? "", messages })));
}

function chatAnswer(r: AskResponse): ChatAnswer {
  return {
    text: r.text,
    citations: r.citations.map((c) => ({ id: c.id, title: c.title, heading: c.heading, kind: c.kind, link: c.link })),
    uncited: r.uncited,
    offTopic: r.offTopic,
    contextPercent: r.contextPercent,
    cart: r.cart
      ? {
          team: r.cart.team,
          actions: r.cart.actions,
          choices: r.cart.choices.map(option),
          values: Object.fromEntries(
            Object.entries(r.cart.values ?? {}).flatMap(([step, inputs]) =>
              typeof inputs === "object" && inputs !== null && !Array.isArray(inputs) ? [[step, inputs as Record<string, unknown>]] : [],
            ),
          ),
        }
      : null,
    steps: r.steps.map((s) => ({ tool: s.tool, ok: s.ok })),
  };
}

/** Thumbs up or down on an answer you got, sent with its question and answer, for the admins. */
export async function rateAnswer(rating: {
  rating: "up" | "down";
  team: string | null;
  question: string;
  answer: string;
  citations: ChatCitation[];
  steps: string[];
  model: string;
  comment: string;
}): Promise<void> {
  await call(() =>
    chatApi.rateAnswer({
      ...rating,
      team: rating.team ?? "",
      citations: rating.citations.map((c) => ({ id: c.id, guide: "", title: c.title, heading: c.heading, kind: c.kind, link: c.link })),
    }),
  );
}

/** A rating of a chat answer, for admins. */
/** The chat agent's model as it's set: the install's, or an admin's (never the key). */
export interface ChatConfig {
  source: "install" | "admins";
  enabled: boolean;
  provider: string;
  model: string;
  endpoint: string;
  vertexProject: string;
  vertexLocation: string;
  /** Bedrock's AWS region. */
  bedrockRegion: string;
  effort: string;
  maxSteps: number;
  contextTokens: number;
  maxTokens: number;
  keySet: boolean;
  /** Why an admin's settings can't be used now: chat is off meanwhile. */
  problem: string | null;
  updatedBy: string;
  updatedAt: string | null;
  installProvider: string;
  installModel: string;
}

/** Settings to save or try: numbers 0 for their defaults, the key empty to keep the one kept. */
export interface ChatConfigInput {
  enabled: boolean;
  provider: string;
  model: string;
  endpoint: string;
  vertexProject: string;
  vertexLocation: string;
  /** Bedrock's AWS region. */
  bedrockRegion: string;
  effort: string;
  maxSteps: number;
  contextTokens: number;
  maxTokens: number;
  apiKey: string;
}

export interface ChatTestResult {
  ok: boolean;
  problem: string;
  seconds: number;
  model: string;
  answer: string;
  citations: number;
}

function chatConfig(c: ChatConfigMessage | undefined): ChatConfig {
  return {
    source: c?.source === "admins" ? "admins" : "install",
    enabled: c?.enabled ?? false,
    provider: c?.provider ?? "",
    model: c?.model ?? "",
    endpoint: c?.endpoint ?? "",
    vertexProject: c?.vertexProject ?? "",
    vertexLocation: c?.vertexLocation ?? "",
    bedrockRegion: c?.bedrockRegion ?? "",
    effort: c?.effort ?? "",
    maxSteps: c?.maxSteps ?? 0,
    contextTokens: c?.contextTokens ?? 0,
    maxTokens: c?.maxTokens ?? 0,
    keySet: c?.keySet ?? false,
    problem: c?.problem || null,
    updatedBy: c?.updatedBy ?? "",
    updatedAt: iso(c?.updatedAt) ?? null,
    installProvider: c?.installProvider ?? "",
    installModel: c?.installModel ?? "",
  };
}

/** The chat agent's model as it's set (admins only). */
export async function getChatConfig(): Promise<ChatConfig> {
  return chatConfig((await call(() => chatApi.getChatConfig({}))).config);
}

/** An admin's own settings for the chat agent, in effect within seconds. */
export async function setChatConfig(config: ChatConfigInput): Promise<ChatConfig> {
  return chatConfig((await call(() => chatApi.setChatConfig({ config }))).config);
}

/** Back to the install's settings. */
export async function resetChatConfig(): Promise<ChatConfig> {
  return chatConfig((await call(() => chatApi.resetChatConfig({}))).config);
}

/** Settings tried before they're saved: one question through the agent. */
export async function testChatConfig(config: ChatConfigInput): Promise<ChatTestResult> {
  const r = await call(() => chatApi.testChatConfig({ config }));
  return { ok: r.ok, problem: r.problem, seconds: r.seconds, model: r.model, answer: r.answer, citations: r.citations };
}

export interface ChatRating {
  id: string;
  rating: "up" | "down";
  team: string | null;
  question: string;
  answer: string;
  citations: ChatCitation[];
  steps: string[];
  model: string;
  comment: string | null;
  email: string | null;
  createdAt: string;
}

/** The chat's ratings, newest first: admins only. */
export async function listChatFeedback(rating: "up" | "down" | null): Promise<ChatRating[]> {
  const { ratings } = await call(() => chatApi.listChatFeedback({ rating: rating ?? "" }));
  return ratings.map((r) => ({
    id: r.id,
    rating: r.rating === "up" ? "up" : "down",
    team: r.team || null,
    question: r.question,
    answer: r.answer,
    citations: r.citations.map((c) => ({ id: c.id, title: c.title, heading: c.heading, kind: c.kind, link: c.link })),
    steps: r.steps,
    model: r.model,
    comment: r.comment || null,
    email: r.email || null,
    createdAt: iso(r.createdAt) ?? "",
  }));
}
