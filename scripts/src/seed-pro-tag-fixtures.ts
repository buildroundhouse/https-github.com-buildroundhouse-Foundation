/**
 * Seed the Firebase + Postgres fixture accounts that the per-client
 * pro-tag end-to-end test plan requires.
 *
 * Plan reference:
 *   artifacts/round-house/e2e/per-client-pro-tag.test-plan.md
 *
 * What this script guarantees, idempotently:
 *   - Two Firebase Auth users exist:
 *       * E2E_PRO_TAG_PRO_*    — Trade Pro
 *       * E2E_PRO_TAG_CLIENT_* — Homeowner client
 *   - A `users` row exists for each (onboarding marked complete).
 *   - Each owns one `outward_accounts` row of the right kind
 *     (`trade_pro` for the pro, `home` for the homeowner) and
 *     `users.activeOutwardAccountId` points at it.
 *   - Each has a `user_modes` row of the matching kind whose
 *     `intake_data` carries the minimum fields the relevant screens
 *     read (the pro gets at least one `services` entry — required
 *     by the pro-self-tag modal — plus `companyName`; the homeowner
 *     gets `placeName` / `matters`). `users.lastActiveModeId`
 *     points at it.
 *   - The pro's `users.services` jsonb includes the same service so
 *     `useGetMe().services` exposes it to the modal.
 *   - A single `user_connections` row exists between the pro's skin
 *     and the homeowner's skin, status `accepted`, with all tag
 *     fields cleared so the test can drive them through the UI from
 *     a known-empty starting state. The test plan documents which
 *     side initiates the row so the `serviceTitle` / `onSiteIdentity`
 *     PATCH authz lands on the correct caller.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run seed:pro-tag-fixtures
 *
 * Required env vars (already present on Replit):
 *   - DATABASE_URL
 *   - EXPO_PUBLIC_FIREBASE_API_KEY
 */
import { and, eq, isNull, or } from "drizzle-orm";
import {
  db,
  pool,
  outwardAccountsTable,
  userConnectionsTable,
  userModesTable,
  usersTable,
  type UserModeKind,
} from "@workspace/db";

type FixtureKey = "PRO" | "CLIENT";

interface Fixture {
  key: FixtureKey;
  emailEnv: string;
  passwordEnv: string;
  defaultEmail: string;
  displayName: string;
  username: string;
  modeKind: UserModeKind;
  intakeData: Record<string, unknown>;
  outwardCompanyName: string | null;
}

const PRO_SERVICE_NAME = "Plumbing";

const FIXTURES: Fixture[] = [
  {
    key: "PRO",
    emailEnv: "E2E_PRO_TAG_PRO_EMAIL",
    passwordEnv: "E2E_PRO_TAG_PRO_PASSWORD",
    defaultEmail: "e2e-pro-tag-pro@roundhouse-e2e.test",
    displayName: "Pro Tag E2E Pro",
    username: "pro_tag_e2e_pro",
    modeKind: "trade_pro",
    intakeData: {
      companyName: "Pro Tag E2E Co",
      ownerName: "Pro Tag E2E Pro",
      businessEmail: "e2e-pro-tag-pro@roundhouse-e2e.test",
      businessPhone: "555-0100",
      businessAddress: "1 E2E Way",
      trade: "plumber",
      experience: "5-10",
      region: "Test Region",
      primaryZip: "10001",
      services: [{ name: PRO_SERVICE_NAME }],
    },
    outwardCompanyName: "Pro Tag E2E Co",
  },
  {
    key: "CLIENT",
    emailEnv: "E2E_PRO_TAG_CLIENT_EMAIL",
    passwordEnv: "E2E_PRO_TAG_CLIENT_PASSWORD",
    defaultEmail: "e2e-pro-tag-client@roundhouse-e2e.test",
    displayName: "Pro Tag E2E Client",
    username: "pro_tag_e2e_client",
    modeKind: "home",
    intakeData: {
      placeName: "Pro Tag E2E Home",
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
}): Promise<void> {
  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.clerkId, opts.clerkId));
  if (existing[0]) {
    await db
      .update(usersTable)
      .set({
        email: opts.email,
        name: opts.displayName,
        username: opts.username,
        identityCompletedAt: new Date(),
        services: opts.services,
      })
      .where(eq(usersTable.clerkId, opts.clerkId));
    return;
  }
  await db.insert(usersTable).values({
    clerkId: opts.clerkId,
    email: opts.email,
    name: opts.displayName,
    username: opts.username,
    identityCompletedAt: new Date(),
    services: opts.services,
  });
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
 * Connection direction matters — `serviceTitle` / `onSiteIdentity` PATCH
 * authz requires the caller to be the *to-side* of the row. The pro is
 * the subject ("how I show up to this client"), so the row must have
 * `from = client_outward, to = pro_outward`. The plan walks the test
 * agent through tagging from the pro side via the clients tab; the
 * relationships endpoint surfaces this same row to the pro through
 * its from-side reciprocal listing, and the public-profile endpoint
 * surfaces it to the homeowner as `connection` when they view the
 * pro. Status is `accepted` and tag fields are NULL so the test
 * starts from a known-empty state.
 */
async function ensureClientToProConnection(opts: {
  clientOutwardAccountId: number;
  proOutwardAccountId: number;
}): Promise<number> {
  const [existing] = await db
    .select({ id: userConnectionsTable.id })
    .from(userConnectionsTable)
    .where(
      and(
        eq(userConnectionsTable.fromOutwardAccountId, opts.clientOutwardAccountId),
        eq(userConnectionsTable.toOutwardAccountId, opts.proOutwardAccountId),
      ),
    );
  if (existing) {
    await db
      .update(userConnectionsTable)
      .set({
        kind: "core",
        status: "accepted",
        archivedAt: null,
        removedAt: null,
        respondedAt: new Date(),
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
      fromOutwardAccountId: opts.clientOutwardAccountId,
      toOutwardAccountId: opts.proOutwardAccountId,
      kind: "core",
      status: "accepted",
      requestedAt: new Date(),
      respondedAt: new Date(),
    })
    .returning({ id: userConnectionsTable.id });
  return created.id;
}

/**
 * Mirror row so the pro's clients tab can list this homeowner. The
 * pro is from-side here and uses this row only for navigation — tag
 * edits go through the client→pro row, where the pro is to-side.
 */
async function ensureProToClientConnection(opts: {
  proOutwardAccountId: number;
  clientOutwardAccountId: number;
}): Promise<number> {
  const [existing] = await db
    .select({ id: userConnectionsTable.id })
    .from(userConnectionsTable)
    .where(
      and(
        eq(userConnectionsTable.fromOutwardAccountId, opts.proOutwardAccountId),
        eq(userConnectionsTable.toOutwardAccountId, opts.clientOutwardAccountId),
      ),
    );
  if (existing) {
    await db
      .update(userConnectionsTable)
      .set({
        kind: "client",
        status: "accepted",
        archivedAt: null,
        removedAt: null,
        respondedAt: new Date(),
      })
      .where(eq(userConnectionsTable.id, existing.id));
    return existing.id;
  }
  const [created] = await db
    .insert(userConnectionsTable)
    .values({
      fromOutwardAccountId: opts.proOutwardAccountId,
      toOutwardAccountId: opts.clientOutwardAccountId,
      kind: "client",
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
  modeId: number;
  outwardAccountId: number;
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
      f.modeKind === "trade_pro" ? [{ name: PRO_SERVICE_NAME }] : [];
    await upsertUserRow({
      clerkId: uid,
      email,
      displayName: f.displayName,
      username: f.username,
      services,
    });
    const modeId = await ensureMode({
      clerkId: uid,
      kind: f.modeKind,
      intakeData: f.intakeData,
    });
    const outwardAccountId = await ensureOutwardAccount({
      ownerClerkId: uid,
      kind: f.modeKind,
      companyName: f.outwardCompanyName,
      displayName: f.displayName,
      sourceUserModeId: modeId,
    });
    await setActivePointers({ clerkId: uid, modeId, outwardAccountId });

    seeded.push({ ...f, email, password, uid, modeId, outwardAccountId });
  }

  const pro = seeded.find((s) => s.key === "PRO")!;
  const client = seeded.find((s) => s.key === "CLIENT")!;

  // Wipe any stale rows in the OTHER directions so the pair has only
  // the two rows we just (re-)seeded.
  await db
    .delete(userConnectionsTable)
    .where(
      and(
        or(
          and(
            eq(userConnectionsTable.fromOutwardAccountId, pro.outwardAccountId),
            eq(userConnectionsTable.toOutwardAccountId, client.outwardAccountId),
          ),
          and(
            eq(userConnectionsTable.fromOutwardAccountId, client.outwardAccountId),
            eq(userConnectionsTable.toOutwardAccountId, pro.outwardAccountId),
          ),
        )!,
      ),
    );

  const clientToProId = await ensureClientToProConnection({
    clientOutwardAccountId: client.outwardAccountId,
    proOutwardAccountId: pro.outwardAccountId,
  });
  const proToClientId = await ensureProToClientConnection({
    proOutwardAccountId: pro.outwardAccountId,
    clientOutwardAccountId: client.outwardAccountId,
  });

  console.log(
    `\nConnections: client→pro id=${clientToProId} (kind=core, tag fields null), pro→client id=${proToClientId} (kind=client).`,
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
    console.error("seed-pro-tag-fixtures failed:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
