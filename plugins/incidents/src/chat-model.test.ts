import { describe, expect, it } from 'vitest';
import { CHAT, MODELS, MODELS_TWO_IDENTITIES } from './chat.fixture';
import {
  cleanErrorText,
  contextShare,
  FAVOURITES,
  formatCost,
  formatDuration,
  formatTokens,
  identityInitials,
  instancesOf,
  parseChat,
  parseChats,
  parseModels,
  pickerRows,
  providerIcon,
  providerName,
  relativeTime,
} from './chat-model';

describe('parsing', () => {
  it('parses models and fills route and model from the id', () => {
    const list = parseModels({ default: 'a/b', models: [{ id: 'a/b' }, { nope: 1 }] });
    expect(list.default).toBe('a/b');
    expect(list.models).toEqual([{ id: 'a/b', route: 'a', model: 'b', name: 'b', provider: 'a', identity: 'Pool' }]);
    const rich = parseModels({ models: [{ id: 'x/y', provider: 'claude', identity: 'Account A', contextWindow: 1000 }] }).models[0];
    expect(rich).toMatchObject({ route: 'x', provider: 'claude', identity: 'Account A', contextWindow: 1000, identityListed: true });
    expect(parseModels(null)).toEqual({ default: '', models: [] });
  });
  it('sorts chats newest first', () => {
    const chats = parseChats({
      chats: [
        { id: 'a', updatedAt: '2026-01-01T00:00:00Z' },
        { id: 'b', updatedAt: '2026-02-01T00:00:00Z', running: true },
        { title: 'no id' },
      ],
    });
    expect(chats.map(c => c.id)).toEqual(['b', 'a']);
    expect(chats[0].running).toBe(true);
  });
  it('parses a chat with messages and steps', () => {
    const c = parseChat(JSON.parse(JSON.stringify(CHAT)));
    expect(c.messages).toHaveLength(2);
    expect(c.messages[1].steps[1].ok).toBe(false);
    expect(parseChat({ messages: [{ role: 'x', status: 'weird' }] }).messages[0]).toMatchObject({
      role: 'assistant',
      status: 'done',
      steps: [],
    });
  });
});

describe('picker helpers', () => {
  it('names and icons providers', () => {
    expect(providerName('zai')).toBe('Z.ai');
    expect(providerName('other')).toBe('other');
    expect(providerIcon('claude')).toBe('simple-icons:anthropic');
    expect(providerIcon('other')).toBe('mdi:robot-outline');
  });
  it('gives every known provider its own icon', () => {
    const routes = ['claude', 'codex', 'grok', 'kimi', 'opencode', 'zai'];
    const icons = routes.map(providerIcon);
    expect(new Set(icons).size).toBe(routes.length);
    expect(icons).not.toContain('mdi:robot-outline');
  });
  it('lists one instance per identity, in first-seen order, with a badge only when a provider has several', () => {
    expect(instancesOf(MODELS).map(i => i.route)).toEqual(['claude', 'codex', 'kimi']);
    expect(instancesOf(MODELS).some(i => i.showBadge)).toBe(false);
    const two = instancesOf(MODELS_TWO_IDENTITIES);
    expect(two.map(i => i.route)).toEqual(['claude', 'codex', 'kimi', 'claude-pinned']);
    expect(two.find(i => i.route === 'claude')).toMatchObject({ showBadge: true, badge: 'PO', label: 'Claude \u00b7 Pool' });
    expect(two.find(i => i.route === 'claude-pinned')).toMatchObject({ showBadge: true, badge: 'AA', label: 'Claude \u00b7 Account A' });
    expect(two.find(i => i.route === 'codex')?.showBadge).toBe(false);
    expect(identityInitials('Pool')).toBe('PO');
  });
  it('lists an identity, favourites, or search results across every identity', () => {
    expect(pickerRows(MODELS, 'claude', '', [])).toHaveLength(2);
    expect(pickerRows(MODELS, FAVOURITES, '', [])).toEqual([]);
    expect(pickerRows(MODELS, FAVOURITES, '', ['kimi/k2'])[0].id).toBe('kimi/k2');
    const found = pickerRows(MODELS, 'claude', 'gpt', []);
    expect(found.map(m => m.id)).toEqual(['codex/gpt-5']);
    expect(pickerRows(MODELS_TWO_IDENTITIES, 'claude', 'account a opus', []).map(m => m.id)).toEqual(['claude-pinned/opus']);
  });
  it('formats relative time', () => {
    const now = Date.parse('2026-11-19T12:00:00Z');
    expect(relativeTime('2026-11-19T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-11-19T11:30:00Z', now)).toBe('30 min ago');
    expect(relativeTime('2026-11-19T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('bad', now)).toBe('');
  });
});

describe('cleanErrorText', () => {
  it('strips a leading list marker and whitespace but keeps status and message', () => {
    expect(cleanErrorText(new Error('- 502 Bad Gateway: upstream down'))).toBe(
      '502 Bad Gateway: upstream down'
    );
    expect(cleanErrorText({ message: '  * 500 boom' })).toBe('500 boom');
    expect(cleanErrorText('\n- 404 Not found')).toBe('404 Not found');
  });
  it('leaves clean text alone and never returns an empty string', () => {
    expect(cleanErrorText(new Error('Network down'))).toBe('Network down');
    expect(cleanErrorText(new Error('- '))).toBe('Something went wrong.');
  });
});

describe('usage formats', () => {
  it('formats tokens, cost and duration', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(12345)).toBe('12k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
    expect(formatCost(0.0042)).toBe('$0.0042');
    expect(formatCost(0.0123)).toBe('$0.012');
    expect(formatCost(1.2849)).toBe('$1.28');
    expect(formatDuration(840)).toBe('840 ms');
    expect(formatDuration(12_000)).toBe('12 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });
  it('gives the context share only when the window is known', () => {
    expect(contextShare(50, 200)).toBe(0.25);
    expect(contextShare(500, 200)).toBe(1);
    expect(contextShare(50)).toBeUndefined();
  });
});
