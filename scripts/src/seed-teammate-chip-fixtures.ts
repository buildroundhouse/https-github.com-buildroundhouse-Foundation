/**
 * Seed the Firebase + Postgres fixture accounts that the
 * teammate-chip-on-public-profile end-to-end test plan requires.
 *
 * Plan reference:
 *   artifacts/round-house/e2e/teammate-chip-public-profile.test-plan.md
 *
 * Task #558 covers the public-profile path: an admin uses
 * `ManageTeamModal` to set a teammate chip on an accepted
 * `user_team_members` row, and a separate visitor opens the lead's
 * `PublicProfileModal` (via the Find tab search) and sees the chip
 * rendered next to the teammate by `TeamSection`.
 *
 * What this script guarantees, idempotently:
 *   - Three Firebase Auth users exist:
 *       * E2E_TEAM_CHIP_ADMIN_*   — Trade Pro lead. Owns
 *         "Team Chip E2E Co" (`trade_pro` outward account) and has
 *         `users.visibility.team = true` so the
 *         `GET /users/:userId/team` route returns members to
 *         non-owner viewers (the route returns an empty list
 *         otherwise — see artifacts/api-server/src/routes/users.ts).
 *       * E2E_TEAM_CHIP_MEMBER_*  — Accepted teammate on the admin's
 *         `user_team_members` row (status `accepted`, role `employee`,
 *         chip + chipOther NULL so the test starts from a known-empty
 *         tag state).
 *       * E2E_TEAM_CHIP_VISITOR_* — Any signed-in user, used solely
 *         to open the admin's public profile from a different
 *         browser context.
 *   - A `users` row exists for each (onboarding marked complete).
 *   - The admin owns one `outward_accounts` row of kind `trade_pro`
 *     and `users.activeOutwardAccountId` points at it. The admin's
 *     `user_modes` row of kind `trade_pro` carries the minimum
 *     intake fields the relevant screens read.
 *   - The visitor is given a `home` skin so their /(tabs) lands on
 *     a homeowner experience and the Find tab is reachable.
 *   - The member only needs a signed-in shape so they appear in
 *     the admin's team list — no outward account is required.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run seed:teammate-chip-fixtures
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
  userModesTable,
  usersTable,
  userTeamMembersTable,
  type UserModeKind,
} from "@workspace/db";

type FixtureKey = "ADMIN" | "MEMBER" | "VISITOR";

interface Fixture {
  key: FixtureKey;
  emailEnv: string;
  passwordEnv: string;
  defaultEmail: string;
  displayName: string;
  username: string;
  modeKind: UserModeKind | null;
  intakeData: Record<string, unknown> | null;
  outwardCompanyName: string | null;
}

const FIXTURES: Fixture[] = [
  {
    key: "ADMIN",
    emailEnv: "E2E_TEAM_CHIP_ADMIN_EMAIL",
    passwordEnv: "E2E_TEAM_CHIP_ADMIN_PASSWORD",
    defaultEmail: "e2e-team-chip-admin@roundhouse-e2e.test",
    displayName: "Team Chip E2E Lead",
    username: "team_chip_e2e_lead",
    modeKind: "trade_pro",
    intakeData: {
      companyName: "Team Chip E2E Co",
      ownerName: "Team Chip E2E Lead",
      businessEmail: "e2e-team-chip-admin@roundhouse-e2e.test",
      businessPhone: "555-0200",
      businessAddress: "1 Team Chip Way",
      trade: "plumber",
      experience: "5-10",
      region: "Test Region",
      primaryZip: "10001",
      services: [{ name: "Plumbing" }],
    },
    outwardCompanyName: "Team Chip E2E Co",
  },
  {
    key: "MEMBER",
    emailEnv: "E2E_TEAM_CHIP_MEMBER_EMAIL",
    passwordEnv: "E2E_TEAM_CHIP_MEMBER_PASSWORD",
    defaultEmail: "e2e-team-chip-member@roundhouse-e2e.test",
    displayName: "Team Chip E2E Mate",
    username: "team_chip_e2e_mate",
    modeKind: null,
    intakeData: null,
    outwardCompanyName: null,
  },
  {
    key: "VISITOR",
    emailEnv: "E2E_TEAM_CHIP_VISITOR_EMAIL",
    passwordEnv: "E2E_TEAM_CHIP_VISITOR_PASSWORD",
    defaultEmail: "e2e-team-chip-visitor@roundhouse-e2e.test",
    displayName: "Team Chip E2E Visitor",
    username: "team_chip_e2e_visitor",
    modeKind: "home",
    intakeData: {
      placeName: "Team Chip E2E Home",
      matters: ["maintenance"],
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

async function upsertUserRow(opts: {
  clerkId: string;
  email: string;
  displayName: string;
  username: string;
  services: { name: string }[];
  // ADMIN must expose `team` to non-owner viewers so the public-profile
  // team route returns the seeded teammate.
  visibilityTeam: boolean;
}): Promise<void> {
  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.clerkId, opts.clerkId));
  const baseSet = {
    email: opts.email,
    name: opts.displayName,
    username: opts.username,
    identityCompletedAt: new Date(),
    // The profile-status hook treats an empty avatarUrl as "needs-identity"
    // and bounces the user into the onboarding identity screen. Seed a
    // non-empty placeholder so signed-in fixtures land on /(tabs).
    avatarUrl: "https://placehold.co/128x128/png?text=E2E",
    services: opts.services,
    visibility: { team: opts.visibilityTeam },
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
  const existing = await db
    .select({ id: outwardAccountsTable.id })
    .from(outwardAccountsTable)
    .where(
      and(
        eq(outwardAccountsTable.ownerClerkId, opts.ownerClerkId),
        eq(outwardAccountsTable.kind, opts.kind),
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
 * Upsert the admin → member team-membership row at status `accepted`,
 * role `employee`, with chip + chipOther cleared. The test then drives
 * `ManageTeamModal` → "Change chip" to set the chip from the UI.
 */
async function ensureAcceptedTeamMembership(opts: {
  leadClerkId: string;
  memberClerkId: string;
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
  if (existing) {
    await db
      .update(userTeamMembersTable)
      .set({
        role: "employee",
        status: "accepted",
        acceptedAt: new Date(),
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
      role: "employee",
      status: "accepted",
      acceptedAt: new Date(),
    })
    .returning({ id: userTeamMembersTable.id });
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

    const services =
      f.modeKind === "trade_pro" ? [{ name: "Plumbing" }] : [];
    await upsertUserRow({
      clerkId: uid,
      email,
      displayName: f.displayName,
      username: f.username,
      services,
      visibilityTeam: f.key === "ADMIN",
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
  const member = seeded.find((s) => s.key === "MEMBER")!;

  const teamRowId = await ensureAcceptedTeamMembership({
    leadClerkId: admin.uid,
    memberClerkId: member.uid,
  });

  console.log(
    `\nTeam membership: lead=${admin.username} member=${member.username} id=${teamRowId} (status=accepted, role=employee, chip=null).`,
  );

  console.log(
    "\nSeed complete. Copy the following into the project's shared env vars / secrets so test runners can sign in (this script does NOT write them itself):\n",
  );
  for (const s of seeded) {
    console.log(`  ${s.emailEnv}=${s.email}`);
  }
  console.log(
    "\nPassword rotation: this script does not change Firebase passwords. To rotate, reset the password from the Firebase console (or delete the user there), then re-run the script with the new value exported as the corresponding *_PASSWORD env var.",
  );
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("seed-teammate-chip-fixtures failed:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
