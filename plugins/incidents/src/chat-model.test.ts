import { describe, expect, it } from 'vitest';
import { CHAT, MODELS } from './chat.fixture';
import {
  cleanErrorText,
  FAVOURITES,
  groupByProvider,
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
    expect(list.models).toEqual([{ id: 'a/b', route: 'a', model: 'b', name: 'b' }]);
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
    expect(providerIcon('kimi')).toBe('mdi:robot-outline');
  });
  it('groups by provider in first-seen order', () => {
    expect(groupByProvider(MODELS).map(g => g.route)).toEqual(['claude', 'codex', 'kimi']);
  });
  it('lists a provider, favourites, or grouped search results', () => {
    expect(pickerRows(MODELS, 'claude', '', [])[0].models).toHaveLength(2);
    expect(pickerRows(MODELS, FAVOURITES, '', [])).toEqual([]);
    expect(pickerRows(MODELS, FAVOURITES, '', ['kimi/k2'])[0].models[0].id).toBe('kimi/k2');
    const found = pickerRows(MODELS, 'claude', 'gpt', []);
    expect(found).toHaveLength(1);
    expect(found[0].group).toBe('Codex');
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
