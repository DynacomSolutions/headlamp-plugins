import { Icon } from '@iconify/react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Divider from '@mui/material/Divider';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import React from 'react';
import { renderMarkdown } from './markdown';
import { processMessages } from './state';
import { A2uiComponent, A2uiMessage, Surface } from './types';
import { resolveChildren, resolveString, Scope } from './values';

export const MAX_DEPTH = 50;

/** Basic catalog icon names mapped to Iconify icons. */
export const ICONS: Record<string, string> = {
  warning: 'mdi:alert',
  error: 'mdi:alert-circle',
  info: 'mdi:information',
  check: 'mdi:check-circle',
  refresh: 'mdi:refresh',
  help: 'mdi:help-circle',
  notifications: 'mdi:bell',
  search: 'mdi:magnify',
  settings: 'mdi:cog',
  event: 'mdi:calendar',
};

export function iconFor(name: unknown): string {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(ICONS, name)
    ? ICONS[name]
    : 'mdi:help-circle';
}

const JUSTIFY: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  spaceBetween: 'space-between',
  spaceAround: 'space-around',
  spaceEvenly: 'space-evenly',
  stretch: 'stretch',
};
const ALIGN: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
};

/** Returns the url when it is http(s), otherwise null. */
export function safeUrl(url: string, protocols: string[] = ['http:', 'https:']): string | null {
  try {
    const u = new URL(url);
    return protocols.includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The URL of an `openUrl` function call action, or null for any other action. */
export function openUrlOf(action: unknown, scope: Scope): string | null {
  const fc = (action as { functionCall?: { call?: unknown; args?: { url?: unknown } } } | undefined)
    ?.functionCall;
  if (!fc || fc.call !== 'openUrl') return null;
  return safeUrl(resolveString(fc.args?.url, scope));
}

interface Ctx {
  surface: Surface;
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      component="div"
      sx={{ fontStyle: 'italic' }}
    >
      {children}
    </Typography>
  );
}

function TabsView({
  tabs,
  scope,
  ctx,
  depth,
}: {
  tabs: unknown[];
  scope: Scope;
  ctx: Ctx;
  depth: number;
}) {
  const [index, setIndex] = React.useState(0);
  const items = tabs.filter(
    (t): t is { title: unknown; child: string } =>
      !!t && typeof t === 'object' && typeof (t as { child?: unknown }).child === 'string'
  );
  if (!items.length) return null;
  const active = Math.min(index, items.length - 1);
  return (
    <Box>
      <Tabs
        value={active}
        onChange={(_, v) => setIndex(v)}
        variant="scrollable"
        scrollButtons="auto"
      >
        {items.map((t, i) => (
          <Tab key={i} label={resolveString(t.title, scope)} />
        ))}
      </Tabs>
      <Box sx={{ pt: 2 }}>
        <Node id={items[active].child} scope={scope} ctx={ctx} depth={depth + 1} />
      </Box>
    </Box>
  );
}

function Children({
  spec,
  scope,
  ctx,
  depth,
}: {
  spec: unknown;
  scope: Scope;
  ctx: Ctx;
  depth: number;
}) {
  return (
    <>
      {resolveChildren(spec, scope).map(c => (
        <Node key={c.key} id={c.id} scope={c.scope} ctx={ctx} depth={depth + 1} />
      ))}
    </>
  );
}

function Node({ id, scope, ctx, depth }: { id: string; scope: Scope; ctx: Ctx; depth: number }) {
  if (depth > MAX_DEPTH) return <Note>Component tree too deep</Note>;
  const c: A2uiComponent | undefined = ctx.surface.components[id];
  if (!c) return <Note>Missing component {id}</Note>;
  const next = depth + 1;
  switch (c.component) {
    case 'Text': {
      const text = resolveString(c.text, scope);
      const caption = c.variant === 'caption';
      return (
        <Typography
          component="div"
          variant={caption ? 'caption' : 'body2'}
          color={caption ? 'text.secondary' : 'text.primary'}
          sx={{ overflowWrap: 'anywhere' }}
        >
          {renderMarkdown(text)}
        </Typography>
      );
    }
    case 'Row':
    case 'Column': {
      const row = c.component === 'Row';
      return (
        <Box
          sx={{
            display: 'flex',
            flexDirection: row ? 'row' : 'column',
            gap: 1,
            minWidth: 0,
            flexWrap: row ? 'wrap' : undefined,
            justifyContent: JUSTIFY[String(c.justify)],
            alignItems: ALIGN[String(c.align)] ?? (row ? undefined : 'stretch'),
            flex: typeof c.weight === 'number' ? c.weight : undefined,
          }}
        >
          <Children spec={c.children} scope={scope} ctx={ctx} depth={depth} />
        </Box>
      );
    }
    case 'List':
      return (
        <Box
          sx={{
            display: 'flex',
            flexDirection: c.direction === 'horizontal' ? 'row' : 'column',
            gap: 1.5,
            overflowX: c.direction === 'horizontal' ? 'auto' : undefined,
          }}
        >
          <Children spec={c.children} scope={scope} ctx={ctx} depth={depth} />
        </Box>
      );
    case 'Card':
      return (
        <Card variant="outlined">
          <CardContent>
            {typeof c.child === 'string' ? (
              <Node id={c.child} scope={scope} ctx={ctx} depth={next} />
            ) : null}
          </CardContent>
        </Card>
      );
    case 'Divider':
      return c.axis === 'vertical' ? <Divider orientation="vertical" flexItem /> : <Divider />;
    case 'Icon': {
      const name = resolveString(c.name, scope);
      return <Icon icon={iconFor(name)} width={24} height={24} aria-label={name || 'icon'} />;
    }
    case 'Tabs':
      return (
        <TabsView
          tabs={Array.isArray(c.tabs) ? c.tabs : []}
          scope={scope}
          ctx={ctx}
          depth={depth}
        />
      );
    case 'Button': {
      const url = openUrlOf(c.action, scope);
      const variant =
        c.variant === 'primary' ? 'contained' : c.variant === 'borderless' ? 'text' : 'outlined';
      const label =
        typeof c.child === 'string' ? (
          <Node id={c.child} scope={scope} ctx={ctx} depth={next} />
        ) : null;
      if (!url) {
        return (
          <Button variant={variant} disabled size="small">
            {label}
          </Button>
        );
      }
      return (
        <Button
          variant={variant}
          size="small"
          component="a"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {label}
        </Button>
      );
    }
    case 'Image': {
      const url = safeUrl(resolveString(c.url, scope), ['https:']);
      if (!url) return <Note>Image not shown</Note>;
      const alt = resolveString(c.description, scope);
      return <img src={url} alt={alt} style={{ maxWidth: '100%' }} referrerPolicy="no-referrer" />;
    }
    default:
      return <Note>Unsupported component: {String(c.component)}</Note>;
  }
}

export function SurfaceView({ surface }: { surface: Surface }) {
  const ctx = React.useMemo<Ctx>(() => ({ surface }), [surface]);
  if (!surface.components.root) return <Note>Surface has no root component</Note>;
  return <Node id="root" scope={{ data: surface.dataModel }} ctx={ctx} depth={0} />;
}

/** Renders every surface produced by a list of A2UI v1.0 messages. */
export function A2uiRenderer({ messages }: { messages: A2uiMessage[] }) {
  const state = React.useMemo(() => processMessages(messages), [messages]);
  const surfaces = Object.values(state.surfaces);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {state.warnings.map((w, i) => (
        <Alert key={i} severity="warning">
          {w}
        </Alert>
      ))}
      {surfaces.map(s => (
        <SurfaceView key={s.id} surface={s} />
      ))}
    </Box>
  );
}
