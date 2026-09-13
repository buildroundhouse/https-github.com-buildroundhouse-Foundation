/**
 * Seed the Firebase + Postgres fixture accounts the company-notice
 * Nudge plan AND the trade-pro skin of the My Team tab Message plan
 * both rely on.
 *
 * Plan references:
 *   artifacts/round-house/e2e/company-notice-nudge.test-plan.md
 *   artifacts/round-house/e2e/my-team-tab-message.test-plan.md
 *
 * What this script guarantees, idempotently:
 *   - Six Firebase Auth users exist (created on first run, signed in
 *     on subsequent runs to recover their uid):
 *       * E2E_COMPANY_ADMIN_*       — primary company admin (signs in)
 *       * E2E_COMPANY_MEMBER_*      — accepted teammate (the
 *         `user_team_members` row the My Team tab renders + a
 *         non-admin `team_seats` row for the company-notice plan)
 *       * E2E_COMPANY_ADMIN_2_*     — accepted secondary admin on the
 *         company-notice `team_seats` flow (used by step E)
 *       * E2E_COMPANY_PENDING_*     — pending teammate
 *         (`user_team_members.status = "pending"`) so the My Team tab's
 *         pending-vs-accepted Message-pill suppression has a row to
 *         exercise (see Case 3 of the my-team-tab-message plan)
 *       * E2E_COMPANY_CLIENT_*      — homeowner counterpart that the
 *         admin's trade_pro skin has an accepted `client` connection
 *         to (Clients bucket of the My Team tab)
 *       * E2E_COMPANY_SERVICE_*     — outside-service trade_pro
 *         counterpart that the admin's trade_pro skin has an accepted
 *         `core` connection to with `classification =
 *         "outside_service_provider"` (Outside Services bucket)
 *       * E2E_COMPANY_FRIEND_*      — friend / collaborator counterpart
 *         that the admin's trade_pro skin has an accepted
 *         `collaborator` connection to (Friends & Collaborators bucket)
 *   - A `users` row exists for each (placeholder `avatarUrl` so the
 *     router's identity gate doesn't bounce the admin into onboarding
 *     before the My Team tab loads).
 *   - The admin owns one `outward_accounts` row of kind `trade_pro`
 *     named "Nudge E2E Company" plus a matching `user_modes` row;
 *     `users.lastActiveModeId` and `users.activeOutwardAccountId`
 *     point at them so the active-skin resolver lands on the trade-pro
 *     skin and `companyKind === "trade_pro"` on the client.
 *   - `team_seats` rows seat the member (non-admin) and admin 2
 *     (isAdmin=true, manageTeam=true) on that company, both `accepted`
 *     and not removed.
 *   - `user_team_members` rows exist for the accepted teammate (lead =
 *     admin, member = MEMBER, status="accepted", role="employee") and
 *     the pending teammate (lead = admin, member = PENDING,
 *     status="pending", role="manager"). The My Team tab inner-joins
 *     `user_team_members` with `users` and renders these rows under
 *     the Trade Pro Teammates section.
 *   - `outward_accounts` rows exist for CLIENT (home), SERVICE
 *     (trade_pro), and FRIEND (collab) with matching `user_modes` so
 *     `/users/me/relationships` can resolve them to person records.
 *   - `user_connections` rows exist FROM the admin's trade_pro
 *     outward account TO each of CLIENT/SERVICE/FRIEND (status
 *     "accepted", with the right `kind` + `classification` for the
 *     bucket the row needs to land in).
 *
 * The script PRINTS the email/password pairs at the end. It does NOT
 * write them into the project's environment itself — copy them into
 * the shared env vars / secrets manually after the first run.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run seed:nudge-fixtures
 *
 * Required env vars (already present on Replit):
 *   - DATABASE_URL
 *   - EXPO_PUBLIC_FIREBASE_API_KEY
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  pool,
  outwardAccountsTable,
  teamSeatsTable,
  userConnectionsTable,
  userModesTable,
  usersTable,
  userTeamMembersTable,
  type ConnectionClassification,
  type ConnectionKind,
  type UserModeKind,
} from "@workspace/db";

type FixtureKey =
  | "ADMIN"
  | "MEMBER"
  | "ADMIN_2"
  | "PENDING"
  | "CLIENT"
  | "SERVICE"
  | "FRIEND";

interface Fixture {
  key: FixtureKey;
  emailEnv: string;
  passwordEnv: string;
  defaultEmail: string;
  displayName: string;
  username: string;
  /**
   * When set, this user owns a primary outward account of this kind
   * (with a matching `user_modes` row) so the relationships endpoint
   * can resolve their counterpart side back to a real person record.
   */
  modeKind: UserModeKind | null;
  intakeData: Record<string, unknown> | null;
  outwardCompanyName: string | null;
  /**
   * When true, the admin's `users.lastActiveModeId` /
   * `activeOutwardAccountId` are pinned to this fixture's mode +
   * outward account at the end of the run.
   */
  isAdminActive?: boolean;
}

const COMPANY_NAME = "Nudge E2E Company";

const FIXTURES: Fixture[] = [
  {
    key: "ADMIN",
    emailEnv: "E2E_COMPANY_ADMIN_EMAIL",
    passwordEnv: "E2E_COMPANY_ADMIN_PASSWORD",
    defaultEmail: "e2e-company-admin@roundhouse-e2e.test",
    displayName: "Nudge E2E Admin",
    username: "nudge_e2e_admin",
    modeKind: "trade_pro",
    intakeData: {
      // Mirrors the field keys the trade_pro intake schema declares
      // in `artifacts/round-house/lib/intake-schemas.ts` so the router
      // treats the intake as complete and lands the session on (tabs).
      ownerName: "Nudge E2E Admin",
      tradeKind: "general",
      teamSize: "2-5",
    },
    outwardCompanyName: COMPANY_NAME,
    isAdminActive: true,
  },
  {
    key: "MEMBER",
    emailEnv: "E2E_COMPANY_MEMBER_EMAIL",
    passwordEnv: "E2E_COMPANY_MEMBER_PASSWORD",
    defaultEmail: "e2e-company-member@roundhouse-e2e.test",
    displayName: "Nudge E2E Member",
    username: "nudge_e2e_member",
    modeKind: null,
    intakeData: null,
    outwardCompanyName: null,
  },
  {
    key: "ADMIN_2",
    emailEnv: "E2E_COMPANY_ADMIN_2_EMAIL",
    passwordEnv: "E2E_COMPANY_ADMIN_2_PASSWORD",
    defaultEmail: "e2e-company-admin-2@roundhouse-e2e.test",
    displayName: "Nudge E2E Admin 2",
    username: "nudge_e2e_admin_2",
    modeKind: null,
    intakeData: null,
    outwardCompanyName: null,
  },
  {
    key: "PENDING",
    emailEnv: "E2E_COMPANY_PENDING_EMAIL",
    passwordEnv: "E2E_COMPANY_PENDING_PASSWORD",
    defaultEmail: "e2e-company-pending@roundhouse-e2e.test",
    displayName: "Nudge E2E Pending",
    username: "nudge_e2e_pending",
    modeKind: null,
    intakeData: null,
    outwardCompanyName: null,
  },
  {
    key: "CLIENT",
    emailEnv: "E2E_COMPANY_CLIENT_EMAIL",
    passwordEnv: "E2E_COMPANY_CLIENT_PASSWORD",
    defaultEmail: "e2e-company-client@roundhouse-e2e.test",
    displayName: "Nudge E2E Client",
    username: "nudge_e2e_client",
    modeKind: "home",
    intakeData: {},
    outwardCompanyName: null,
  },
  {
    key: "SERVICE",
    emailEnv: "E2E_COMPANY_SERVICE_EMAIL",
    passwordEnv: "E2E_COMPANY_SERVICE_PASSWORD",
    defaultEmail: "e2e-company-service@roundhouse-e2e.test",
    displayName: "Nudge E2E Service",
    username: "nudge_e2e_service",
    modeKind: "trade_pro",
    intakeData: {
      ownerName: "Nudge E2E Service",
      tradeKind: "plumbing",
      teamSize: "1",
    },
    outwardCompanyName: "Nudge E2E Outside Service",
  },
  {
    key: "FRIEND",
    emailEnv: "E2E_COMPANY_FRIEND_EMAIL",
    passwordEnv: "E2E_COMPANY_FRIEND_PASSWORD",
    defaultEmail: "e2e-company-friend@roundhouse-e2e.test",
    displayName: "Nudge E2E Friend",
    username: "nudge_e2e_friend",
    modeKind: "collab",
    intakeData: { role: "friend" },
    outwardCompanyName: null,
  },
];

const FIREBASE_API_KEY = process.env.EXPO_PUBLIC_FIREBASE_API_KEY;
if (!FIREBASE_API_KEY) {
  throw new Error(
    "EXPO_PUBLIC_FIREBASE_API_KEY must be set so the script can talk to the Firebase Auth REST API.",
  );
}

const SIGN_UP_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`;
const SIGN_IN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;

interface FirebaseAuthResult {
  localId: string;
  email: string;
  idToken: string;
}

async function callFirebase(
  url: string,
  email: string,
  password: string,
): Promise<{ ok: true; data: FirebaseAuthResult } | { ok: false; code: string; message: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const json = (await res.json()) as
    | FirebaseAuthResult
    | { error?: { message?: string; code?: number } };
  if (!res.ok) {
    const message =
      (json as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
    return { ok: false, code: message, message };
  }
  return { ok: true, data: json as FirebaseAuthResult };
}

async function ensureFirebaseUser(email: string, password: string): Promise<string> {
  const signUp = await callFirebase(SIGN_UP_URL, email, password);
  if (signUp.ok) return signUp.data.localId;
  if (signUp.code === "EMAIL_EXISTS") {
    const signIn = await callFirebase(SIGN_IN_URL, email, password);
    if (signIn.ok) return signIn.data.localId;
    throw new Error(
      `Firebase user ${email} already exists but the seeded password no longer matches (${signIn.message}). Reset it in the Firebase console or rotate the *_PASSWORD env var, then re-run.`,
    );
  }
  throw new Error(`Firebase signUp failed for ${email}: ${signUp.message}`);
}

// Tiny inline transparent PNG. The router gate treats any non-empty
// avatarUrl as "identity complete" so a placeholder is enough to land
// the fixture on /(tabs).
const AVATAR_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function upsertUserRow(opts: {
  clerkId: string;
  email: string;
  displayName: string;
  username: string;
}): Promise<void> {
  const baseSet = {
    email: opts.email,
    name: opts.displayName,
    username: opts.username,
    avatarUrl: AVATAR_URL,
    identityCompletedAt: new Date(),
  };
  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.clerkId, opts.clerkId));
  if (existing[0]) {
    await db.update(usersTable).set(baseSet).where(eq(usersTable.clerkId, opts.clerkId));
    return;
  }
  await db.insert(usersTable).values({ clerkId: opts.clerkId, ...baseSet });
}

async function ensureMode(opts: {
  clerkId: string;
  kind: UserModeKind;
  intakeData: Record<string, unknown>;
}): Promise<number> {
  const existing = await db
    .select({ id: userModesTable.id })
    .from(userModesTable)
    .where(
      and(eq(userModesTable.userClerkId, opts.clerkId), eq(userModesTable.kind, opts.kind)),
    );
  if (existing[0]) {
    await db
      .update(userModesTable)
      .set({ intakeData: opts.intakeData, intakeCompletedAt: new Date() })
      .where(eq(userModesTable.id, existing[0].id));
    return existing[0].id;
  }
  const [created] = await db
    .insert(userModesTable)
    .values({
      userClerkId: opts.clerkId,
      kind: opts.kind,
      intakeData: opts.intakeData,
      intakeCompletedAt: new Date(),
    })
    .returning({ id: userModesTable.id });
  return created.id;
}

async function ensureOutwardAccount(opts: {
  ownerClerkId: string;
  kind: UserModeKind;
  companyName: string | null;
  displayName: string;
  sourceUserModeId: number;
}): Promise<number> {
  const existing = await db
    .select({ id: outwardAccountsTable.id })
    .from(outwardAccountsTable)
    .where(
      and(
        eq(outwardAccountsTable.ownerClerkId, opts.ownerClerkId),
        eq(outwardAccountsTable.kind, opts.kind),
        eq(outwardAccountsTable.sourceUserModeId, opts.sourceUserModeId),
        isNull(outwardAccountsTable.archivedAt),
      ),
    );
  if (existing[0]) {
    await db
      .update(outwardAccountsTable)
      .set({
        companyName: opts.companyName,
        displayName: opts.displayName,
        title: opts.companyName ?? opts.displayName,
        sourceUserModeId: opts.sourceUserModeId,
        capabilityState: "expanded",
      })
      .where(eq(outwardAccountsTable.id, existing[0].id));
    return existing[0].id;
  }
  const [created] = await db
    .insert(outwardAccountsTable)
    .values({
      ownerClerkId: opts.ownerClerkId,
      kind: opts.kind,
      title: opts.companyName ?? opts.displayName,
      displayName: opts.displayName,
      companyName: opts.companyName,
      sourceUserModeId: opts.sourceUserModeId,
      capabilityState: "expanded",
    })
    .returning({ id: outwardAccountsTable.id });
  return created.id;
}

async function setActivePointers(opts: {
  clerkId: string;
  modeId: number;
  outwardAccountId: number;
}): Promise<void> {
  await db
    .update(usersTable)
    .set({
      lastActiveModeId: opts.modeId,
      activeOutwardAccountId: opts.outwardAccountId,
    })
    .where(eq(usersTable.clerkId, opts.clerkId));
}

/**
 * The admin's pre-existing `Nudge E2E Company` outward account
 * (created by older runs of this script before mode wiring was added)
 * may have been seeded with `sourceUserModeId = null`. Promote it to
 * the new `trade_pro` mode so the admin's My Team tab actually
 * resolves to the trade-pro skin. Idempotent: a no-op if no such
 * orphan row exists.
 */
async function adoptLegacyTradeProAccount(opts: {
  ownerClerkId: string;
  modeId: number;
}): Promise<void> {
  await db
    .update(outwardAccountsTable)
    .set({ sourceUserModeId: opts.modeId })
    .where(
      and(
        eq(outwardAccountsTable.ownerClerkId, opts.ownerClerkId),
        eq(outwardAccountsTable.kind, "trade_pro"),
        isNull(outwardAccountsTable.sourceUserModeId),
        isNull(outwardAccountsTable.archivedAt),
      ),
    );
}

async function ensureTeamSeat(opts: {
  companyId: number;
  memberClerkId: string;
  isAdmin: boolean;
}): Promise<void> {
  const [existing] = await db
    .select({
      id: teamSeatsTable.id,
      isAdmin: teamSeatsTable.isAdmin,
      status: teamSeatsTable.status,
      removedAt: teamSeatsTable.removedAt,
    })
    .from(teamSeatsTable)
    .where(
      and(
        eq(teamSeatsTable.companyOutwardAccountId, opts.companyId),
        eq(teamSeatsTable.memberClerkId, opts.memberClerkId),
      ),
    );
  const permissions = opts.isAdmin
    ? {
        seeContacts: true,
        seeBilling: true,
        createOnProperties: true,
        manageTeam: true,
      }
    : {
        seeContacts: false,
        seeBilling: false,
        createOnProperties: false,
        manageTeam: false,
      };
  const role = opts.isAdmin ? ("admin" as const) : ("employee" as const);
  if (existing) {
    await db
      .update(teamSeatsTable)
      .set({
        isAdmin: opts.isAdmin,
        permissions,
        role,
        status: "accepted",
        acceptedAt: new Date(),
        removedAt: null,
      })
      .where(eq(teamSeatsTable.id, existing.id));
    return;
  }
  await db.insert(teamSeatsTable).values({
    companyOutwardAccountId: opts.companyId,
    memberClerkId: opts.memberClerkId,
    role,
    isAdmin: opts.isAdmin,
    permissions,
    status: "accepted",
    acceptedAt: new Date(),
  });
}

/**
 * Upsert a `user_team_members` row from `lead → member` in the
 * requested status. The My Team tab calls `/users/me/team`
 * (`useListMyTeam`), which inner-joins this table with `users`, so
 * the lead/member pair must live here for the row to render.
 * `team_seats` is a separate concept (used by the company-notice
 * Nudge plan); both tables are seeded so each plan sees the data
 * shape it expects.
 */
async function ensureTeamMembership(opts: {
  leadClerkId: string;
  memberClerkId: string;
  status: "accepted" | "pending";
  role: "employee" | "manager" | "partner";
}): Promise<number> {
  const [existing] = await db
    .select({ id: userTeamMembersTable.id })
    .from(userTeamMembersTable)
    .where(
      and(
        eq(userTeamMembersTable.leadClerkId, opts.leadClerkId),
        eq(userTeamMembersTable.memberClerkId, opts.memberClerkId),
      ),
    );
  const acceptedAt = opts.status === "accepted" ? new Date() : null;
  if (existing) {
    await db
      .update(userTeamMembersTable)
      .set({
        role: opts.role,
        status: opts.status,
        acceptedAt,
        chip: null,
        chipOther: null,
      })
      .where(eq(userTeamMembersTable.id, existing.id));
    return existing.id;
  }
  const [created] = await db
    .insert(userTeamMembersTable)
    .values({
      leadClerkId: opts.leadClerkId,
      memberClerkId: opts.memberClerkId,
      role: opts.role,
      status: opts.status,
      acceptedAt,
    })
    .returning({ id: userTeamMembersTable.id });
  return created.id;
}

/**
 * Upsert an accepted connection FROM the admin's trade_pro outward
 * account TO a counterpart's outward account. The relationships
 * endpoint is scoped to `from = active outward account`, so we only
 * need this one direction for the counterpart to appear in the
 * admin's bucket on the My Team tab.
 */
async function ensureConnection(opts: {
  fromOutwardAccountId: number;
  toOutwardAccountId: number;
  kind: ConnectionKind;
  classification: ConnectionClassification | null;
}): Promise<number> {
  const [existing] = await db
    .select({ id: userConnectionsTable.id })
    .from(userConnectionsTable)
    .where(
      and(
        eq(userConnectionsTable.fromOutwardAccountId, opts.fromOutwardAccountId),
        eq(userConnectionsTable.toOutwardAccountId, opts.toOutwardAccountId),
      ),
    );
  const baseSet = {
    kind: opts.kind,
    status: "accepted" as const,
    classification: opts.classification,
    archivedAt: null,
    removedAt: null,
    respondedAt: new Date(),
    cadence: "occasional" as const,
    serviceTitle: null,
    onSiteIdentity: null,
    onSiteIdentityOther: null,
    chip: null,
    chipOther: null,
  };
  if (existing) {
    await db
      .update(userConnectionsTable)
      .set(baseSet)
      .where(eq(userConnectionsTable.id, existing.id));
    return existing.id;
  }
  const [created] = await db
    .insert(userConnectionsTable)
    .values({
      fromOutwardAccountId: opts.fromOutwardAccountId,
      toOutwardAccountId: opts.toOutwardAccountId,
      requestedAt: new Date(),
      ...baseSet,
    })
    .returning({ id: userConnectionsTable.id });
  return created.id;
}

interface SeededFixture extends Fixture {
  email: string;
  password: string;
  uid: string;
  modeId: number | null;
  outwardAccountId: number | null;
}

async function main(): Promise<void> {
  const seeded: SeededFixture[] = [];
  for (const f of FIXTURES) {
    const email = process.env[f.emailEnv]?.trim();
    if (!email) {
      throw new Error(`${f.emailEnv} must be set; fixture passwords are not stored in source control.`);
    }
    const password = process.env[f.passwordEnv]?.trim();
    if (!password) {
      throw new Error(`${f.passwordEnv} must be set; fixture passwords are not stored in source control.`);
    }
    process.stdout.write(`Ensuring Firebase user ${f.key} <${email}>... `);
    const uid = await ensureFirebaseUser(email, password);
    process.stdout.write(`uid=${uid}\n`);
    await upsertUserRow({
      clerkId: uid,
      email,
      displayName: f.displayName,
      username: f.username,
    });

    let modeId: number | null = null;
    let outwardAccountId: number | null = null;
    if (f.modeKind && f.intakeData) {
      modeId = await ensureMode({
        clerkId: uid,
        kind: f.modeKind,
        intakeData: f.intakeData,
      });
      // For ADMIN, also adopt any legacy trade_pro outward account
      // that was created by an older run of this script before mode
      // wiring was added, so the post-mode ensureOutwardAccount call
      // matches the existing row instead of inserting a duplicate.
      if (f.key === "ADMIN") {
        await adoptLegacyTradeProAccount({ ownerClerkId: uid, modeId });
      }
      outwardAccountId = await ensureOutwardAccount({
        ownerClerkId: uid,
        kind: f.modeKind,
        companyName: f.outwardCompanyName,
        displayName: f.displayName,
        sourceUserModeId: modeId,
      });
      if (f.isAdminActive) {
        await setActivePointers({ clerkId: uid, modeId, outwardAccountId });
      }
    }

    seeded.push({ ...f, email, password, uid, modeId, outwardAccountId });
  }

  const admin = seeded.find((s) => s.key === "ADMIN")!;
  const member = seeded.find((s) => s.key === "MEMBER")!;
  const admin2 = seeded.find((s) => s.key === "ADMIN_2")!;
  const pendingTm = seeded.find((s) => s.key === "PENDING")!;
  const client = seeded.find((s) => s.key === "CLIENT")!;
  const service = seeded.find((s) => s.key === "SERVICE")!;
  const friend = seeded.find((s) => s.key === "FRIEND")!;

  if (admin.outwardAccountId == null) {
    throw new Error("Admin trade_pro outward account was not created.");
  }
  console.log(
    `\nTrade Pro outward account: id=${admin.outwardAccountId} (${COMPANY_NAME}), kind=trade_pro.`,
  );

  // team_seats — the company-notice Nudge plan reads from this table.
  await ensureTeamSeat({ companyId: admin.outwardAccountId, memberClerkId: member.uid, isAdmin: false });
  await ensureTeamSeat({ companyId: admin.outwardAccountId, memberClerkId: admin2.uid, isAdmin: true });

  // user_team_members — the My Team tab reads from this table.
  const acceptedTeammateRowId = await ensureTeamMembership({
    leadClerkId: admin.uid,
    memberClerkId: member.uid,
    status: "accepted",
    role: "employee",
  });
  const pendingTeammateRowId = await ensureTeamMembership({
    leadClerkId: admin.uid,
    memberClerkId: pendingTm.uid,
    status: "pending",
    role: "manager",
  });
  console.log(
    `Team memberships: accepted utm.id=${acceptedTeammateRowId} (${member.username}), pending utm.id=${pendingTeammateRowId} (${pendingTm.username}).`,
  );

  if (client.outwardAccountId == null) throw new Error("Client home outward account was not created.");
  if (service.outwardAccountId == null) throw new Error("Service trade_pro outward account was not created.");
  if (friend.outwardAccountId == null) throw new Error("Friend collab outward account was not created.");

  const clientConnId = await ensureConnection({
    fromOutwardAccountId: admin.outwardAccountId,
    toOutwardAccountId: client.outwardAccountId,
    kind: "client",
    classification: null,
  });
  const serviceConnId = await ensureConnection({
    fromOutwardAccountId: admin.outwardAccountId,
    toOutwardAccountId: service.outwardAccountId,
    kind: "core",
    classification: "outside_service_provider",
  });
  const friendConnId = await ensureConnection({
    fromOutwardAccountId: admin.outwardAccountId,
    toOutwardAccountId: friend.outwardAccountId,
    kind: "collaborator",
    classification: null,
  });
  console.log(
    `Connections from admin trade_pro OA ${admin.outwardAccountId}:\n` +
      `  Client (kind=client) id=${clientConnId} → ${client.username}\n` +
      `  Outside Service (kind=core, outside_service_provider) id=${serviceConnId} → ${service.username}\n` +
      `  Friend (kind=collaborator) id=${friendConnId} → ${friend.username}`,
  );

  console.log("\nSeed complete. Copy the following into the project's shared env vars / secrets so test runners can sign in (this script does NOT write them itself):\n");
  for (const s of seeded) {
    console.log(`  ${s.emailEnv}=${s.email}`);
  }
  console.log(
    "\nPassword rotation: this script does not change Firebase passwords. To rotate, reset the password from the Firebase console (or delete the user there), then re-run the script with the new value exported as the corresponding *_PASSWORD env var — signUp will pick up the new password on the next run.",
  );
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("seed-nudge-fixtures failed:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
