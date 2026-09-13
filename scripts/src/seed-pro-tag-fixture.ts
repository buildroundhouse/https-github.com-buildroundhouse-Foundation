/**
 * Seed the Firebase + Postgres fixtures the pro per-client tag end-to-end
 * test plan needs. Idempotent — safe to re-run.
 *
 * Plan reference:
 *   artifacts/round-house/e2e/pro-per-client-tag.test-plan.md
 *
 * What this script guarantees:
 *   - A Firebase Auth user `E2E_PRO_TAG_PRO_*` exists. Its `users` row
 *     is fully onboarded (avatarUrl + identityCompletedAt set) and
 *     carries two `services` entries so the pro-self-tag picker has
 *     something to choose from.
 *   - That pro owns one `outward_accounts` row of kind `trade_pro`,
 *     and `users.lastActiveModeId` / `users.activeOutwardAccountId`
 *     point at the matching `user_modes` row + outward account so the
 *     app lands on Timeline immediately after sign-in (no onboarding
 *     redirect).
 *   - A second Firebase Auth user `E2E_PRO_TAG_CLIENT_*` exists with a
 *     `users` row and one `outward_accounts` row of kind `home` to act
 *     as the connection target. The home user does NOT need to be
 *     onboarded — only the pro signs in during the test.
 *   - One `user_connections` row of kind `client`, status `accepted`,
 *     from the pro's outward → the client's outward, with all of the
 *     pro-self-tag fields (`serviceTitle`, `onSiteIdentity`,
 *     `onSiteIdentityOther`) cleared so the test can drive the
 *     "first time tag" branch on every run.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run seed:pro-tag-fixture
 *
 * Required env:
 *   - DATABASE_URL
 *   - EXPO_PUBLIC_FIREBASE_API_KEY
 */
import { and, eq } from "drizzle-orm";
import {
  db,
  pool,
  outwardAccountsTable,
  userConnectionsTable,
  userModesTable,
  usersTable,
} from "@workspace/db";

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
): Promise<{ ok: true; data: FirebaseAuthResult } | { ok: false; message: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const json = (await res.json()) as
    | FirebaseAuthResult
    | { error?: { message?: string } };
  if (!res.ok) {
    const message =
      (json as { error?: { message?: string } }).error?.message ??
      `HTTP ${res.status}`;
    return { ok: false, message };
  }
  return { ok: true, data: json as FirebaseAuthResult };
}

async function ensureFirebaseUser(email: string, password: string): Promise<string> {
  const signUp = await callFirebase(SIGN_UP_URL, email, password);
  if (signUp.ok) return signUp.data.localId;
  if (signUp.message === "EMAIL_EXISTS") {
    const signIn = await callFirebase(SIGN_IN_URL, email, password);
    if (signIn.ok) return signIn.data.localId;
    throw new Error(
      `Firebase user ${email} exists but the seeded password no longer matches (${signIn.message}). Reset it in the Firebase console, then re-run.`,
    );
  }
  throw new Error(`Firebase signUp failed for ${email}: ${signUp.message}`);
}

interface FixtureSpec {
  emailEnv: string;
  passwordEnv: string;
  defaultEmail: string;
  displayName: string;
  username: string;
}

const PRO: FixtureSpec = {
  emailEnv: "E2E_PRO_TAG_PRO_EMAIL",
  passwordEnv: "E2E_PRO_TAG_PRO_PASSWORD",
  defaultEmail: "e2e-pro-tag-pro@roundhouse-e2e.test",
  displayName: "Pro Tag E2E Pro",
  username: "pro_tag_e2e_pro",
};

const CLIENT: FixtureSpec = {
  emailEnv: "E2E_PRO_TAG_CLIENT_EMAIL",
  passwordEnv: "E2E_PRO_TAG_CLIENT_PASSWORD",
  defaultEmail: "e2e-pro-tag-client@roundhouse-e2e.test",
  displayName: "Pro Tag E2E Client",
  username: "pro_tag_e2e_client",
};

const PRO_SERVICES = [
  { name: "Plumbing" },
  { name: "HVAC" },
];

const COMPANY_NAME = "Pro Tag E2E Co.";

interface SeededUser {
  spec: FixtureSpec;
  email: string;
  password: string;
  uid: string;
}

async function seedFirebase(spec: FixtureSpec): Promise<SeededUser> {
  const email = process.env[spec.emailEnv]?.trim();
  if (!email) {
    throw new Error(`${spec.emailEnv} must be set; fixture passwords are not stored in source control.`);
  }
  const password = process.env[spec.passwordEnv]?.trim();
  if (!password) {
    throw new Error(`${spec.passwordEnv} must be set; fixture passwords are not stored in source control.`);
  }
  process.stdout.write(`Ensuring Firebase user <${email}>... `);
  const uid = await ensureFirebaseUser(email, password);
  process.stdout.write(`uid=${uid}\n`);
  return { spec, email, password, uid };
}

async function ensureUserRow(opts: {
  clerkId: string;
  email: string;
  displayName: string;
  username: string;
  fullyOnboarded: boolean;
  services?: { name: string }[];
}): Promise<void> {
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.clerkId, opts.clerkId));
  const patch: Record<string, unknown> = {
    email: opts.email,
    name: opts.displayName,
    username: opts.username,
  };
  if (opts.fullyOnboarded) {
    patch.identityCompletedAt = new Date();
    patch.avatarUrl = "https://example.com/avatar.png";
  }
  if (opts.services) {
    patch.services = opts.services;
  }
  if (existing) {
    await db.update(usersTable).set(patch).where(eq(usersTable.clerkId, opts.clerkId));
    return;
  }
  await db.insert(usersTable).values({
    clerkId: opts.clerkId,
    ...patch,
  } as typeof usersTable.$inferInsert);
}

async function ensureProMode(clerkId: string): Promise<number> {
  const existing = await db
    .select({ id: userModesTable.id })
    .from(userModesTable)
    .where(
      and(
        eq(userModesTable.userClerkId, clerkId),
        eq(userModesTable.kind, "trade_pro"),
      ),
    );
  if (existing[0]) {
    await db
      .update(userModesTable)
      .set({
        intakeCompletedAt: new Date(),
        intakeData: {
          companyName: COMPANY_NAME,
          ownerName: PRO.displayName,
          businessEmail: process.env[PRO.emailEnv] || PRO.defaultEmail,
          businessPhone: "555-0100",
          businessAddress: "1 Test Way",
          trade: "plumber",
          experience: "5+ years",
          region: "Test Region",
          primaryZip: "10001",
        },
      })
      .where(eq(userModesTable.id, existing[0].id));
    return existing[0].id;
  }
  const [row] = await db
    .insert(userModesTable)
    .values({
      userClerkId: clerkId,
      kind: "trade_pro",
      intakeCompletedAt: new Date(),
      intakeData: {
        companyName: COMPANY_NAME,
        ownerName: PRO.displayName,
        businessEmail: process.env[PRO.emailEnv] || PRO.defaultEmail,
        businessPhone: "555-0100",
        businessAddress: "1 Test Way",
        trade: "plumber",
        experience: "5+ years",
        region: "Test Region",
        primaryZip: "10001",
      },
    })
    .returning({ id: userModesTable.id });
  return row.id;
}

async function ensureOutwardAccount(opts: {
  ownerClerkId: string;
  kind: "trade_pro" | "home";
  companyName?: string;
  displayName: string;
}): Promise<number> {
  const existing = await db
    .select({ id: outwardAccountsTable.id })
    .from(outwardAccountsTable)
    .where(
      and(
        eq(outwardAccountsTable.ownerClerkId, opts.ownerClerkId),
        eq(outwardAccountsTable.kind, opts.kind),
      ),
    );
  if (existing[0]) {
    await db
      .update(outwardAccountsTable)
      .set({
        archivedAt: null,
        title: opts.companyName ?? opts.displayName,
        displayName: opts.displayName,
        companyName: opts.companyName ?? null,
      })
      .where(eq(outwardAccountsTable.id, existing[0].id));
    return existing[0].id;
  }
  const [row] = await db
    .insert(outwardAccountsTable)
    .values({
      ownerClerkId: opts.ownerClerkId,
      kind: opts.kind,
      title: opts.companyName ?? opts.displayName,
      displayName: opts.displayName,
      companyName: opts.companyName ?? null,
    })
    .returning({ id: outwardAccountsTable.id });
  return row.id;
}

async function ensureClientConnection(opts: {
  fromOutwardAccountId: number;
  toOutwardAccountId: number;
}): Promise<void> {
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
    // Reset the pro-self-tag fields so every test run starts from the
    // "no tag yet" branch, and clear any soft-archive from prior runs.
    await db
      .update(userConnectionsTable)
      .set({
        kind: "client",
        status: "accepted",
        archivedAt: null,
        serviceTitle: null,
        onSiteIdentity: null,
        onSiteIdentityOther: null,
      })
      .where(eq(userConnectionsTable.id, existing.id));
    return;
  }
  await db.insert(userConnectionsTable).values({
    fromOutwardAccountId: opts.fromOutwardAccountId,
    toOutwardAccountId: opts.toOutwardAccountId,
    kind: "client",
    status: "accepted",
  });
}

async function main(): Promise<void> {
  const pro = await seedFirebase(PRO);
  const client = await seedFirebase(CLIENT);

  await ensureUserRow({
    clerkId: pro.uid,
    email: pro.email,
    displayName: pro.spec.displayName,
    username: pro.spec.username,
    fullyOnboarded: true,
    services: PRO_SERVICES,
  });
  await ensureUserRow({
    clerkId: client.uid,
    email: client.email,
    displayName: client.spec.displayName,
    username: client.spec.username,
    fullyOnboarded: false,
  });

  const proModeId = await ensureProMode(pro.uid);
  const proOutwardId = await ensureOutwardAccount({
    ownerClerkId: pro.uid,
    kind: "trade_pro",
    companyName: COMPANY_NAME,
    displayName: COMPANY_NAME,
  });
  const clientOutwardId = await ensureOutwardAccount({
    ownerClerkId: client.uid,
    kind: "home",
    displayName: client.spec.displayName,
  });

  await db
    .update(usersTable)
    .set({
      lastActiveModeId: proModeId,
      activeOutwardAccountId: proOutwardId,
    })
    .where(eq(usersTable.clerkId, pro.uid));

  await ensureClientConnection({
    fromOutwardAccountId: proOutwardId,
    toOutwardAccountId: clientOutwardId,
  });

  console.log("\nSeed complete. Fixtures:");
  console.log(`  pro:    ${pro.email} (uid=${pro.uid}, outward_account=${proOutwardId})`);
  console.log(`  client: ${client.email} (uid=${client.uid}, outward_account=${clientOutwardId})`);
  console.log(
    "\nIf this is a first run, copy the following into project secrets:\n",
  );
  console.log(`  ${PRO.emailEnv}=${pro.email}`);
  console.log(`  ${CLIENT.emailEnv}=${client.email}`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("seed-pro-tag-fixture failed:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
