/**
 * Seed the Firebase + Postgres fixture accounts that the
 * Finder → operator-skin Connect flow end-to-end test plan
 * requires.
 *
 * Plan reference:
 *   artifacts/round-house/e2e/finder-operator-skin-connect.test-plan.md
 *
 * Task #680 covers the wiring shipped in #636 (one Finder row per
 * outward-account skin) and #671 (the operator-skin company / role
 * header chip on `PublicProfileModal`). The end-to-end test needs
 * a multi-skin operator the visitor can search up: a single owner
 * with two distinct non-collab outward accounts so the People
 * search returns one row per skin and tapping each row threads the
 * picked OA's id through the modal query → header chip.
 *
 * What this script guarantees, idempotently:
 *   - One Firebase Auth user exists (created on first run, signed
 *     in on subsequent runs to recover their uid):
 *       * E2E_OPERATOR_SKIN_OWNER_*  — Operator with two non-collab
 *         outward accounts:
 *           - "Operator E2E Game Room" (`facilities` kind)
 *           - "Operator E2E Workshop"  (`trade_pro` kind)
 *         `users.lastActiveModeId` + `users.activeOutwardAccountId`
 *         are pinned to the facilities skin so the user has a
 *         deterministic primary, but BOTH skins surface in search.
 *   - A `users` row exists for the operator with onboarding marked
 *     complete and a placeholder `avatarUrl`, plus
 *     `visibility.team = true` so non-self viewers can fetch
 *     `/api/users/:clerkId/team` if a future plan extends past the
 *     header-chip leg.
 *   - One `user_modes` + `outward_accounts` pair per kind
 *     (`facilities` and `trade_pro`), both with
 *     `capability_state = "expanded"` so paid-capability gates
 *     don't bounce a future plan that drives the operator skin
 *     directly. Both OAs carry a non-empty `companyName` so the
 *     search row's public face matches what the test asserts.
 *
 * The visitor side reuses the standard pre-onboarded fixture
 * (`E2E_FIREBASE_*`) — a homeowner with one `home` outward account.
 * No additional seed is required for the visitor.
 *
 * The script PRINTS the email/password pair at the end. It does NOT
 * write them into the project's environment itself — copy them into
 * the shared env vars / secrets manually after the first run.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run seed:operator-skin-fixture
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
  type UserModeKind,
} from "@workspace/db";

interface SkinSpec {
  kind: UserModeKind;
  companyName: string;
  intakeData: Record<string, unknown>;
}

const OWNER_EMAIL_ENV = "E2E_OPERATOR_SKIN_OWNER_EMAIL";
const OWNER_PASSWORD_ENV = "E2E_OPERATOR_SKIN_OWNER_PASSWORD";
const OWNER_DEFAULT_EMAIL = "e2e-operator-skin-owner@roundhouse-e2e.test";
const OWNER_DISPLAY_NAME = "Operator E2E Owner";
const OWNER_USERNAME = "operator_e2e_owner";

const GAME_ROOM_NAME = "Operator E2E Game Room";
const WORKSHOP_NAME = "Operator E2E Workshop";

const SKINS: SkinSpec[] = [
  {
    kind: "facilities",
    companyName: GAME_ROOM_NAME,
    intakeData: {
      // Mirrors the field keys declared by the `facilities` intake
      // schema in `artifacts/round-house/lib/intake-schemas.ts` so
      // the router treats the intake as complete.
      operationKind: "office",
      maintenanceGoals: ["preventive", "uptime"],
      teamSize: "2-5",
      companyName: GAME_ROOM_NAME,
    },
  },
  {
    kind: "trade_pro",
    companyName: WORKSHOP_NAME,
    intakeData: {
      // Minimum trade_pro intake fields per
      // `artifacts/round-house/lib/intake-schemas.ts`.
      trade: "general",
      experience: "5-10",
      companyName: WORKSHOP_NAME,
    },
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

async function upsertOwnerRow(opts: {
  clerkId: string;
  email: string;
}): Promise<void> {
  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.clerkId, opts.clerkId));
  const baseSet = {
    email: opts.email,
    name: OWNER_DISPLAY_NAME,
    username: OWNER_USERNAME,
    avatarUrl: AVATAR_URL,
    identityCompletedAt: new Date(),
    // Mirrors the seed-teammate-chip fixture: the team-list endpoint
    // honors this flag for non-self viewers. Defaulting it on now
    // lets future plan extensions exercise `/users/:clerkId/team`
    // without re-seeding.
    visibility: { team: true } as Record<string, boolean>,
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
  companyName: string;
  sourceUserModeId: number;
}): Promise<number> {
  // Match on `sourceUserModeId` in addition to (owner, kind) so we
  // never mutate an unrelated same-kind outward account that this
  // user may have been manually given.
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
  const setShape = {
    companyName: opts.companyName,
    displayName: opts.companyName,
    title: opts.companyName,
    sourceUserModeId: opts.sourceUserModeId,
    capabilityState: "expanded" as const,
  };
  if (existing[0]) {
    await db
      .update(outwardAccountsTable)
      .set(setShape)
      .where(eq(outwardAccountsTable.id, existing[0].id));
    return existing[0].id;
  }
  const [created] = await db
    .insert(outwardAccountsTable)
    .values({ ownerClerkId: opts.ownerClerkId, kind: opts.kind, ...setShape })
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

async function main(): Promise<void> {
  const email = process.env[OWNER_EMAIL_ENV]?.trim();
  if (!email) {
    throw new Error(`${OWNER_EMAIL_ENV} must be set; fixture passwords are not stored in source control.`);
  }
  const password = process.env[OWNER_PASSWORD_ENV]?.trim();
  if (!password) {
    throw new Error(`${OWNER_PASSWORD_ENV} must be set; fixture passwords are not stored in source control.`);
  }
  process.stdout.write(`Ensuring Firebase user OPERATOR_SKIN_OWNER <${email}>... `);
  const uid = await ensureFirebaseUser(email, password);
  process.stdout.write(`uid=${uid}\n`);

  await upsertOwnerRow({ clerkId: uid, email });

  const seededOAs: { kind: UserModeKind; companyName: string; modeId: number; outwardAccountId: number }[] =
    [];
  for (const skin of SKINS) {
    const modeId = await ensureMode({
      clerkId: uid,
      kind: skin.kind,
      intakeData: skin.intakeData,
    });
    const outwardAccountId = await ensureOutwardAccount({
      ownerClerkId: uid,
      kind: skin.kind,
      companyName: skin.companyName,
      sourceUserModeId: modeId,
    });
    seededOAs.push({ kind: skin.kind, companyName: skin.companyName, modeId, outwardAccountId });
  }

  // Pin the operator's "active" pointers at the facilities skin so
  // any surface that falls back to the active OA has a deterministic
  // landing skin. The Finder search itself does NOT depend on this
  // pointer — it returns one row per non-collab OA regardless.
  const facilities = seededOAs.find((s) => s.kind === "facilities")!;
  await setActivePointers({
    clerkId: uid,
    modeId: facilities.modeId,
    outwardAccountId: facilities.outwardAccountId,
  });

  console.log("\nSeeded operator outward accounts:");
  for (const oa of seededOAs) {
    console.log(
      `  - id=${oa.outwardAccountId}  kind=${oa.kind}  companyName="${oa.companyName}"  capability=expanded`,
    );
  }

  console.log(
    "\nSeed complete. Copy the following into the project's shared env vars / secrets so test runners can sign in (this script does NOT write them itself):\n",
  );
  console.log(`  ${OWNER_EMAIL_ENV}=${email}`);
  console.log(
    "\nVisitor side: the test plan reuses the standard pre-onboarded fixture (E2E_FIREBASE_EMAIL / E2E_FIREBASE_PASSWORD). No additional seed is required there — run `pnpm --filter @workspace/scripts run seed:standard-fixture` if those credentials don't exist yet.",
  );
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
    console.error("seed-operator-skin-fixture failed:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
