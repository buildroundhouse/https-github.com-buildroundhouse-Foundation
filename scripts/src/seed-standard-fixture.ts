/**
 * Seed the Firebase + Postgres fixture account that the "standard
 * pre-onboarded user" e2e test plans rely on (the `E2E_FIREBASE_*`
 * pair). The fixture lands on `/(tabs)` after sign-in and owns at
 * least one property so plans that need a property scope (e.g. the
 * recurring-task and clear-due-date sections of
 * `artifacts/round-house/e2e/destructive-confirms.test-plan.md`) have
 * something to work with.
 *
 * Plan references that read this fixture's data:
 *   artifacts/round-house/e2e/destructive-confirms.test-plan.md
 *   artifacts/round-house/e2e/my-team-tab-message.test-plan.md
 *
 * What this script guarantees, idempotently:
 *   - One Firebase Auth user exists (created on first run, signed in
 *     on subsequent runs to recover its uid):
 *       * E2E_FIREBASE_*  — the standard pre-onboarded fixture
 *   - A `users` row exists, `identityCompletedAt` set so router
 *     guards land the session on `/(tabs)` not `/(onboarding)/...`.
 *   - The user owns one `outward_accounts` row of kind `home` named
 *     "Standard E2E Home", and `users.activeOutwardAccountId` points
 *     at it.
 *   - The user owns one `properties` row named "Standard E2E House"
 *     scoped to that home outward account.
 *   - Three counterpart fixture users + outward accounts exist so the
 *     My Team tab's homeowner-skin buckets (Trade Pros / Friends &
 *     Collaborators / "no longer on the app" retired counterparts)
 *     each have at least one accepted connection to render:
 *       * E2E_FIREBASE_TRADE_PRO_*    — trade_pro counterpart, kind
 *         "core" (no `outside_service_provider` classification, so it
 *         lands in the Trade Pros bucket)
 *       * E2E_FIREBASE_FRIEND_*       — collab counterpart, kind
 *         "collaborator" (Friends & Collaborators bucket)
 *       * E2E_FIREBASE_RETIRED_PRO_*  — trade_pro counterpart whose
 *         outward account has been archived (`archived_at` set), so
 *         the relationships endpoint reports it with
 *         `counterpartArchivedAt` set and the My Team tab renders the
 *         retired-counterpart Message-pill suppression case.
 *
 * The script PRINTS the email/password pair at the end. It does NOT
 * write them into the project's environment itself — copy them into
 * the shared env vars / secrets manually after the first run.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run seed:standard-fixture
 *
 * Required env vars (already present on Replit):
 *   - DATABASE_URL
 *   - EXPO_PUBLIC_FIREBASE_API_KEY
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  pool,
  entitiesTable,
  entityMembersTable,
  outwardAccountsTable,
  propertiesTable,
  userConnectionsTable,
  userModesTable,
  usersTable,
  type ConnectionClassification,
  type ConnectionKind,
  type EntityMemberRole,
  type UserModeKind,
} from "@workspace/db";

const FIXTURE = {
  emailEnv: "E2E_FIREBASE_EMAIL",
  passwordEnv: "E2E_FIREBASE_PASSWORD",
  defaultEmail: "e2e-standard@roundhouse-e2e.test",
  displayName: "Standard E2E Fixture",
  username: "standard_e2e_fixture",
};

interface CounterpartFixture {
  key: "TRADE_PRO" | "FRIEND" | "RETIRED_PRO";
  emailEnv: string;
  passwordEnv: string;
  defaultEmail: string;
  displayName: string;
  username: string;
  modeKind: UserModeKind;
  intakeData: Record<string, unknown>;
  companyName: string | null;
  /**
   * Connection kind written FROM the standard fixture's home OA TO
   * the counterpart's primary OA. The relationships endpoint scopes
   * on `from = active outward account`, so only this direction is
   * needed for the bucket to render.
   */
  connectionKind: ConnectionKind;
  classification: ConnectionClassification | null;
  /**
   * When true, the counterpart's primary outward account is archived
   * after creation so it shows up as "no longer on the app" in the
   * My Team tab (Case 2 of the my-team-tab-message plan).
   */
  archiveCounterpart: boolean;
  /**
   * When set, the counterpart is also added as an approved
   * `entity_members` row on the standard fixture's property entity
   * with this role. Used by the privacy-toggle plan
   * (`artifacts/round-house/e2e/privacy-toggle-end-to-end.test-plan.md`)
   * so the friend lands inside the same entity thread as the
   * standard fixture and can observe the per-skin "show last
   * initial only" shortening on the inbox row preview prefix.
   */
  joinStandardPropertyEntityAs?: EntityMemberRole;
}

const COUNTERPARTS: CounterpartFixture[] = [
  {
    key: "TRADE_PRO",
    emailEnv: "E2E_FIREBASE_TRADE_PRO_EMAIL",
    passwordEnv: "E2E_FIREBASE_TRADE_PRO_PASSWORD",
    defaultEmail: "e2e-standard-trade-pro@roundhouse-e2e.test",
    displayName: "Standard E2E Trade Pro",
    username: "standard_e2e_trade_pro",
    modeKind: "trade_pro",
    intakeData: { ownerName: "Standard E2E Trade Pro", tradeKind: "general", teamSize: "1" },
    companyName: "Standard E2E Trade Pro Co",
    connectionKind: "core",
    classification: null,
    archiveCounterpart: false,
  },
  {
    key: "FRIEND",
    emailEnv: "E2E_FIREBASE_FRIEND_EMAIL",
    passwordEnv: "E2E_FIREBASE_FRIEND_PASSWORD",
    defaultEmail: "e2e-standard-friend@roundhouse-e2e.test",
    displayName: "Standard E2E Friend",
    username: "standard_e2e_friend",
    modeKind: "collab",
    intakeData: { role: "friend" },
    companyName: null,
    connectionKind: "collaborator",
    classification: null,
    archiveCounterpart: false,
    joinStandardPropertyEntityAs: "collaborator",
  },
  {
    key: "RETIRED_PRO",
    emailEnv: "E2E_FIREBASE_RETIRED_PRO_EMAIL",
    passwordEnv: "E2E_FIREBASE_RETIRED_PRO_PASSWORD",
    defaultEmail: "e2e-standard-retired-pro@roundhouse-e2e.test",
    displayName: "Standard E2E Retired Pro",
    username: "standard_e2e_retired_pro",
    modeKind: "trade_pro",
    intakeData: { ownerName: "Standard E2E Retired Pro", tradeKind: "general", teamSize: "1" },
    companyName: "Standard E2E Retired Co",
    connectionKind: "core",
    classification: null,
    archiveCounterpart: true,
  },
];

const HOME_OA_NAME = "Standard E2E Home";
const PROPERTY_NAME = "Standard E2E House";

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

async function ensureLastActiveMode(opts: {
  clerkId: string;
  modeId: number;
}): Promise<void> {
  await db
    .update(usersTable)
    .set({ lastActiveModeId: opts.modeId })
    .where(eq(usersTable.clerkId, opts.clerkId));
}

async function ensureHomeOutwardAccount(opts: {
  ownerClerkId: string;
  sourceUserModeId: number;
}): Promise<number> {
  const owned = await db
    .select({
      id: outwardAccountsTable.id,
      kind: outwardAccountsTable.kind,
      title: outwardAccountsTable.title,
    })
    .from(outwardAccountsTable)
    .where(
      and(
        eq(outwardAccountsTable.ownerClerkId, opts.ownerClerkId),
        isNull(outwardAccountsTable.archivedAt),
      ),
    );
  const existing = owned.find((o) => o.kind === "home" && o.title === HOME_OA_NAME);
  if (existing) {
    await db
      .update(outwardAccountsTable)
      .set({ capabilityState: "expanded", sourceUserModeId: opts.sourceUserModeId })
      .where(eq(outwardAccountsTable.id, existing.id));
    return existing.id;
  }
  const [created] = await db
    .insert(outwardAccountsTable)
    .values({
      ownerClerkId: opts.ownerClerkId,
      kind: "home",
      title: HOME_OA_NAME,
      displayName: HOME_OA_NAME,
      capabilityState: "expanded",
      sourceUserModeId: opts.sourceUserModeId,
    })
    .returning({ id: outwardAccountsTable.id });
  return created.id;
}

/**
 * Generic primary outward-account upsert for the counterpart fixtures.
 * Matches by (owner, kind, sourceUserModeId) so each counterpart gets
 * exactly one OA per re-run.
 */
async function ensureCounterpartOutwardAccount(opts: {
  ownerClerkId: string;
  kind: UserModeKind;
  companyName: string | null;
  displayName: string;
  sourceUserModeId: number;
  archived: boolean;
}): Promise<number> {
  // We need to look at archived rows too, otherwise a re-run after
  // the first archival would insert a duplicate.
  const all = await db
    .select({ id: outwardAccountsTable.id })
    .from(outwardAccountsTable)
    .where(
      and(
        eq(outwardAccountsTable.ownerClerkId, opts.ownerClerkId),
        eq(outwardAccountsTable.kind, opts.kind),
        eq(outwardAccountsTable.sourceUserModeId, opts.sourceUserModeId),
      ),
    );
  if (all[0]) {
    await db
      .update(outwardAccountsTable)
      .set({
        companyName: opts.companyName,
        displayName: opts.displayName,
        title: opts.companyName ?? opts.displayName,
        sourceUserModeId: opts.sourceUserModeId,
        capabilityState: "expanded",
        archivedAt: opts.archived ? new Date() : null,
      })
      .where(eq(outwardAccountsTable.id, all[0].id));
    return all[0].id;
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
      archivedAt: opts.archived ? new Date() : null,
    })
    .returning({ id: outwardAccountsTable.id });
  return created.id;
}

async function ensureActiveOutwardAccount(opts: {
  clerkId: string;
  outwardAccountId: number;
}): Promise<void> {
  await db
    .update(usersTable)
    .set({ activeOutwardAccountId: opts.outwardAccountId })
    .where(eq(usersTable.clerkId, opts.clerkId));
}

async function ensureProperty(opts: {
  ownerClerkId: string;
  ownerOutwardAccountId: number;
}): Promise<number> {
  const owned = await db
    .select({ id: propertiesTable.id, name: propertiesTable.name })
    .from(propertiesTable)
    .where(eq(propertiesTable.ownerClerkId, opts.ownerClerkId));
  const existing = owned.find((p) => p.name === PROPERTY_NAME);
  let propertyId: number;
  if (existing) {
    propertyId = existing.id;
  } else {
    const [created] = await db
      .insert(propertiesTable)
      .values({
        name: PROPERTY_NAME,
        ownerClerkId: opts.ownerClerkId,
        ownerOutwardAccountId: opts.ownerOutwardAccountId,
        type: "home",
      })
      .returning({ id: propertiesTable.id });
    propertyId = created.id;
  }

  // The /api/properties listing requires an entity_members row for the
  // requesting user — without it the property is invisible to its own
  // owner. Mirror what POST /api/properties does inline so the fixture
  // is reachable through the UI immediately. The legacy
  // `property_members` table was retired in task #681; membership now
  // lives only in `entity_members` keyed off the property → entity
  // link table created by the api-server boot migration.
  await ensureEntityMemberForProperty({
    propertyId,
    ownerClerkId: opts.ownerClerkId,
    ownerOutwardAccountId: opts.ownerOutwardAccountId,
  });

  return propertyId;
}

/**
 * Ensure the side table that maps properties → entities exists, then
 * create (or look up) the entity row for `propertyId` and seed an
 * `owner` membership for `ownerClerkId`. Mirrors what the api-server
 * `migratePropertyEntities` boot migration does for a single property
 * — duplicated here because @workspace/scripts can't depend on the
 * api-server source tree.
 */
async function ensureEntityMemberForProperty(opts: {
  propertyId: number;
  ownerClerkId: string;
  ownerOutwardAccountId: number;
}): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS property_entity_links (
      property_id integer PRIMARY KEY,
      entity_id integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS property_entity_links_entity_idx
      ON property_entity_links (entity_id);
  `);

  const [property] = await db
    .select()
    .from(propertiesTable)
    .where(eq(propertiesTable.id, opts.propertyId))
    .limit(1);
  if (!property) return;

  const linkRow = await db.execute<{ entity_id: number }>(sql`
    SELECT entity_id FROM property_entity_links WHERE property_id = ${opts.propertyId} LIMIT 1
  `);
  let entityId = linkRow.rows[0]?.entity_id ?? null;
  if (entityId == null) {
    const [entity] = await db
      .insert(entitiesTable)
      .values({
        kind: property.type === "commercial" ? "commercial_property" : "residential_property",
        name: property.name,
        coverColor: property.coverColor,
        coverPhotoUrl: property.coverPhotoUrl,
        controllerOutwardAccountId: property.ownerOutwardAccountId ?? opts.ownerOutwardAccountId,
        controllerUserClerkId: property.ownerClerkId,
        createdByUserClerkId: property.ownerClerkId,
        isAdminDemo: property.isAdminDemo,
      })
      .returning();
    entityId = entity.id;
    await db.execute(sql`
      INSERT INTO property_entity_links (property_id, entity_id)
      VALUES (${opts.propertyId}, ${entityId})
      ON CONFLICT (property_id) DO NOTHING
    `);
  }

  const [existing] = await db
    .select({ id: entityMembersTable.id })
    .from(entityMembersTable)
    .where(
      and(
        eq(entityMembersTable.entityId, entityId),
        eq(entityMembersTable.userClerkId, opts.ownerClerkId),
        eq(entityMembersTable.userOutwardAccountId, opts.ownerOutwardAccountId),
      ),
    )
    .limit(1);
  if (!existing) {
    await db.insert(entityMembersTable).values({
      entityId,
      userClerkId: opts.ownerClerkId,
      userOutwardAccountId: opts.ownerOutwardAccountId,
      role: "owner",
      status: "approved",
      direction: "invite",
      requestedByOutwardAccountId: opts.ownerOutwardAccountId,
      decidedAt: new Date(),
    });
  }
}

/**
 * Look up the entity_id linked to `propertyId` from the
 * `property_entity_links` side-table the api-server boot migration
 * maintains. Returns `null` if the link row hasn't been created yet
 * (e.g. running the seed before the api-server has booted once).
 */
async function getEntityIdForProperty(propertyId: number): Promise<number | null> {
  const linkRow = await db.execute<{ entity_id: number }>(sql`
    SELECT entity_id FROM property_entity_links WHERE property_id = ${propertyId} LIMIT 1
  `);
  return linkRow.rows[0]?.entity_id ?? null;
}

/**
 * Add a non-owner approved member to the standard fixture's property
 * entity. Idempotent: looks up the existing membership by
 * (entity, user clerk, user outward account) and updates it in place
 * if it already exists. Used to put the FRIEND counterpart inside the
 * same entity thread as the standard fixture so the privacy-toggle
 * plan can observe the per-skin "show last initial only" shortening
 * on the entity-thread inbox row preview prefix.
 */
async function ensureApprovedEntityMember(opts: {
  entityId: number;
  userClerkId: string;
  userOutwardAccountId: number;
  role: EntityMemberRole;
  invitedByOutwardAccountId: number;
}): Promise<void> {
  const [existing] = await db
    .select({ id: entityMembersTable.id })
    .from(entityMembersTable)
    .where(
      and(
        eq(entityMembersTable.entityId, opts.entityId),
        eq(entityMembersTable.userClerkId, opts.userClerkId),
        eq(entityMembersTable.userOutwardAccountId, opts.userOutwardAccountId),
      ),
    )
    .limit(1);
  const baseSet = {
    role: opts.role,
    status: "approved" as const,
    direction: "invite" as const,
    requestedByOutwardAccountId: opts.invitedByOutwardAccountId,
    decidedAt: new Date(),
    archivedAt: null,
  };
  if (existing) {
    await db
      .update(entityMembersTable)
      .set(baseSet)
      .where(eq(entityMembersTable.id, existing.id));
    return;
  }
  await db.insert(entityMembersTable).values({
    entityId: opts.entityId,
    userClerkId: opts.userClerkId,
    userOutwardAccountId: opts.userOutwardAccountId,
    ...baseSet,
  });
}

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

interface SeededCounterpart extends CounterpartFixture {
  email: string;
  password: string;
  uid: string;
  outwardAccountId: number;
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
  process.stdout.write(`Ensuring Firebase user <${email}>... `);
  const uid = await ensureFirebaseUser(email, password);
  process.stdout.write(`uid=${uid}\n`);
  await upsertUserRow({
    clerkId: uid,
    email,
    displayName: FIXTURE.displayName,
    username: FIXTURE.username,
  });
  const homeModeId = await ensureMode({ clerkId: uid, kind: "home", intakeData: {} });
  console.log(`Home user_modes.id = ${homeModeId}`);
  const homeOaId = await ensureHomeOutwardAccount({ ownerClerkId: uid, sourceUserModeId: homeModeId });
  console.log(`Home outward_accounts.id = ${homeOaId} (${HOME_OA_NAME})`);
  await ensureActiveOutwardAccount({ clerkId: uid, outwardAccountId: homeOaId });
  await ensureLastActiveMode({ clerkId: uid, modeId: homeModeId });
  const propertyId = await ensureProperty({
    ownerClerkId: uid,
    ownerOutwardAccountId: homeOaId,
  });
  console.log(`properties.id = ${propertyId} (${PROPERTY_NAME})`);
  const standardEntityId = await getEntityIdForProperty(propertyId);
  if (standardEntityId == null) {
    throw new Error(
      `property_entity_links row missing for property ${propertyId} after ensureProperty — the api-server boot migration must have created the link before any counterpart can join the entity.`,
    );
  }
  console.log(`Standard property entity_id = ${standardEntityId}`);

  // Counterpart fixtures + accepted connections from the standard
  // home OA → each counterpart's primary OA.
  const seededCounterparts: SeededCounterpart[] = [];
  for (const cp of COUNTERPARTS) {
    const cpEmail = process.env[cp.emailEnv]?.trim();
    if (!cpEmail) {
      throw new Error(`${cp.emailEnv} must be set; fixture passwords are not stored in source control.`);
    }
    const cpPassword = process.env[cp.passwordEnv]?.trim();
    if (!cpPassword) {
      throw new Error(`${cp.passwordEnv} must be set; fixture passwords are not stored in source control.`);
    }
    process.stdout.write(`Ensuring Firebase user ${cp.key} <${cpEmail}>... `);
    const cpUid = await ensureFirebaseUser(cpEmail, cpPassword);
    process.stdout.write(`uid=${cpUid}\n`);
    await upsertUserRow({
      clerkId: cpUid,
      email: cpEmail,
      displayName: cp.displayName,
      username: cp.username,
    });
    const cpModeId = await ensureMode({
      clerkId: cpUid,
      kind: cp.modeKind,
      intakeData: cp.intakeData,
    });
    const cpOaId = await ensureCounterpartOutwardAccount({
      ownerClerkId: cpUid,
      kind: cp.modeKind,
      companyName: cp.companyName,
      displayName: cp.displayName,
      sourceUserModeId: cpModeId,
      archived: cp.archiveCounterpart,
    });
    seededCounterparts.push({
      ...cp,
      email: cpEmail,
      password: cpPassword,
      uid: cpUid,
      outwardAccountId: cpOaId,
    });
    const connId = await ensureConnection({
      fromOutwardAccountId: homeOaId,
      toOutwardAccountId: cpOaId,
      kind: cp.connectionKind,
      classification: cp.classification,
    });
    let entityMembershipNote = "";
    if (cp.joinStandardPropertyEntityAs) {
      await ensureApprovedEntityMember({
        entityId: standardEntityId,
        userClerkId: cpUid,
        userOutwardAccountId: cpOaId,
        role: cp.joinStandardPropertyEntityAs,
        invitedByOutwardAccountId: homeOaId,
      });
      entityMembershipNote = `, entity_member of standard property entity ${standardEntityId} (role=${cp.joinStandardPropertyEntityAs})`;
    }
    console.log(
      `${cp.key}: outward_accounts.id=${cpOaId}${cp.archiveCounterpart ? " (archived)" : ""}, connection.id=${connId} (kind=${cp.connectionKind})${entityMembershipNote}`,
    );
  }

  console.log(
    "\nSeed complete. Copy the following into the project's shared env vars / secrets so test runners can sign in (this script does NOT write them itself):\n",
  );
  console.log(`  ${FIXTURE.emailEnv}=${email}`);
  for (const cp of seededCounterparts) {
    console.log(`  ${cp.emailEnv}=${cp.email}`);
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
    console.error("seed-standard-fixture failed:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
