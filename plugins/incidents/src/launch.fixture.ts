/** A sample launch, as GET /api/launches/<id> answers it. */
export const LAUNCH = {
  id: 'l1',
  purpose: 'Apply the DNS placement plan',
  source: { diagnosisId: 'd1', fix: { index: 0, title: 'Apply the DNS placement plan' } },
  brief: '## Purpose\nApply the DNS placement plan',
  projectKey: 'default',
  threadId: 'thread-1',
  model: { instanceId: 'provider-0', model: 'model-0' },
  status: 'running',
  requestedBy: 'alice',
  requestedAt: '2026-11-20T07:00:00.000Z',
  decidedAt: '2026-11-20T07:00:10.000Z',
  decidedBy: 'bob',
  startedAt: '2026-11-20T07:00:12.000Z',
  threadLink: 'https://t3.example.com/thread/thread-1',
  lastReply: 'I **checked** the records.\n\n- app.example.com: fixed',
  timeline: [
    {
      id: 'r1',
      kind: 'run',
      title: 'Run 1',
      detail: 'running',
      status: 'running',
      startedAt: '2026-11-20T07:00:12.000Z',
    },
    {
      id: 'm1',
      kind: 'message',
      title: 'Operator message',
      detail: 'Apply the DNS placement plan',
      status: 'done',
      startedAt: '2026-11-20T07:00:12.000Z',
    },
    {
      id: 't1',
      kind: 'tool',
      title: 'dig app.example.com',
      detail: '$ dig app.example.com\n192.0.2.1\nexit code 0',
      status: 'done',
      startedAt: '2026-11-20T07:00:14.000Z',
      finishedAt: '2026-11-20T07:00:16.000Z',
    },
    {
      id: 'f1',
      kind: 'file_change',
      title: 'notes.txt',
      detail: '+3 -1\n@@ -1 +1,3 @@',
      status: 'failed',
      startedAt: '2026-11-20T07:00:17.000Z',
      finishedAt: '2026-11-20T07:00:18.000Z',
    },
    {
      id: 't2',
      kind: 'tool',
      title: 'kubectl get nodes',
      status: 'running',
      startedAt: '2026-11-20T07:00:20.000Z',
    },
  ],
};

export const CONFIG = {
  enabled: true,
  projects: [
    { key: 'default', title: 'Main project' },
    { key: 'other', title: 'Other project' },
  ],
  model: { instanceId: 'provider-0', model: 'model-0' },
  threadUrlTemplate: 'https://t3.example.com/thread/{threadId}',
};

const { timeline, brief, lastReply, threadId, ...rest } = LAUNCH;
void timeline;
void brief;
void lastReply;
void threadId;
export const SUMMARY = { ...rest, steps: LAUNCH.timeline.length };
