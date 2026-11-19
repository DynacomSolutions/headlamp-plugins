import type { ChatDetail, ModelOption } from './chat-model';

export const MODELS: ModelOption[] = [
  { id: 'claude/opus', route: 'claude', model: 'opus', name: 'Claude Opus' },
  { id: 'claude/sonnet', route: 'claude', model: 'sonnet', name: 'Claude Sonnet' },
  { id: 'codex/gpt-5', route: 'codex', model: 'gpt-5', name: 'GPT 5' },
  { id: 'kimi/k2', route: 'kimi', model: 'k2', name: 'Kimi K2' },
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
