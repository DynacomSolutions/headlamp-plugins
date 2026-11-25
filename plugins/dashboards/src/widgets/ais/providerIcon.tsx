/*
 * The official logo of an AI provider, drawn from the plugin (see `providerIcons.generated.ts`), never
 * fetched. A logo that has one colour of its own keeps it. A logo with no colour uses the text colour of
 * its place, so it reads on the black kiosk and on the light theme. A name with no known provider draws
 * nothing: there is no letter tile and no made-up mark.
 */
import React from 'react';
import { PROVIDER_LOGOS } from './providerIcons.generated';

/** The logo id of each provider name, after `canon`. One logo can have more than one name. */
const ALIASES: Record<string, string> = {
  claude: 'claude',
  claudecode: 'claude',
  agentpool: 'claude',
  anthropic: 'anthropic',
  openai: 'openai',
  codex: 'openai',
  chatgpt: 'openai',
  kimi: 'kimi',
  moonshot: 'kimi',
  moonshotai: 'kimi',
  opencode: 'opencode',
  opencodego: 'opencode',
  xai: 'xai',
  grok: 'xai',
  zai: 'zai',
  pi: 'pi',
  ali: 'alibaba',
  alibaba: 'alibaba',
  alibabacloud: 'alibaba',
  qwen: 'alibaba',
  google: 'google',
  gemini: 'google',
};

const canon = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The logo id for a provider name such as "OpenCode Go", "Codex" or "Z.ai", or undefined. */
export function providerLogoKey(name: string | undefined): string | undefined {
  return name === undefined ? undefined : ALIASES[canon(name)];
}

/**
 * The logo id for a label that holds a provider name as one of its parts, for example
 * "claude-dynacom" or "Anthropic / dynacom". The whole label counts first, then each part.
 */
export function providerLogoIn(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  const whole = providerLogoKey(label);
  if (whole) return whole;
  for (const part of label.split(/[\s/,:()_-]+/)) {
    const key = providerLogoKey(part);
    if (key) return key;
  }
  return undefined;
}

/** True for the id of a source that serves the AIS panels (the default is `ais-console`). */
export const isAisSource = (id: string | undefined): boolean => !!id && /^ais(-|$)/.test(id);

export const PROVIDER_ICON_SIZE = 14;

/** The logo of a provider, or nothing when the name has no logo. `name` is a provider name. */
export function ProviderIcon(props: {
  /** A provider name, or a logo id. */
  name: string | undefined;
  size?: number;
  /** The place of the logo when it sits inside another SVG (the ring labels of a sunburst). */
  x?: number;
  y?: number;
  /** Hide the logo from screen readers, because the provider name is next to it. Default on. */
  decorative?: boolean;
}): JSX.Element | null {
  const { name, size = PROVIDER_ICON_SIZE, x, y, decorative = true } = props;
  const key = providerLogoKey(name) ?? providerLogoIn(name);
  const logo = key ? PROVIDER_LOGOS[key] : undefined;
  if (!key || !logo) return null;
  return (
    <svg
      data-provider-icon={key}
      x={x}
      y={y}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : logo.brand}
      focusable="false"
      style={{ flex: 'none', display: 'block' }}
    >
      {logo.paths.map((p, i) => (
        <path key={i} d={p.d} fill={p.fill} fillRule={p.fillRule} clipRule={p.clipRule} />
      ))}
    </svg>
  );
}

/**
 * The logo of a label that is a provider name or the pool (Claude), or null when it is none. The
 * charts use it for the legend rows, the ring labels and the slice groups. `at` places the logo
 * inside an SVG.
 */
export const labelLogo = (
  label: string,
  size: number,
  at?: { x: number; y: number }
): JSX.Element | null =>
  providerLogoKey(label) ? <ProviderIcon name={label} size={size} x={at?.x} y={at?.y} /> : null;

/**
 * Like `labelLogo`, and the name of a swap pool also gets the Claude logo, because every swap pool
 * is a pool of Claude logins.
 */
export const poolLabelLogo =
  (pools: ReadonlySet<string>) =>
  (label: string, size: number, at?: { x: number; y: number }): JSX.Element | null =>
    pools.has(label) ? (
      <ProviderIcon name="claude" size={size} x={at?.x} y={at?.y} />
    ) : (
      labelLogo(label, size, at)
    );
