import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request } }));

import {
  backendIconUrl,
  clearIconCache,
  iconLinks,
  loadBackendIcon,
  proxyBase,
  resolveIconHref,
} from './iconApi';

const backend = { namespace: 'shop', name: 'web', port: '80' };
const base = '/api/v1/namespaces/shop/services/web:80/proxy/';

const html = (body: string, type = 'text/html') =>
  new Response(body, { status: 200, headers: { 'content-type': type } });
const image = (type: string, bytes = 8) =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': type } });

beforeEach(() => {
  request.mockReset();
  clearIconCache();
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:icon', revokeObjectURL: () => undefined })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('proxyBase', () => {
  it('builds the Service proxy path, with a scheme and a port name', () => {
    expect(proxyBase(backend)).toBe(base);
    expect(proxyBase({ namespace: 'a', name: 'b' })).toBe('/api/v1/namespaces/a/services/b/proxy/');
    expect(proxyBase({ namespace: 'a', name: 'b', port: '443', scheme: 'https' })).toBe(
      '/api/v1/namespaces/a/services/https:b:443/proxy/'
    );
  });
});

describe('iconLinks', () => {
  it('ranks SVG before PNG before ICO before a touch icon, and reads either quote style', () => {
    const links = iconLinks(`
      <link rel="apple-touch-icon" href="/t.png">
      <link rel='shortcut icon' href='/f.ico'>
      <link rel="icon" type="image/png" href="/f.png" sizes="32x32">
      <link rel="icon" href="/f.svg">
      <link rel="mask-icon" href="/m.svg">
      <link rel="stylesheet" href="/a.css">`);
    expect(links.map(l => l.href)).toEqual(['/f.svg', '/f.png', '/f.ico', '/t.png']);
  });
  it('prefers the smallest PNG that is at least 32 px, and decodes entities', () => {
    const links = iconLinks(`
      <link rel="icon" type="image/png" href="/16.png" sizes="16x16">
      <link rel="icon" type="image/png" href="/192.png" sizes="192x192">
      <link rel="icon" type="image/png" href="/32.png" sizes="32x32">
      <link rel="icon" href="data:image/svg+xml,%3Csvg fill=&#39;red&#39;/%3E">`);
    expect(links.map(l => l.href)).toEqual([
      "data:image/svg+xml,%3Csvg fill='red'/%3E",
      '/32.png',
      '/192.png',
      '/16.png',
    ]);
  });
  it('skips an empty data icon and a link with no href', () => {
    expect(iconLinks('<link rel="icon" href="data:,"><link rel="icon">')).toEqual([]);
  });
});

describe('resolveIconHref', () => {
  it('keeps API paths and data images, and reads other paths against the Service', () => {
    expect(resolveIconHref('/api/v1/namespaces/shop/services/web:80/proxy/i.svg', base)).toBe(
      '/api/v1/namespaces/shop/services/web:80/proxy/i.svg'
    );
    expect(resolveIconHref('assets/i.png', base)).toBe(`${base}assets/i.png`);
    expect(resolveIconHref('./i.png?v=2', base)).toBe(`${base}i.png?v=2`);
    expect(resolveIconHref('/i.png', base)).toBe(`${base}i.png`);
    expect(resolveIconHref('data:image/svg+xml,%3Csvg/%3E', base)).toBe(
      'data:image/svg+xml,%3Csvg/%3E'
    );
  });
  it('drops an external address, a scheme-relative address, a climb out and a script', () => {
    for (const h of [
      'https://cdn.example.com/i.png',
      'http://example.com/i.png',
      '//cdn.example.com/i.png',
      '../other/i.png',
      'a/../../i.png',
      'javascript:alert(1)',
      'data:text/html,x',
    ]) {
      expect(resolveIconHref(h, base)).toBeUndefined();
    }
  });
});

describe('loadBackendIcon', () => {
  it('reads the start page, then the best icon, both through the Service proxy', async () => {
    request.mockImplementation(async (url: string) => {
      if (url === base) return html('<link rel="icon" type="image/svg+xml" href="favicon.svg">');
      if (url === `${base}favicon.svg`) return image('image/svg+xml');
      throw new Error(`unexpected ${url}`);
    });
    const blob = await loadBackendIcon(backend);
    expect(blob?.type).toBe('image/svg+xml');
    expect(request.mock.calls.map(c => c[0])).toEqual([base, `${base}favicon.svg`]);
  });
  it('tries the next icon when one is not an image, and gives null when none works', async () => {
    request.mockImplementation(async (url: string) => {
      if (url === base)
        return html('<link rel="icon" href="/a.svg"><link rel="icon" href="/b.png">');
      if (url.endsWith('a.svg')) return html('<html>spa fallback</html>');
      if (url.endsWith('b.png')) return image('image/png');
      throw new Error('x');
    });
    expect((await loadBackendIcon(backend))?.type).toBe('image/png');
    request.mockImplementation(async (url: string) => {
      if (url === base) return html('<link rel="icon" href="https://cdn.example.com/a.png">');
      throw new Error('404');
    });
    expect(await loadBackendIcon(backend)).toBeNull();
    // The external address was never requested.
    expect(request.mock.calls.every(c => !String(c[0]).includes('cdn.example.com'))).toBe(true);
  });
  it('falls back to the default favicon places when the page names no icon that loads', async () => {
    request.mockImplementation(async (url: string) => {
      if (url === base) return html('<title>no icon</title>');
      if (url === `${base}favicon.png`) return image('image/png');
      throw new Error('404');
    });
    expect((await loadBackendIcon(backend))?.type).toBe('image/png');
    expect(request.mock.calls.map(c => c[0])).toEqual([base, `${base}favicon.svg`, `${base}favicon.png`]);
  });
  it('never follows a redirect and never logs the user out on an app answer of 401', async () => {
    request.mockResolvedValue(html('<title>x</title>'));
    await loadBackendIcon(backend);
    for (const [, init] of request.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', autoLogoutOnAuthError: false, isJSON: false });
    }
  });
  it('gives null when the page or the icon is missing, too large or not an image', async () => {
    request.mockRejectedValue(Object.assign(new Error('nope'), { status: 404 }));
    expect(await loadBackendIcon(backend)).toBeNull();
    request.mockImplementation(async (url: string) =>
      url === base ? html('<link rel="icon" href="/big.png">') : image('image/png', 200 * 1024)
    );
    expect(await loadBackendIcon(backend)).toBeNull();
  });
  it('reads an inline data icon with no further request', async () => {
    request.mockResolvedValue(
      html('<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns=%27x%27/%3E">')
    );
    expect((await loadBackendIcon(backend))?.type).toBe('image/svg+xml');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('backendIconUrl', () => {
  it('asks a Service once and shares the answer, and retries a failure only after a while', async () => {
    request.mockImplementation(async (url: string) =>
      url === base ? html('<link rel="icon" href="/i.svg">') : image('image/svg+xml')
    );
    const [a, b] = await Promise.all([backendIconUrl(backend, 0), backendIconUrl(backend, 0)]);
    expect(a).toBe('blob:icon');
    expect(b).toBe('blob:icon');
    await backendIconUrl(backend, 1000);
    expect(request).toHaveBeenCalledTimes(2);

    clearIconCache();
    request.mockReset();
    request.mockRejectedValue(new Error('down'));
    const t0 = Date.now();
    expect(await backendIconUrl(backend, t0)).toBeNull();
    const calls = request.mock.calls.length;
    expect(await backendIconUrl(backend, t0 + 1000)).toBeNull();
    expect(request.mock.calls.length).toBe(calls);
    expect(await backendIconUrl(backend, t0 + 6 * 60_000)).toBeNull();
    expect(request.mock.calls.length).toBeGreaterThan(calls);
  });
});
