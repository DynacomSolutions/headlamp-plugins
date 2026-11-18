import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';
import { getPointer, setPointer } from './pointer';
import { A2uiRenderer, ICONS } from './Renderer';
import { sampleDiagnosis } from './sample.fixture';
import { applyMessage, emptyState, processMessages } from './state';
import type { A2uiMessage } from './types';
import { resolveChildren, resolveString } from './values';

const create = (extra: Record<string, unknown> = {}): A2uiMessage => ({
  version: '1.0',
  createSurface: {
    surfaceId: 's1',
    components: [{ id: 'root', component: 'Text', text: 'hello' }],
    dataModel: { a: { b: 1 }, items: [{ n: 'x' }, { n: 'y' }] },
    ...extra,
  },
});

describe('message processor', () => {
  it('creates, merges components, updates data and deletes', () => {
    let s = applyMessage(emptyState(), create());
    expect(Object.keys(s.surfaces)).toEqual(['s1']);
    s = applyMessage(s, {
      version: '1.0',
      updateComponents: {
        surfaceId: 's1',
        components: [
          { id: 'root', component: 'Text', text: 'bye' },
          { id: 'x', component: 'Divider' },
        ],
      },
    });
    expect(s.surfaces.s1.components.root.text).toBe('bye');
    expect(s.surfaces.s1.components.x).toBeDefined();
    s = applyMessage(s, {
      version: '1.0',
      updateDataModel: { surfaceId: 's1', path: '/a/b', value: 2 },
    });
    expect(getPointer(s.surfaces.s1.dataModel, '/a/b')).toBe(2);
    s = applyMessage(s, {
      version: '1.0',
      updateDataModel: { surfaceId: 's1', path: '/a', value: null },
    });
    expect(getPointer(s.surfaces.s1.dataModel, '/a')).toBeUndefined();
    s = applyMessage(s, {
      version: '1.0',
      updateDataModel: { surfaceId: 's1', value: { whole: true } },
    });
    expect(s.surfaces.s1.dataModel).toEqual({ whole: true });
    s = applyMessage(s, { version: '1.0', deleteSurface: { surfaceId: 's1' } });
    expect(s.surfaces).toEqual({});
  });

  it('warns about other versions and does not apply them', () => {
    const s = processMessages([{ version: '0.9', createSurface: { surfaceId: 's1' } }]);
    expect(s.surfaces).toEqual({});
    expect(s.warnings[0]).toMatch(/unsupported version/);
  });

  it('does not mutate earlier data and escapes pointer tokens', () => {
    const before = { 'a/b': { c: 1 } };
    const after = setPointer(before, '/a~1b/c', 5);
    expect(before['a/b'].c).toBe(1);
    expect(getPointer(after, '/a~1b/c')).toBe(5);
    expect(setPointer({}, '/__proto__/x', 1)).toEqual({});
  });
});

describe('dynamic values and templates', () => {
  const data = { title: 'T', items: [{ n: 'x' }, { n: 'y' }] };
  it('resolves literals, absolute and relative paths', () => {
    expect(resolveString('lit', { data })).toBe('lit');
    expect(resolveString({ '@path': '/title' }, { data })).toBe('T');
    expect(resolveString({ '@path': 'n' }, { data, base: '/items/1' })).toBe('y');
    expect(resolveString({ '@path': '/missing' }, { data })).toBe('');
    expect(resolveString({ '@call': 'now' }, { data })).toBe('');
  });
  it('expands template children per item with item scope', () => {
    const refs = resolveChildren({ path: '/items', componentId: 'row' }, { data });
    expect(refs.map(r => r.scope.base)).toEqual(['/items/0', '/items/1']);
    expect(resolveChildren({ path: '/title', componentId: 'row' }, { data })).toEqual([]);
  });
  it('renders template items', () => {
    const msgs: A2uiMessage[] = [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 's',
          dataModel: data,
          components: [
            { id: 'item', component: 'Text', text: { '@path': 'n' } },
            { id: 'root', component: 'List', children: { path: '/items', componentId: 'item' } },
          ],
        },
      },
    ];
    render(<A2uiRenderer messages={msgs} />);
    expect(screen.getByText('x')).toBeTruthy();
    expect(screen.getByText('y')).toBeTruthy();
  });
});

describe('markdown', () => {
  it('shows HTML as text', () => {
    const { container } = render(
      <div>{renderMarkdown('<script>alert(1)</script> and <img src=x onerror=y>')}</div>
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });
  it('renders headings, emphasis, code, bullets and plain links', () => {
    const { container } = render(
      <div>
        {renderMarkdown('## Title\n**b** _i_ `c`\n- one\n- two\n[label](https://example.com/x)')}
      </div>
    );
    expect(container.querySelector('[role=heading]')?.textContent).toBe('Title');
    expect(container.querySelector('strong')?.textContent).toBe('b');
    expect(container.querySelector('em')?.textContent).toBe('i');
    expect(container.querySelector('code')?.textContent).toBe('c');
    expect(container.querySelectorAll('li').length).toBe(2);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('label');
    expect(container.textContent).not.toContain('example.com');
  });
});

describe('components', () => {
  const one = (
    component: Record<string, unknown>,
    extra: Record<string, unknown>[] = []
  ): A2uiMessage[] => [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 's',
        components: [{ id: 'root', ...component } as never, ...(extra as never[])],
      },
    },
  ];
  it('opens http(s) urls only through Button openUrl', () => {
    const btn = (url: string) =>
      one(
        {
          component: 'Button',
          child: 't',
          action: { functionCall: { call: 'openUrl', args: { url } } },
        },
        [{ id: 't', component: 'Text', text: 'Go' }]
      );
    const ok = render(<A2uiRenderer messages={btn('https://example.com/a')} />);
    const a = ok.container.querySelector('a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://example.com/a');
    expect(a.getAttribute('rel')).toContain('noopener');
    expect(a.getAttribute('target')).toBe('_blank');
    ok.unmount();
    const bad = render(<A2uiRenderer messages={btn('javascript:alert(1)')} />);
    expect(bad.container.querySelector('a')).toBeNull();
    expect(bad.container.querySelector('button')?.hasAttribute('disabled')).toBe(true);
  });
  it('falls back for unknown components, missing ids, cycles and http images', () => {
    render(<A2uiRenderer messages={one({ component: 'Carousel' })} />);
    expect(screen.getByText(/Unsupported component: Carousel/)).toBeTruthy();
  });
  it('survives a cycle and a missing child', () => {
    const msgs = one({ component: 'Card', child: 'root' });
    render(<A2uiRenderer messages={msgs} />);
    expect(screen.getAllByText(/too deep/).length).toBe(1);
    const missing = render(
      <A2uiRenderer messages={one({ component: 'Column', children: ['nope'] })} />
    );
    expect(missing.container.textContent).toContain('Missing component nope');
  });
  it('only shows https images', () => {
    const http = render(
      <A2uiRenderer
        messages={one({ component: 'Image', url: 'http://example.com/a.png', description: 'a' })}
      />
    );
    expect(http.container.querySelector('img')).toBeNull();
    http.unmount();
    const https = render(
      <A2uiRenderer
        messages={one({ component: 'Image', url: 'https://example.com/a.png', description: 'pic' })}
      />
    );
    expect(https.container.querySelector('img')?.getAttribute('alt')).toBe('pic');
  });
  it('maps the catalog icons', () => {
    expect(ICONS.warning).toBe('mdi:alert');
    expect(ICONS.error).toBe('mdi:alert-circle');
  });
});

describe('sample diagnosis surface', () => {
  it('renders the report and switches tabs', () => {
    render(<A2uiRenderer messages={sampleDiagnosis} />);
    expect(screen.getByText('NodeDiskPressure')).toBeTruthy();
    expect(screen.getByText('Disk on worker-1 is nearly full')).toBeTruthy();
    expect(screen.getByText('The image cache filled /var on worker-1.')).toBeTruthy();
    expect(screen.getByText('Prune unused images')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Evidence trail (2)' }));
    expect(screen.getByText('node_filesystem_avail at 4%')).toBeTruthy();
    expect(screen.getByText(/kubectl_get/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Alert' }));
    expect(screen.getByText('Disk usage above 95%.')).toBeTruthy();
  });
});
