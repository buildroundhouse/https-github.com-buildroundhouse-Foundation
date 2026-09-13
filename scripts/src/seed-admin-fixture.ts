/**
 * Seed the Firebase + Postgres fixture account that the destructive-
 * confirms wardrobe-delete end-to-end test plan (Section A) requires.
 *
 * Plan reference:
 *   artifacts/round-house/e2e/destructive-confirms.test-plan.md
 *
 * What this script guarantees, idempotently:
 *   - One Firebase Auth user exists (created on first run, signed in
 *     on subsequent runs to recover their uid):
 *       * E2E_ADMIN_*   — a system admin (users.is_admin = true)
 *   - A `users` row exists for that uid with:
 *       * isAdmin = true (unlocks /account/wardrobe)
 *       * identityCompletedAt set + avatarUrl populated, so the root
 *         layout does NOT punt the operator into the identity-onboarding
 *         flow before they can navigate to /account/wardrobe.
 *
 * The script PRINTS the email/password pair at the end. It does NOT
 * write them into the project's environment itself — copy them into
 * the shared env vars / secrets manually after the first run.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run seed:admin-fixture
 *
 * Required env vars (already present on Replit):
 *   - DATABASE_URL
 *   - EXPO_PUBLIC_FIREBASE_API_KEY
 */
import { eq } from "drizzle-orm";
import { db, pool, usersTable } from "@workspace/db";

interface Fixture {
  emailEnv: string;
  passwordEnv: string;
  defaultEmail: string;
  displayName: string;
  username: string;
}

const FIXTURE: Fixture = {
  emailEnv: "E2E_ADMIN_EMAIL",
  passwordEnv: "E2E_ADMIN_PASSWORD",
  defaultEmail: "e2e-admin@roundhouse-e2e.test",
  displayName: "RH E2E Admin",
  username: "rh_e2e_admin",
};

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

async function upsertAdminUserRow(opts: {
  clerkId: string;
  email: string;
  displayName: string;
  username: string;
}): Promise<void> {
  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.clerkId, opts.clerkId));
  const baseFields = {
    email: opts.email,
    name: opts.displayName,
    username: opts.username,
    identityCompletedAt: new Date(),
    // Non-empty so the profile-status machine doesn't punt this fixture
    // into `needs-identity` (which would block /account/wardrobe).
    avatarUrl: "https://placehold.co/256x256?text=Admin",
    isAdmin: true,
  };
  if (existing[0]) {
    await db.update(usersTable).set(baseFields).where(eq(usersTable.clerkId, opts.clerkId));
    return;
  }
  await db.insert(usersTable).values({ clerkId: opts.clerkId, ...baseFields });
}

async function main(): Promise<void> {
  const email = process.env[FIXTURE.emailEnv]?.trim();
  if (!email) {
    throw new Error(`${FIXTURE.emailEnv} must be set; fixture passwords are not stored in source control.`);
  }
  const password = process.env[FIXTURE.passwordEnv]?.trim();
  if (!password) {
    throw new Error(`${FIXTURE.passwordEnv} must be set; fixture passwords are not stored in source control.`);
  }
  process.stdout.write(`Ensuring Firebase user ADMIN <${email}>... `);
  const uid = await ensureFirebaseUser(email, password);
  process.stdout.write(`uid=${uid}\n`);
  await upsertAdminUserRow({
    clerkId: uid,
    email,
    displayName: FIXTURE.displayName,
    username: FIXTURE.username,
  });

  console.log(
    "\nSeed complete. Copy the following into the project's shared env vars / secrets so test runners can sign in (this script does NOT write them itself):\n",
  );
  console.log(`  ${FIXTURE.emailEnv}=${email}`);
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
    console.error("seed-admin-fixture failed:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
