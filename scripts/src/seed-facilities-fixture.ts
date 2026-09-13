/**
 * Seed the Firebase + Postgres fixture accounts that the
 * Facility Manager skin of the My Team tab end-to-end test plan
 * requires.
 *
 * Plan reference:
 *   artifacts/round-house/e2e/my-team-tab-message.test-plan.md
 *
 * Task #651: the My Team tab renders three different per-skin layouts
 * (homeowner / trade pro / facility manager). The homeowner and
 * trade-pro skins already have shared seeded fixtures
 * (`E2E_FIREBASE_*`, `E2E_COMPANY_ADMIN_*`), but the facilities branch
 * has had to be flagged as "deferred — needs facilities fixture"
 * whenever the plan is run. This script closes that gap by seeding a
 * facility-manager admin whose active outward account has
 * `kind = "facilities"` and a roster shaped to exercise both the
 * `Facility Teammates` group (accepted + pending teammate) and the
 * `Friends & Collaborators` row.
 *
 * What this script guarantees, idempotently:
 *   - Four Firebase Auth users exist (created on first run, signed in
 *     on subsequent runs to recover their uid):
 *       * E2E_FACILITIES_ADMIN_*    — Facility Manager. Owns
 *         "Facilities E2E Operations" (`facilities` outward account)
 *         and `users.activeOutwardAccountId` points at it.
 *       * E2E_FACILITIES_TEAMMATE_* — Accepted teammate on the admin's
 *         `user_team_members` row (status `accepted`, role `employee`).
 *       * E2E_FACILITIES_PENDING_*  — Pending teammate on the admin's
 *         `user_team_members` row (status `pending`, role `employee`).
 *       * E2E_FACILITIES_FRIEND_*   — Friend / collaborator. Owns one
 *         `collab` outward account and is the to-side of a
 *         `kind = "collaborator"` accepted `user_connections` row from
 *         the admin's facilities outward account, so they appear in
 *         the admin's `Friends & Collaborators` bucket.
 *   - A `users` row exists for each (onboarding marked complete and
 *     a placeholder `avatarUrl` so the router's identity gate doesn't
 *     bounce the admin into onboarding before the My Team tab loads).
 *   - The admin owns one `outward_accounts` row of kind `facilities`
 *     and one matching `user_modes` row whose `intake_data` carries
 *     the minimum fields the facilities intake schema declares
 *     (`operationKind` / `maintenanceGoals` / `teamSize`).
 *   - The friend owns one `outward_accounts` row of kind `collab`
 *     so the relationships endpoint resolves the connection's
 *     `to` side back to a real person record.
 *
 * Only the admin actually signs in for the test plan. The teammate
 * and friend accounts only need to exist as `users` rows so the
 * `/users/me/team` JOIN and the `/users/me/relationships`
 * outward-account resolution return them — their own credentials are
 * printed for completeness in case future plans want to sign in as
 * either side.
 *
 * The script PRINTS the email/password pairs at the end. It does NOT
 * write them into the project's environment itself — copy them into
 * the shared env vars / secrets manually after the first run.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run seed:facilities-fixture
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
  userConnectionsTable,
  userModesTable,
  usersTable,
  userTeamMembersTable,
  type UserModeKind,
} from "@workspace/db";

type FixtureKey = "ADMIN" | "TEAMMATE" | "PENDING" | "FRIEND";

interface Fixture {
  key: FixtureKey;
  emailEnv: string;
  passwordEnv: string;
  defaultEmail: string;
  displayName: string;
  username: string;
  /** When set, this user owns a primary outward account of this kind. */
  modeKind: UserModeKind | null;
  intakeData: Record<string, unknown> | null;
  outwardCompanyName: string | null;
}

const FACILITIES_COMPANY_NAME = "Facilities E2E Operations";

const FIXTURES: Fixture[] = [
  {
    key: "ADMIN",
    emailEnv: "E2E_FACILITIES_ADMIN_EMAIL",
    passwordEnv: "E2E_FACILITIES_ADMIN_PASSWORD",
    defaultEmail: "e2e-facilities-admin@roundhouse-e2e.test",
    displayName: "Facilities E2E Admin",
    username: "facilities_e2e_admin",
    modeKind: "facilities",
    intakeData: {
      // Mirrors the field keys declared by the `facilities` intake
      // schema in `artifacts/round-house/lib/intake-schemas.ts` so
      // the router treats the intake as complete.
      operationKind: "office",
      maintenanceGoals: ["preventive", "uptime"],
      teamSize: "2-5",
    },
    outwardCompanyName: FACILITIES_COMPANY_NAME,
  },
  {
    key: "TEAMMATE",
    emailEnv: "E2E_FACILITIES_TEAMMATE_EMAIL",
    passwordEnv: "E2E_FACILITIES_TEAMMATE_PASSWORD",
    defaultEmail: "e2e-facilities-teammate@roundhouse-e2e.test",
    displayName: "Facilities E2E Teammate",
    username: "facilities_e2e_teammate",
    modeKind: null,
    intakeData: null,
    outwardCompanyName: null,
  },
  {
    key: "PENDING",
    emailEnv: "E2E_FACILITIES_PENDING_EMAIL",
    passwordEnv: "E2E_FACILITIES_PENDING_PASSWORD",
    defaultEmail: "e2e-facilities-pending@roundhouse-e2e.test",
    displayName: "Facilities E2E Pending",
    username: "facilities_e2e_pending",
    modeKind: null,
    intakeData: null,
    outwardCompanyName: null,
  },
  {
    key: "FRIEND",
    emailEnv: "E2E_FACILITIES_FRIEND_EMAIL",
    passwordEnv: "E2E_FACILITIES_FRIEND_PASSWORD",
    defaultEmail: "e2e-facilities-friend@roundhouse-e2e.test",
    displayName: "Facilities E2E Friend",
    username: "facilities_e2e_friend",
    modeKind: "collab",
    intakeData: {
      // The `collab` intake is intentionally minimal — the friend
      // only needs to exist as a counterpart in the relationships
      // listing, not to drive any UI of their own.
      role: "friend",
    },
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
  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.clerkId, opts.clerkId));
  const baseSet = {
    email: opts.email,
    name: opts.displayName,
    username: opts.username,
    avatarUrl: AVATAR_URL,
    identityCompletedAt: new Date(),
  };
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
  // Match on `sourceUserModeId` in addition to (owner, kind) so we
  // never mutate an unrelated same-kind outward account that a
  // fixture user may have been manually given. The seeded mode is
  // upserted just before this call, so this id is stable across
  // re-runs of the script.
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
        // Match the standard fixture so paid-capability gates on
        // facilities-only screens (work orders, structured logs, etc.)
        // pass when the test plan extends past My Team.
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
 * Upsert a `user_team_members` row from `lead → member` in the
 * requested status. The My Team tab calls `/users/me/team`
 * (`useListMyTeam`), which inner-joins this table with `users`, so
 * both endpoints (and the TeamSection grouping) expect to find the
 * lead/member pair here — `team_seats` is a separate concept and is
 * not what the My Team tab renders.
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
 * Upsert an accepted `collaborator` connection from the admin's
 * facilities outward account → the friend's collab outward account.
 * The relationships endpoint (`/users/me/relationships`) is scoped to
 * `from = active outward account`, so we only need this one direction
 * for the friend to appear in the admin's `Friends & Collaborators`
 * bucket on the My Team tab.
 */
async function ensureFriendConnection(opts: {
  fromOutwardAccountId: number;
  toOutwardAccountId: number;
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
  if (existing) {
    await db
      .update(userConnectionsTable)
      .set({
        kind: "collaborator",
        status: "accepted",
        archivedAt: null,
        removedAt: null,
        respondedAt: new Date(),
        // `classification` must stay null so the bucketer routes the
        // row into Friends & Collaborators rather than Outside
        // Services (`isOutsideService` checks for "outside_service_provider").
        classification: null,
        cadence: "occasional",
        serviceTitle: null,
        onSiteIdentity: null,
        onSiteIdentityOther: null,
        chip: null,
        chipOther: null,
      })
      .where(eq(userConnectionsTable.id, existing.id));
    return existing.id;
  }
  const [created] = await db
    .insert(userConnectionsTable)
    .values({
      fromOutwardAccountId: opts.fromOutwardAccountId,
      toOutwardAccountId: opts.toOutwardAccountId,
      kind: "collaborator",
      status: "accepted",
      requestedAt: new Date(),
      respondedAt: new Date(),
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
      outwardAccountId = await ensureOutwardAccount({
        ownerClerkId: uid,
        kind: f.modeKind,
        companyName: f.outwardCompanyName,
        displayName: f.displayName,
        sourceUserModeId: modeId,
      });
      await setActivePointers({ clerkId: uid, modeId, outwardAccountId });
    }

    seeded.push({ ...f, email, password, uid, modeId, outwardAccountId });
  }

  const admin = seeded.find((s) => s.key === "ADMIN")!;
  const teammate = seeded.find((s) => s.key === "TEAMMATE")!;
  const pending = seeded.find((s) => s.key === "PENDING")!;
  const friend = seeded.find((s) => s.key === "FRIEND")!;

  if (admin.outwardAccountId == null) {
    throw new Error("Admin facilities outward account was not created.");
  }
  if (friend.outwardAccountId == null) {
    throw new Error("Friend collab outward account was not created.");
  }
  console.log(
    `\nFacilities outward account: id=${admin.outwardAccountId} (${FACILITIES_COMPANY_NAME}), kind=facilities, capability=expanded.`,
  );

  const acceptedRowId = await ensureTeamMembership({
    leadClerkId: admin.uid,
    memberClerkId: teammate.uid,
    status: "accepted",
    role: "employee",
  });
  const pendingRowId = await ensureTeamMembership({
    leadClerkId: admin.uid,
    memberClerkId: pending.uid,
    status: "pending",
    role: "employee",
  });
  console.log(
    `Team memberships: accepted id=${acceptedRowId} (${teammate.username}), pending id=${pendingRowId} (${pending.username}).`,
  );

  const friendConnectionId = await ensureFriendConnection({
    fromOutwardAccountId: admin.outwardAccountId,
    toOutwardAccountId: friend.outwardAccountId,
  });
  console.log(
    `Friends & Collaborators connection: id=${friendConnectionId} (admin facilities OA ${admin.outwardAccountId} → friend collab OA ${friend.outwardAccountId}, kind=collaborator).`,
  );

  console.log(
    "\nSeed complete. Copy the following into the project's shared env vars / secrets so test runners can sign in (this script does NOT write them itself):\n",
  );
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
    console.error("seed-facilities-fixture failed:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
