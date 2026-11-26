import { createHash, randomUUID } from 'node:crypto';
import type { StorageQueries } from './store.js';
import { clean, needsMergeEvidence, scanObjectIdentity, type Decision, type DriveState, type ExpectedScopes, type FilesystemPolicy, type InternalItem, type Notice, type ScanChecks, type ScannerScan, type ScanItem, type Snapshot, type Trigger } from './types.js';

type Filesystem = ScannerScan['filesystems'][number];
export type StorageNotice = Notice & { external: boolean; externalItemId?: string; stage?: string; critical?: boolean };
const hash = (values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const MAX_SCAN_AGE_MS = 24 * 60 * 60_000;

export function scanIsFresh(state: Pick<DriveState, 'current'>, now: number): boolean {
  const age = now - Date.parse(state.current.scannedAt);
  return state.current.complete && state.current.inventoryComplete === true && age >= 0 && age <= MAX_SCAN_AGE_MS;
}

function filesystemScope(node: string, fs: Filesystem): string {
  return JSON.stringify(fs.shared ? ['shared', fs.id] : ['node', node, fs.id]);
}

function decisionMap(decisions: Decision[]): Map<string, Decision> {
  const latest = new Map<string, Decision>();
  for (const decision of decisions) if (!latest.has(decision.itemId)) latest.set(decision.itemId, decision);
  return latest;
}

/**
 * A decision applies while the item identity is unchanged. The size is not part of it. Decisions stored before the size
 * was removed hashed the size, so the hash with the current size still counts as a match.
 */
export function decisionMatches(decision: Pick<Decision, 'material'> | undefined, item: Pick<InternalItem, 'decisionMaterial' | 'legacyDecisionMaterial'>): boolean {
  return decision !== undefined && (decision.material === item.decisionMaterial || decision.material === item.legacyDecisionMaterial);
}

export function itemViews(state: DriveState, decisions: Decision[], now: number) {
  const latest = decisionMap(decisions);
  const fresh = scanIsFresh(state, now);
  return state.items.map(item => {
    const decision = latest.get(item.id);
    const current = decision?.decision === 'defer' || decisionMatches(decision, item) ? decision : undefined;
    const keep = current?.decision === 'keep';
    const deferUntil = current?.decision === 'defer' && Date.parse(current.until!) > now ? current.until : undefined;
    const mergeEvidence = needsMergeEvidence(item.category) ? item.mergeEvidence ?? 'unavailable' : undefined;
    const eligible = fresh && item.eligible && mergeEvidence !== 'unavailable' && item.inUse === false && !keep && !deferUntil;
    const reason = !state.current.complete || state.current.inventoryComplete !== true ? 'The scan is incomplete'
      : !fresh ? 'The scan is too old'
        : keep ? 'Kept by an operator'
          : deferUntil ? 'Deferred by an operator'
            : mergeEvidence === 'unavailable' ? 'Merge verification unavailable'
              : item.inUse === true ? 'In use'
                : item.inUse === undefined ? 'Inactivity was not verified' : item.reason;
    return {
      id: item.id,
      category: item.category,
      label: item.path || item.category,
      owner: item.owner,
      bytes: item.bytes,
      eligible,
      mergeEvidence,
      reason,
      inUse: item.inUse,
      holder: item.holder,
      keep: keep || undefined,
      deferUntil,
    };
  });
}

function normalizeItem(item: ScanItem, node: string, id: string, complete: boolean): InternalItem {
  const jev = item.visibility === 'jev';
  const mergeEvidence = needsMergeEvidence(item.category) ? item.mergeEvidence ?? 'unavailable' : undefined;
  const eligible = complete && item.category !== 'host-temp' && item.eligible && mergeEvidence !== 'unavailable' && item.inUse === false;
  return {
    id,
    scannerId: item.id,
    category: item.category,
    material: hash([node, item.objectKey ? undefined : item.id, item.objectKey, item.path, item.category, item.bytes, item.owner, item.inUse, item.holder, item.eligible, item.visibility, mergeEvidence]),
    // The size is left out on purpose: a size change must not undo a "keep" or raise a new question.
    // A fixed 0 sits where the size was, so this equals the old hash of an item that was scanned with 0 bytes.
    decisionMaterial: hash([item.category, 0, item.owner, item.inUse, item.holder]),
    // The old hash with the real size. It keeps decisions and questions stored before this change valid.
    legacyDecisionMaterial: hash([item.category, item.bytes, item.owner, item.inUse, item.holder]),
    path: jev ? clean(item.path) : undefined,
    owner: jev ? clean(item.owner) : undefined,
    reason: jev ? clean(item.reason) : eligible ? 'Scanner marked this item eligible' : 'Scanner excluded this item',
    holder: jev && item.holder ? clean(item.holder) : undefined,
    bytes: item.bytes,
    eligible,
    mergeEvidence,
    inUse: item.inUse,
    visibility: jev ? 'jev' : 'local',
  };
}

function aliasKey(device: string, mountpoint: string): string {
  return JSON.stringify([device, mountpoint]);
}

function triggerKey(trigger: Trigger): string {
  return trigger.device !== undefined && trigger.mount !== undefined ? aliasKey(trigger.device, trigger.mount) : `id:${trigger.filesystemId}`;
}

export async function resolveCooldowns(tx: StorageQueries, node: string, triggers: Trigger[], now: number, cooldownMs: number): Promise<Trigger[]> {
  const aliases = new Map(await tx.aliases(node));
  const due: Trigger[] = [];
  const cutoff = now - cooldownMs;
  const times = new Map<string, number>();
  for (const trigger of triggers) {
    const scope = aliases.get(triggerKey(trigger));
    if (scope && !times.has(scope)) times.set(scope, await tx.cooldown(scope));
    if (!scope || (times.get(scope) ?? 0) <= cutoff) due.push(trigger);
  }
  return due;
}

function makeSnapshot(
  scan: ScannerScan, inventoryComplete: boolean, fs: Filesystem, previous: DriveState | undefined,
  triggers: Trigger[], policies: FilesystemPolicy[],
): Snapshot {
  const reserves = triggers.flatMap(t => t.reserveBytes === undefined ? [] : [t.reserveBytes]);
  const criticals = triggers.flatMap(t => t.criticalBytes === undefined ? [] : [t.criticalBytes]);
  const overrides = policies.filter(policy => 'reserveBytes' in policy);
  const gib = 1024 ** 3;
  const generalReserve = Math.min(Math.max(Math.floor(fs.totalBytes / 20), 24 * gib),
    2048 * gib, Math.floor(fs.totalBytes / 4));
  const reserveBytes = overrides.length ? Math.max(...overrides.map(policy => policy.reserveBytes))
    : policies.length ? generalReserve
    : reserves.length ? Math.max(...reserves) : previous?.current.reserveBytes ?? Math.ceil(fs.totalBytes / 10);
  const criticalBytes = Math.min(reserveBytes, overrides.length ? Math.max(...overrides.map(policy => policy.criticalBytes))
    : policies.length ? Math.floor(generalReserve / 2)
    : criticals.length ? Math.max(...criticals) : previous?.current.criticalBytes ?? reserveBytes);
  return {
    id: randomUUID(),
    scannedAt: scan.scannedAt,
    totalBytes: fs.totalBytes,
    availableBytes: fs.availableBytes,
    reserveBytes,
    criticalBytes,
    complete: scan.complete && inventoryComplete,
    holderEvidenceComplete: scan.complete,
    inventoryComplete,
    critical: fs.availableBytes <= criticalBytes,
    itemCount: 0,
    eligibleCount: 0,
  };
}

function pressureEpisode(snapshot: Snapshot, previous?: DriveState['episode']): DriveState['episode'] {
  if (snapshot.inventoryComplete !== true) return previous;
  if (!snapshot.critical && snapshot.availableBytes >= snapshot.reserveBytes) return;
  const episode = previous ?? { id: randomUUID() };
  if (snapshot.critical && !episode.critical) return { ...episode, critical: randomUUID() };
  return episode;
}

export function pressureStage(state: DriveState): string | undefined {
  return state.episode?.critical ?? state.episode?.id;
}

export async function updateCleanupNotice(tx: StorageQueries, state: DriveState, decisions: Decision[], now: number): Promise<void> {
  if (!state.current.complete) return;
  const stage = pressureStage(state);
  const eligible = itemViews(state, decisions, now).filter(item => item.eligible);
  const existing = (await tx.list<StorageNotice>('notice', state.drive.id)).find(notice => notice.kind === 'cleanup');
  const replaced = Boolean(stage && existing?.stage !== stage);
  if (existing && (replaced || !eligible.length)) await tx.clearNotice(existing.id);
  if (!eligible.length) return;

  const eligibleIds = new Set(eligible.map(item => item.id));
  const external = state.items.some(item => item.visibility === 'jev' && eligibleIds.has(item.id));
  const retained = replaced ? undefined : existing;
  if (retained && retained.stage === stage && retained.external === external && retained.eligibleCount === eligible.length) return;
  const notice: StorageNotice = {
    id: retained?.id ?? stage ?? randomUUID(),
    driveId: state.drive.id,
    kind: 'cleanup',
    createdAt: retained?.createdAt ?? new Date(now).toISOString(),
    eligibleCount: eligible.length,
    external,
    stage,
  };
  if (retained) await tx.updateRecord('notice', notice);
  else await tx.insert(state.drive.id, 'notice', notice);
}

export async function ingestScan(
  tx: StorageQueries,
  scan: ScannerScan,
  triggers: Trigger[],
  policies: FilesystemPolicy[],
  now: number,
  cooldownMs: number,
  contained: boolean,
  expected?: ExpectedScopes,
): Promise<{ checks: ScanChecks; observed: DriveState[] }> {
  const filesystems = scan.filesystems.map(fs => ({ fs, scope: filesystemScope(scan.node, fs) })).sort((a, b) => a.scope.localeCompare(b.scope));
  const aliasScopes = new Map<string, Set<string>>();
  function addAlias(key: string, scope: string) {
    const scopes = aliasScopes.get(key) ?? new Set<string>();
    scopes.add(scope);
    aliasScopes.set(key, scopes);
  }
  for (const { fs, scope } of filesystems) {
    addAlias(`id:${fs.id}`, scope);
    for (const { device, mountpoint } of fs.aliases ?? []) addAlias(aliasKey(device, mountpoint), scope);
  }
  const aliases = new Map([...aliasScopes].flatMap(([key, scopes]) => scopes.size === 1 ? [[key, [...scopes][0]] as const] : []));
  // Policies with a device require the exact exporter pair.
  const policyScopes = new Map<string, Set<string>>();
  for (const { fs, scope } of filesystems) {
    for (const mount of [fs.mount, ...(fs.aliases ?? []).map(alias => alias.mountpoint)]) {
      const scopes = policyScopes.get(mount) ?? new Set<string>();
      scopes.add(scope);
      policyScopes.set(mount, scopes);
    }
  }
  const policiesByScope = new Map<string, FilesystemPolicy[]>();
  let coveredPolicies = 0;
  for (const policy of policies) {
    const scopes = policy.device === undefined ? policyScopes.get(policy.mount)
      : aliasScopes.get(aliasKey(policy.device, policy.mount));
    if (scopes?.size !== 1) continue;
    const [scope] = scopes;
    const matched = policiesByScope.get(scope) ?? [];
    matched.push(policy);
    policiesByScope.set(scope, matched);
    coveredPolicies++;
  }
  const policiesMatched = coveredPolicies === policies.length;
  const inventoryComplete = scan.inventoryComplete === true && policiesMatched;
  const hasFilesystems = filesystems.length > 0;
  const complete = scan.complete && inventoryComplete && hasFilesystems;
  const scopes = triggers.map(trigger => aliases.get(triggerKey(trigger)));
  const matched = scopes.every(Boolean);
  const configuredOmission = scan.version === 2 && expected !== undefined && hasFilesystems
    && scan.inventoryCoverage.filesystemInventoryComplete
    && Object.keys(scan.inventoryCoverage.scopes).length === Object.keys(expected).length
    && Object.entries(expected).every(([scope, state]) => scan.inventoryCoverage.scopes[scope] === state);
  const containedInventory = contained && scan.execution === 'shadow' && inventoryComplete && matched && hasFilesystems;
  const omissionOnly = contained && configuredOmission && policiesMatched && matched;
  const checks: ScanChecks = {
    inventory: configuredOmission ? 'configured_omission' : scan.inventoryComplete === undefined ? 'unknown'
      : scan.inventoryComplete ? 'complete' : 'incomplete',
    policy: !policies.length ? 'not_required' : policiesMatched ? 'matched' : 'unmatched',
    trigger: !triggers.length ? 'not_required' : matched ? 'matched' : 'unmatched',
    // V2 fixes complete to false, independent of the holder check.
    holder: scan.version === 2 ? 'unknown' : scan.complete ? 'complete' : 'unavailable',
    acceptance: complete && matched ? 'full' : containedInventory ? 'contained' : omissionOnly ? 'configured_omission' : 'rejected',
  };
  const triggersByScope = new Map<string, Trigger[]>();
  for (const [index, scope] of scopes.entries()) {
    if (!scope) continue;
    const scoped = triggersByScope.get(scope) ?? [];
    scoped.push(triggers[index]);
    triggersByScope.set(scope, scoped);
  }
  const itemsByFs = new Map<string, ScanItem[]>();
  for (const item of scan.items) {
    const items = itemsByFs.get(item.filesystemId) ?? [];
    items.push(item);
    itemsByFs.set(item.filesystemId, items);
  }
  await tx.putAliases(scan.node, complete ? [...aliases] : []);
  const observed: DriveState[] = [];
  const foundScopes = new Set(filesystems.map(entry => entry.scope));
  const missing = (await tx.scopesOnNode(scan.node)).filter(scope => !foundScopes.has(scope));
  for (const scope of [...foundScopes, ...missing].sort()) await tx.lock(scope);
  for (const scope of missing) {
    const last = await tx.byScope(scope);
    if (!last || last.drive.node !== scan.node || Date.parse(last.current.scannedAt) >= Date.parse(scan.scannedAt)) continue;
    await tx.drive(last.drive.id, true);
    const snapshot = {
      ...last.current, id: randomUUID(), scannedAt: scan.scannedAt, complete: false,
      holderEvidenceComplete: scan.complete, inventoryComplete: false, eligibleCount: 0, checks,
    };
    const drive = { ...last.drive, ...snapshot, id: last.drive.id, status: 'incomplete' as const };
    await tx.putSnapshot(drive.id, snapshot);
    await tx.putDrive(scope, { ...last, drive, current: snapshot });
  }
  for (const { fs, scope } of filesystems) {
    const supplied = triggersByScope.get(scope) ?? [];
    const last = supplied.length ? await tx.cooldown(scope) : 0;
    const due = last <= now - cooldownMs ? supplied : [];
    const previous = await tx.byScope(scope);
    if (previous) await tx.drive(previous.drive.id, true);
    const id = previous?.drive.id ?? randomUUID();
    // A complete peer is stronger evidence than an incomplete view of a shared filesystem.
    const stale = previous && (
      Date.parse(previous.current.scannedAt) > Date.parse(scan.scannedAt)
      || (fs.shared && previous.current.complete && previous.current.inventoryComplete === true && !complete && previous.drive.node !== scan.node)
    );
    if (stale) {
      if (complete && due.length) await tx.markCooldown(scope, now);
      continue;
    }
    const snapshot = { ...makeSnapshot(scan, inventoryComplete, fs, previous, due, policiesByScope.get(scope) ?? []), checks };
    const source = scan.execution ?? 'shadow';
    const state: DriveState = {
      drive: {
        ...snapshot,
        id,
        node: scan.node,
        mount: clean(fs.mount),
        filesystemId: clean(fs.id),
        status: !complete ? 'incomplete' : snapshot.critical ? 'critical' : fs.availableBytes < snapshot.reserveBytes ? 'pressure' : 'healthy',
        applyEnabled: false,
      },
      current: snapshot,
      episode: pressureEpisode(snapshot, previous?.episode),
      items: [],
      execution: source,
      shared: fs.shared === true,
    };
    const found = itemsByFs.get(fs.id) ?? [];
    const keyed = found.map(item => ({ item, key: hash([scan.node, item.category, scanObjectIdentity(item)]) }));
    // The drive row must exist before the stable item IDs can refer to it.
    if (!previous) await tx.putDrive(scope, state);
    const ids = await tx.itemIds(id, keyed.map(({ key }) => key));
    state.items = keyed.map(({ item, key }) => normalizeItem(item, scan.node, ids.get(key)!, complete));
    const decisions = await tx.list<Decision>('decision', id);
    snapshot.itemCount = state.items.length;
    snapshot.eligibleCount = itemViews(state, decisions, now).filter(item => item.eligible).length;
    Object.assign(state.drive, { itemCount: snapshot.itemCount, eligibleCount: snapshot.eligibleCount });
    const duplicate = previous && previous.drive.node === scan.node && JSON.stringify({ ...previous.current, id: snapshot.id }) === JSON.stringify(snapshot);
    if (!duplicate) await tx.putSnapshot(id, snapshot);
    else {
      state.current = previous.current;
      state.drive.scannedAt = previous.current.scannedAt;
    }
    await tx.putDrive(scope, state);
    if (complete && due.length) await tx.markCooldown(scope, now);
    await updateCleanupNotice(tx, state, decisions, now);
    observed.push(state);
  }
  return { checks, observed };
}
