import { describe, expect, it } from 'vitest';
import {
  ALL_APP_ICONS,
  baseName,
  iconForContainer,
  iconForNamespace,
  iconForProcess,
} from './appIcons';
import { BUNDLED_ICONS } from './bundledIcons.generated';

const name = (i: { kind: string; name?: string }) => `${i.kind}:${i.name}`;

describe('baseName', () => {
  it('takes the last path segment, lower case, without script extension or version', () => {
    expect(baseName('/usr/bin/Node')).toBe('node');
    expect(baseName('/opt/py/bin/python3.12')).toBe('python');
    expect(baseName('codex.js')).toBe('codex');
    expect(baseName('/usr/lib/node_modules/@openai/codex/bin/codex.js')).toBe('codex');
    expect(baseName('"/usr/bin/git"')).toBe('git');
    expect(baseName('go')).toBe('go');
  });
});

describe('iconForProcess', () => {
  it('matches the program of a full path with arguments, case-insensitively', () => {
    expect(name(iconForProcess('/usr/bin/GIT status --short'))).toBe('simple-icons:git');
    expect(name(iconForProcess('/usr/bin/redis-server *:6379'))).toBe('simple-icons:redis');
    expect(name(iconForProcess('/usr/sbin/nginx -g daemon off;'))).toBe('simple-icons:nginx');
    expect(name(iconForProcess('python3.12 -m http.server'))).toBe('simple-icons:python');
  });

  it('looks through interpreters and launchers to the program they run', () => {
    expect(name(iconForProcess('node /usr/lib/node_modules/@openai/codex/bin/codex.js'))).toBe(
      'simple-icons:openai'
    );
    expect(name(iconForProcess('bun run vite --host'))).toBe('simple-icons:vite');
    expect(name(iconForProcess('sh -c claude --resume'))).toBe('simple-icons:claude');
    expect(name(iconForProcess('node server.js'))).toBe('simple-icons:nodedotjs');
  });

  it('covers the listed programs', () => {
    const cases: Record<string, string> = {
      npm: 'npm',
      deno: 'deno',
      cargo: 'rust',
      java: 'openjdk',
      kimi: 'kimi',
      gh: 'github',
      zsh: 'zsh',
      firefox: 'firefox',
      chromium: 'googlechrome',
      postgres: 'postgresql',
      caddy: 'caddy',
      traefik: 'traefikproxy',
      vmagent: 'victoriametrics',
      containerd: 'containerd',
      sqlite3: 'sqlite',
      podman: 'podman',
      esbuild: 'esbuild',
      tsc: 'typescript',
      playwright: 'playwright',
      ffmpeg: 'ffmpeg',
    };
    for (const [cmd, icon] of Object.entries(cases)) {
      expect(name(iconForProcess(`/usr/bin/${cmd} --x`))).toBe(`simple-icons:${icon}`);
    }
    expect(name(iconForProcess('herdr serve'))).toBe('mdi:sheep');
    expect(name(iconForProcess('systemd --user'))).toBe('mdi:linux');
  });

  it('falls back to the generic process icon', () => {
    expect(name(iconForProcess('/opt/unknown/thing --flag'))).toBe('mdi:cog-outline');
    expect(name(iconForProcess(''))).toBe('mdi:cog-outline');
    expect(name(iconForProcess('node'))).toBe('simple-icons:nodedotjs');
  });
});

describe('iconForContainer and iconForNamespace', () => {
  it('matches the container name, then its parts, then the namespace', () => {
    expect(name(iconForContainer('grafana', 'monitoring'))).toBe('simple-icons:grafana');
    expect(name(iconForContainer('Argocd-Server', 'x'))).toBe('simple-icons:argo');
    expect(name(iconForContainer('sidecar', 'argocd'))).toBe('simple-icons:argo');
    expect(name(iconForContainer('kubelet', 'kube-system'))).toBe('simple-icons:kubernetes');
    expect(name(iconForContainer('coredns', 'kube-system'))).toBe('mdi:dns');
  });

  it('falls back to the generic container and namespace icons', () => {
    expect(name(iconForContainer('app', 'shop'))).toBe('mdi:cube-outline');
    expect(name(iconForNamespace('shop'))).toBe('mdi:view-grid-outline');
    expect(name(iconForNamespace('argocd'))).toBe('simple-icons:argo');
  });
});

describe('bundled icons', () => {
  it('has every icon the table returns and the UI names, so none is fetched', () => {
    const ui = ['kubernetes', 'console', 'robot', 'folder', 'cog', 'arrow-up', 'magnify-plus', 'fullscreen-exit'];
    const used = [...ALL_APP_ICONS.map(i => [i.kind, i.name]), ...ui.map(n => ['mdi', n])];
    expect(used.length).toBeGreaterThan(40);
    for (const [prefix, n] of used) {
      expect(BUNDLED_ICONS[prefix as string]?.[n as string], `${prefix}:${n}`).toBeTruthy();
    }
  });
});
