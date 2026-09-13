/**
 * Seed the Firebase + Postgres fixture accounts that the
 * picked-skin banner-swap end-to-end test plan requires.
 *
 * Plan reference:
 *   artifacts/round-house/e2e/picked-skin-banner-swap.test-plan.md
 *
 * Task #699 covers the public-profile hero banner: when
 * `PublicProfileModal` is opened with a `counterpartOutwardAccountId`,
 * the hero banner must be the picked skin's `bannerUrl` (set on
 * `outward_accounts`) — falling back to the underlying owner's
 * `intake.headerImageUrl` only when the picked skin has no banner of
 * its own, or when no skin was passed (legacy callers / business
 * search row). #678 already proved the avatar leg of this swap; this
 * plan proves the banner leg.
 *
 * What this script guarantees, idempotently:
 *   - Two Firebase Auth users exist:
 *       * E2E_PICKED_SKIN_OWNER_*   — Trade Pro owner. Has ONE
 *         `user_modes` row of kind `trade_pro` whose `intakeData`
 *         carries `headerImageUrl =
 *         "/objects/uploads/picked-skin-e2e-owner-intake-banner"` (the
 *         legacy "owner intake banner"), and TWO `outward_accounts`
 *         rows both of kind `trade_pro`, both pointing at that mode
 *         via `sourceUserModeId`:
 *           - "Picked Skin BannerCo E2E"   — `bannerUrl` set to
 *             "/objects/uploads/picked-skin-e2e-skin1-banner".
 *           - "Picked Skin NoBannerCo E2E" — `bannerUrl` cleared
 *             (NULL) so the modal must fall back to the owner's
 *             intake banner.
 *         `users.activeOutwardAccountId` is pinned to the BannerCo
 *         skin (the legacy `/users/:userId` path doesn't depend on
 *         which one — it reads from `lastActiveModeId`).
 *       * E2E_PICKED_SKIN_VISITOR_* — Homeowner visitor. Used solely
 *         to open the owner's public profile from a separate signed-in
 *         context (the Find tab is the entry point).
 *   - A `users` row exists for each (onboarding marked complete,
 *     placeholder avatar so router guards land sign-in on `/(tabs)`).
 *
 * Why two outward accounts on the SAME owner instead of two owners:
 *   The whole point of the picked-skin swap is that one HUMAN owner
 *   surfaces multiple distinct skins through `/users/search`, and the
 *   modal must paint each skin's own banner depending on which row the
 *   visitor tapped. Seeding two OAs for the same owner is the only
 *   shape that can exercise the OA-vs-owner precedence end to end:
 *
 *     | Visitor's entry point                             | counterpart OA | Expected banner src token                    |
 *     | ------------------------------------------------- | -------------- | -------------------------------------------- |
 *     | Find people → "Picked Skin BannerCo E2E"          | OA1 (banner)   | picked-skin-e2e-skin1-banner                 |
 *     | Find people → "Picked Skin NoBannerCo E2E"        | OA2 (no banner)| picked-skin-e2e-owner-intake-banner          |
 *     | Find a trade pro → "Picked Skin Owner Co E2E"     | none (legacy)  | picked-skin-e2e-owner-intake-banner          |
 *
 * The seeded paths are NOT real uploads; they're synthetic tokens we
 * pass through `outward_accounts.banner_url` /
 * `user_modes.intake_data.headerImageUrl`. `resolveStorageUrl` will
 * happily wrap them into a `${EXPO_PUBLIC_DOMAIN}/api/storage/...`
 * URL even if the underlying `/objects/uploads/...` path 404s — the
 * test asserts the URL TOKEN inside the `<img src>` attribute, not
 * that the image itself loads. (PublicProfileModal renders the
 * `<Image>` regardless of whether the URL eventually 404s; the
 * banner element itself is always present so the assertion is robust.)
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run seed:picked-skin-banner-fixtures
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

type FixtureKey = "OWNER" | "VISITOR";

interface Fixture {
  key: FixtureKey;
  emailEnv: string;
  passwordEnv: string;
  defaultEmail: string;
  displayName: string;
  username: string;
  modeKind: UserModeKind | null;
  intakeData: Record<string, unknown> | null;
}

// Synthetic banner-path tokens. The test asserts these substrings
// inside the rendered `<img src>` attribute, so they're chosen to be
// distinctive (won't collide with anything else in the modal).
const OWNER_INTAKE_BANNER_PATH = "/objects/uploads/picked-skin-e2e-owner-intake-banner";
const SKIN1_BANNER_PATH = "/objects/uploads/picked-skin-e2e-skin1-banner";

const OWNER_INTAKE_DATA: Record<string, unknown> = {
  companyName: "Picked Skin Owner Co E2E",
  ownerName: "Picked Skin Owner E2E",
  businessEmail: "e2e-picked-skin-owner@roundhouse-e2e.test",
  businessPhone: "555-0210",
  businessAddress: "1 Picked Skin Way",
  trade: "plumber",
  experience: "5-10",
  region: "Test Region",
  primaryZip: "10001",
  services: [{ name: "Plumbing" }],
  // The legacy "owner intake banner" — what the modal falls back to
  // when the picked skin has no `bannerUrl` of its own, or when the
  // caller didn't pass a `counterpartOutwardAccountId` at all (e.g.
  // a Find-a-trade-pro business row tap).
  headerImageUrl: OWNER_INTAKE_BANNER_PATH,
};

const FIXTURES: Fixture[] = [
  {
    key: "OWNER",
    emailEnv: "E2E_PICKED_SKIN_OWNER_EMAIL",
    passwordEnv: "E2E_PICKED_SKIN_OWNER_PASSWORD",
    defaultEmail: "e2e-picked-skin-owner@roundhouse-e2e.test",
    displayName: "Picked Skin Owner E2E",
    username: "picked_skin_owner_e2e",
    modeKind: "trade_pro",
    intakeData: OWNER_INTAKE_DATA,
  },
  {
    key: "VISITOR",
    emailEnv: "E2E_PICKED_SKIN_VISITOR_EMAIL",
    passwordEnv: "E2E_PICKED_SKIN_VISITOR_PASSWORD",
    defaultEmail: "e2e-picked-skin-visitor@roundhouse-e2e.test",
    displayName: "Picked Skin Visitor E2E",
    username: "picked_skin_visitor_e2e",
    modeKind: "home",
    intakeData: {
      placeName: "Picked Skin E2E Home",
      matters: ["maintenance"],
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
    // Visibility map left at the default `{}`. The banner swap
    // doesn't read any visibility flag — `headerImageUrl` lives in
    // `intakeSnapshot`, which the public profile route surfaces
    // unconditionally for both self and non-self viewers.
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

/**
 * Upsert a single trade_pro outward account by (ownerClerkId, kind,
 * title) — `outward_accounts` doesn't enforce one-trade_pro-per-owner
 * uniqueness (that's the whole point: this owner has TWO), so we key
 * idempotency on the seeded title which is unique per skin.
 *
 * `bannerUrl` is set to the seed value (or explicitly cleared back
 * to NULL when `bannerUrl: null` is passed) so the OA-without-banner
 * fixture stays in a known-empty state across re-runs.
 */
async function ensureTradeProSkin(opts: {
  ownerClerkId: string;
  title: string;
  companyName: string;
  bannerUrl: string | null;
  sourceUserModeId: number;
}): Promise<number> {
  const existing = await db
    .select({ id: outwardAccountsTable.id })
    .from(outwardAccountsTable)
    .where(
      and(
        eq(outwardAccountsTable.ownerClerkId, opts.ownerClerkId),
        eq(outwardAccountsTable.kind, "trade_pro"),
        eq(outwardAccountsTable.title, opts.title),
        isNull(outwardAccountsTable.archivedAt),
      ),
    );
  if (existing[0]) {
    await db
      .update(outwardAccountsTable)
      .set({
        companyName: opts.companyName,
        displayName: opts.title,
        bannerUrl: opts.bannerUrl,
        sourceUserModeId: opts.sourceUserModeId,
      })
      .where(eq(outwardAccountsTable.id, existing[0].id));
    return existing[0].id;
  }
  const [created] = await db
    .insert(outwardAccountsTable)
    .values({
      ownerClerkId: opts.ownerClerkId,
      kind: "trade_pro",
      title: opts.title,
      displayName: opts.title,
      companyName: opts.companyName,
      bannerUrl: opts.bannerUrl,
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

interface SeededFixture extends Fixture {
  email: string;
  password: string;
  uid: string;
  modeId: number | null;
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

    const services = f.modeKind === "trade_pro" ? [{ name: "Plumbing" }] : [];
    await upsertUserRow({
      clerkId: uid,
      email,
      displayName: f.displayName,
      username: f.username,
      services,
    });

    let modeId: number | null = null;
    if (f.modeKind && f.intakeData) {
      modeId = await ensureMode({
        clerkId: uid,
        kind: f.modeKind,
        intakeData: f.intakeData,
      });
    }

    seeded.push({ ...f, email, password, uid, modeId });
  }

  const owner = seeded.find((s) => s.key === "OWNER")!;
  if (owner.modeId == null) {
    throw new Error("Owner trade_pro mode failed to seed.");
  }

  // Two trade_pro skins on the SAME owner — the test taps a different
  // people-search row per case to drive each precedence path.
  const skin1Id = await ensureTradeProSkin({
    ownerClerkId: owner.uid,
    title: "Picked Skin BannerCo E2E",
    companyName: "Picked Skin BannerCo E2E",
    bannerUrl: SKIN1_BANNER_PATH,
    sourceUserModeId: owner.modeId,
  });
  const skin2Id = await ensureTradeProSkin({
    ownerClerkId: owner.uid,
    title: "Picked Skin NoBannerCo E2E",
    companyName: "Picked Skin NoBannerCo E2E",
    bannerUrl: null,
    sourceUserModeId: owner.modeId,
  });

  // Pin the active pointers at one of the two — the legacy /users/:userId
  // path resolves the snapshot mode from `lastActiveModeId`, so this
  // ensures the business-search-row case (no `counterpartOutwardAccountId`)
  // also surfaces the trade_pro intake banner.
  await setActivePointers({
    clerkId: owner.uid,
    modeId: owner.modeId,
    outwardAccountId: skin1Id,
  });

  // Visitor (homeowner) doesn't need outward accounts of their own —
  // they only need a signed-in shape that lands on `/(tabs)` so the
  // Find tab is reachable.

  console.log(
    `\nSeeded skins for owner @${owner.username}:` +
      `\n  - id=${skin1Id} title="Picked Skin BannerCo E2E"   bannerUrl=${SKIN1_BANNER_PATH}` +
      `\n  - id=${skin2Id} title="Picked Skin NoBannerCo E2E" bannerUrl=NULL` +
      `\n  owner intake banner (headerImageUrl) = ${OWNER_INTAKE_BANNER_PATH}`,
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
    console.error("seed-picked-skin-banner-fixtures failed:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
