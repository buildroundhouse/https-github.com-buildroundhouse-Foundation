/**
 * Seed the Firebase + Postgres fixture accounts that the
 * picked-skin avatar-swap end-to-end test plan requires.
 *
 * Plan reference:
 *   artifacts/round-house/e2e/picked-skin-avatar-swap.test-plan.md
 *
 * Task #712 covers the public-profile hero AVATAR swap (the very
 * first half of the picked-skin contract from #678): when
 * `PublicProfileModal` is opened with a `counterpartOutwardAccountId`,
 * the hero avatar must be the picked skin's `avatarUrl` (set on
 * `outward_accounts`) — falling back to the underlying owner's
 * `users.avatarUrl` only when the picked skin has no avatar of its
 * own, or when no skin was passed (legacy callers / business search
 * row). Mirrors the structure of #699's banner-swap seed.
 *
 * What this script guarantees, idempotently:
 *   - Two Firebase Auth users exist:
 *       * E2E_PICKED_SKIN_AVATAR_OWNER_*   — Trade Pro owner. Has ONE
 *         `user_modes` row of kind `trade_pro` whose `intakeData`
 *         provides the Work snapshot (trade / region / etc.) and
 *         deliberately does NOT carry a banner so the modal renders
 *         the no-banner avatar layout (`heroBlock` inline avatar).
 *         The `users.avatarUrl` column carries the legacy "owner
 *         intake avatar" token —
 *         "/objects/uploads/picked-skin-e2e-avatar-owner-intake-avatar"
 *         — which is what the modal falls back to when no OA was
 *         passed or the picked OA has no avatar of its own. TWO
 *         `outward_accounts` rows are seeded, both of kind
 *         `trade_pro` and both pointing at that mode via
 *         `sourceUserModeId`:
 *           - "Picked Skin AvatarCo E2E"   — `avatarUrl` set to
 *             "/objects/uploads/picked-skin-e2e-avatar-skin1-avatar".
 *           - "Picked Skin NoAvatarCo E2E" — `avatarUrl` cleared
 *             (NULL) so the modal must fall back to the owner's
 *             intake avatar.
 *         `users.activeOutwardAccountId` is pinned to the AvatarCo
 *         skin (the legacy `/users/:userId` path doesn't depend on
 *         which one — it reads from `lastActiveModeId`).
 *       * E2E_PICKED_SKIN_AVATAR_VISITOR_* — Homeowner visitor. Used
 *         solely to open the owner's public profile from a separate
 *         signed-in context (the Find tab is the entry point).
 *   - A `users` row exists for each (onboarding marked complete,
 *     non-empty avatarUrl so router guards land sign-in on `/(tabs)`).
 *
 * Why two outward accounts on the SAME owner instead of two owners:
 *   The whole point of the picked-skin swap is that one HUMAN owner
 *   surfaces multiple distinct skins through `/users/search`, and the
 *   modal must paint each skin's own avatar depending on which row the
 *   visitor tapped. Seeding two OAs for the same owner is the only
 *   shape that can exercise the OA-vs-owner precedence end to end:
 *
 *     | Visitor's entry point                             | counterpart OA | Expected avatar src token                    |
 *     | ------------------------------------------------- | -------------- | -------------------------------------------- |
 *     | Find people → "Picked Skin AvatarCo E2E"          | OA1 (avatar)   | picked-skin-e2e-avatar-skin1-avatar          |
 *     | Find people → "Picked Skin NoAvatarCo E2E"        | OA2 (no avatar)| picked-skin-e2e-avatar-owner-intake-avatar   |
 *     | Find a trade pro → "Picked Skin Avatar Owner Co E2E" | none (legacy) | picked-skin-e2e-avatar-owner-intake-avatar |
 *
 * The seeded paths are NOT real uploads; they're synthetic tokens we
 * pass through `outward_accounts.avatar_url` / `users.avatar_url`.
 * `resolveStorageUrl` will happily wrap them into a
 * `${EXPO_PUBLIC_DOMAIN}/api/storage/...` URL even if the underlying
 * `/objects/uploads/...` path 404s — the test asserts the URL TOKEN
 * inside the `data-uri` attribute on the hero <img>, not that the
 * image itself loads. (PublicProfileModal renders the `<Image>`
 * regardless of whether the URL eventually 404s; the avatar element
 * itself is always present so the assertion is robust.)
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run seed:picked-skin-avatar-fixtures
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
  // Per-fixture override for the seeded `users.avatarUrl`. The owner
  // uses a synthetic token so the modal's avatar-fallback path is
  // observable; the visitor uses a placehold.co URL so the signed-in
  // router guard (`identityCompletedAt && avatarUrl`) lets them
  // through to `/(tabs)`.
  avatarUrl: string;
}

// Synthetic avatar-path tokens. The test asserts these substrings
// inside the rendered `data-uri` attribute of the hero <img>, so
// they're chosen to be distinctive (won't collide with anything else
// in the modal nor with the banner seed's tokens).
const OWNER_INTAKE_AVATAR_PATH =
  "/objects/uploads/picked-skin-e2e-avatar-owner-intake-avatar";
const SKIN1_AVATAR_PATH = "/objects/uploads/picked-skin-e2e-avatar-skin1-avatar";

const OWNER_INTAKE_DATA: Record<string, unknown> = {
  companyName: "Picked Skin Avatar Owner Co E2E",
  ownerName: "Picked Skin Avatar Owner E2E",
  businessEmail: "e2e-picked-skin-avatar-owner@roundhouse-e2e.test",
  businessPhone: "555-0220",
  businessAddress: "1 Picked Skin Avatar Way",
  trade: "electrician",
  experience: "5-10",
  region: "Test Region",
  primaryZip: "10002",
  services: [{ name: "Electrical" }],
  // Deliberately no `headerImageUrl` / `bannerUrl` / `coverPhotoUrl`
  // so `bannerUri` resolves to null in PublicProfileModal — the modal
  // then renders the no-banner avatar layout (centered avatar inside
  // `heroBlock`). The contract under test (avatar precedence) is
  // identical in both layouts, but pinning to one keeps the test
  // assertions stable regardless of which layout the modal picks.
};

const FIXTURES: Fixture[] = [
  {
    key: "OWNER",
    emailEnv: "E2E_PICKED_SKIN_AVATAR_OWNER_EMAIL",
    passwordEnv: "E2E_PICKED_SKIN_AVATAR_OWNER_PASSWORD",
    defaultEmail: "e2e-picked-skin-avatar-owner@roundhouse-e2e.test",
    displayName: "Picked Skin Avatar Owner E2E",
    username: "picked_skin_avatar_owner_e2e",
    modeKind: "trade_pro",
    intakeData: OWNER_INTAKE_DATA,
    // The legacy "owner intake avatar" — what the modal falls back to
    // when the picked skin has no `avatarUrl` of its own, or when the
    // caller didn't pass a `counterpartOutwardAccountId` at all (e.g.
    // a Find-a-trade-pro business row tap). Owner never signs in, so
    // a synthetic /objects/uploads/... token is fine here.
    avatarUrl: OWNER_INTAKE_AVATAR_PATH,
  },
  {
    key: "VISITOR",
    emailEnv: "E2E_PICKED_SKIN_AVATAR_VISITOR_EMAIL",
    passwordEnv: "E2E_PICKED_SKIN_AVATAR_VISITOR_PASSWORD",
    defaultEmail: "e2e-picked-skin-avatar-visitor@roundhouse-e2e.test",
    displayName: "Picked Skin Avatar Visitor E2E",
    username: "picked_skin_avatar_visitor_e2e",
    modeKind: "home",
    intakeData: {
      placeName: "Picked Skin Avatar E2E Home",
      matters: ["maintenance"],
    },
    // Visitor signs in for this plan — needs a non-empty avatarUrl so
    // the profile-status guard lets them past identity onboarding and
    // lands them on `/(tabs)`.
    avatarUrl: "https://placehold.co/128x128/png?text=E2E",
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
  avatarUrl: string;
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
    // The owner uses a synthetic /objects/uploads/... token so the
    // modal's avatar-fallback path is observable; the visitor uses a
    // placehold.co URL so the signed-in router guard
    // (`identityCompletedAt && avatarUrl`) lets them through to
    // `/(tabs)`. Either way, non-empty.
    avatarUrl: opts.avatarUrl,
    services: opts.services,
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
 * `avatarUrl` is set to the seed value (or explicitly cleared back
 * to NULL when `avatarUrl: null` is passed) so the OA-without-avatar
 * fixture stays in a known-empty state across re-runs.
 */
async function ensureTradeProSkin(opts: {
  ownerClerkId: string;
  title: string;
  companyName: string;
  avatarUrl: string | null;
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
        avatarUrl: opts.avatarUrl,
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
      avatarUrl: opts.avatarUrl,
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

    const services = f.modeKind === "trade_pro" ? [{ name: "Electrical" }] : [];
    await upsertUserRow({
      clerkId: uid,
      email,
      displayName: f.displayName,
      username: f.username,
      services,
      avatarUrl: f.avatarUrl,
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
    title: "Picked Skin AvatarCo E2E",
    companyName: "Picked Skin AvatarCo E2E",
    avatarUrl: SKIN1_AVATAR_PATH,
    sourceUserModeId: owner.modeId,
  });
  const skin2Id = await ensureTradeProSkin({
    ownerClerkId: owner.uid,
    title: "Picked Skin NoAvatarCo E2E",
    companyName: "Picked Skin NoAvatarCo E2E",
    avatarUrl: null,
    sourceUserModeId: owner.modeId,
  });

  // Pin the active pointers at one of the two — the legacy /users/:userId
  // path resolves the snapshot mode from `lastActiveModeId`, so this
  // ensures the business-search-row case (no `counterpartOutwardAccountId`)
  // also surfaces the trade_pro intake snapshot.
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
      `\n  - id=${skin1Id} title="Picked Skin AvatarCo E2E"   avatarUrl=${SKIN1_AVATAR_PATH}` +
      `\n  - id=${skin2Id} title="Picked Skin NoAvatarCo E2E" avatarUrl=NULL` +
      `\n  owner intake avatar (users.avatarUrl) = ${OWNER_INTAKE_AVATAR_PATH}`,
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
    console.error("seed-picked-skin-avatar-fixtures failed:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
