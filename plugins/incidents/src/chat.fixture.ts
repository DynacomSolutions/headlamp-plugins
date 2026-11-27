import type { ChatDetail, ModelOption } from './chat-model';

const pool = (route: string, model: string, name: string, contextWindow?: number): ModelOption => ({
  id: `${route}/${model}`,
  route,
  model,
  name,
  provider: route,
  identity: 'Pool',
  ...(contextWindow ? { contextWindow } : {}),
});

export const MODELS: ModelOption[] = [
  pool('claude', 'opus', 'Claude Opus', 200000),
  pool('claude', 'sonnet', 'Claude Sonnet', 200000),
  pool('codex', 'gpt-5', 'GPT 5', 400000),
  pool('kimi', 'k2', 'Kimi K2'),
];

/** The same list with a second Claude identity, a pinned account, as the agent lists it when it has two Claude routes. */
export const MODELS_TWO_IDENTITIES: ModelOption[] = [
  ...MODELS,
  { id: 'claude-pinned/opus', route: 'claude-pinned', model: 'opus', name: 'Claude Opus', provider: 'claude', identity: 'Account A', contextWindow: 200000 },
  { id: 'claude-pinned/sonnet', route: 'claude-pinned', model: 'sonnet', name: 'Claude Sonnet', provider: 'claude', identity: 'Account A', contextWindow: 200000 },
];

export const CHAT: ChatDetail = {
  id: 'c1',
  title: 'Why is api failing',
  model: 'claude/sonnet',
  diagnosisId: 'd9',
  createdAt: '2026-11-19T10:00:00Z',
  updatedAt: '2026-11-19T10:01:00Z',
  running: false,
  messages: [
    {
      id: 'm1',
      role: 'user',
      text: 'Why is api failing?',
      createdAt: '2026-11-19T10:00:00Z',
      status: 'done',
      steps: [],
    },
    {
      id: 'm2',
      role: 'assistant',
      text: 'The **api** pod is out of memory.\n\n```\nkubectl top pod api\n```',
      createdAt: '2026-11-19T10:00:30Z',
      status: 'done',
      model: 'claude/sonnet',
      steps: [
        {
          id: 's1',
          tool: 'get_pods',
          reason: 'List the pods',
          ok: true,
          summary: '3 pods',
          status: 'done',
        },
        {
          id: 's2',
          tool: 'get_logs',
          reason: 'Read the logs',
          ok: false,
          summary: 'denied',
          status: 'done',
        },
      ],
    },
  ],
};
