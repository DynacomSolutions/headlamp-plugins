import { randomUUID } from 'node:crypto';
import { SurfaceBuilder, surfaceId } from '../a2ui/index.js';
import { itemViews, type StorageNotice } from './inventory.js';
import type { StorageQueries } from './store.js';
import { StorageError, type Child, type Decision, type DriveState, type Evidence, type Investigation, type Question } from './types.js';

type StoredQuestion = Question & { fingerprint: string };

export function publicQuestion({ fingerprint: _fingerprint, ...question }: StoredQuestion): Question {
  return question;
}

export async function raiseQuestion(
  tx: StorageQueries,
  state: DriveState,
  options: { text: string; fingerprint: string; itemId?: string; external: boolean; now: number },
): Promise<Question> {
  const { drive } = state;
  const questions = await tx.list<StoredQuestion>('question', drive.id);
  const existing = questions.find(question => question.fingerprint === options.fingerprint);
  if (existing) return existing;
  const question: StoredQuestion = {
    id: randomUUID(),
    driveId: drive.id,
    itemId: options.itemId,
    text: options.text,
    createdAt: new Date(options.now).toISOString(),
    fingerprint: options.fingerprint,
  };
  const notice: StorageNotice = {
    id: randomUUID(),
    driveId: drive.id,
    kind: 'question',
    createdAt: question.createdAt,
    questionId: question.id,
    external: options.external,
    externalItemId: options.external ? options.itemId : undefined,
    critical: state.current.critical,
  };
  await tx.insert(drive.id, 'question', question);
  await tx.insert(drive.id, 'notice', notice);
  return question;
}

export async function raiseScanQuestion(tx: StorageQueries, state: DriveState, decisions: Decision[], now: number): Promise<void> {
  if (!state.current.complete || state.current.availableBytes > state.current.reserveBytes) return;
  if (itemViews(state, decisions, now).some(item => item.eligible)) return;
  const item = state.items.find(item => item.visibility === 'jev' && !item.eligible);
  await raiseQuestion(tx, state, {
    text: 'The drive is below its reserve and has no eligible cleanup. Which workload or retention policy should be reviewed?',
    fingerprint: 'below-reserve-without-cleanup',
    external: Boolean(item),
    itemId: item?.id,
    now,
  });
}

export async function investigate(
  tx: StorageQueries,
  state: DriveState,
  request: Investigation,
  now: number,
): Promise<Child> {
  const { drive, current } = state;
  const selected = request.itemId ? state.items.find(item => item.id === request.itemId) : undefined;
  if (request.itemId && !selected) throw new StorageError(404, 'Item not found on this drive');
  const views = itemViews(state, await tx.list<Decision>('decision', drive.id), now);
  const scope = selected ? views.filter(view => view.id === selected.id) : views;
  const history = request.kind === 'capacity' ? await tx.history(drive.id) : [];
  const earlier = history.find(snapshot => snapshot.complete && Date.parse(snapshot.scannedAt) < Date.parse(current.scannedAt));
  const capacity = `${current.availableBytes} bytes are available. Reserve is ${current.reserveBytes} bytes. Critical threshold is ${current.criticalBytes} bytes.`;
  const change = earlier ? ` Free space changed by ${current.availableBytes - earlier.availableBytes} bytes since ${earlier.scannedAt}.` : '';
  const counts = `${scope.filter(item => item.eligible).length} of ${scope.length} observed items are eligible for a cleanup plan.`;
  const summary = [
    request.kind === 'capacity' ? capacity + change : selected ? scope[0].reason : counts,
    current.complete ? '' : 'The scanner did not complete the inventory.',
  ].filter(Boolean).join(' ');
  const evidence: Evidence = {
    id: randomUUID(),
    kind: request.kind,
    createdAt: new Date(now).toISOString(),
    snapshotId: current.id,
    summary,
    itemIds: scope.map(item => item.id),
  };
  const questions: Question[] = [];
  if (!current.complete || (request.kind === 'eligibility' && selected && selected.inUse === undefined && !scope[0].eligible)) {
    const question = await raiseQuestion(tx, state, {
      text: current.complete ? 'Who can confirm whether this item is in use?' : 'Who can confirm that the scanner can inspect this drive?',
      itemId: selected?.id,
      fingerprint: current.complete ? `holder:${selected?.id}:${selected?.decisionMaterial}` : 'incomplete-inventory',
      external: current.complete && selected?.visibility === 'jev',
      now,
    });
    if (!question.answer) questions.push(question);
  }
  const b = new SurfaceBuilder();
  const child: Child = {
    id: randomUUID(),
    driveId: drive.id,
    kind: request.kind,
    createdAt: evidence.createdAt,
    status: 'done',
    summary,
    evidenceIds: [evidence.id],
    questionIds: questions.map(question => question.id),
    a2ui: [],
  };
  b.column([b.text(summary), ...questions.map(question => b.text(question.text, 'caption'))], 'root');
  child.a2ui = b.build(surfaceId('storage_investigation', child.id));
  await tx.insert(drive.id, 'evidence', evidence);
  await tx.insert(drive.id, 'child', child);
  return child;
}
