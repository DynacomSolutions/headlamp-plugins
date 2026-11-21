/*
 * Draws the HoardDB model (see `join.ts`): one tile for each engine, in a grid that wraps. A tile
 * has the engine icon in the middle of a ring, the engine name and its database count under it.
 * The ring has one section for each node that runs the engine, coloured by its status, with a dot
 * on the primary. The node name and status show on hover. A fixed legend names the nodes, and the
 * footer holds the summary. The tiles scroll when they do not fit: there is no "+N more" tile.
 * Every tile links only to the HoardDB tab of the dashboard.
 */
import Box from '@mui/material/Box';
import React from 'react';
import { ScrollArea } from '../../components/ScrollArea';
import { InternalLink, useResolveLink } from '../../links';
import { WidgetFooter } from '../footer';
import type { PanelStatus } from '../panels/model';
import { darkIconFilter, useRowIconUrl } from '../panels/RowIcon';
import type { PanelSource } from '../panels/sources';
import { StatusMark } from '../panels/StatusMark';
import { useTokens } from '../panels/tokens';
import { arcPath, TAU } from '../sunburst/geometry';
import { ENGINE_WORD, type HoardEngine, type HoardModel } from './join';

/** The ring, in the units of its 100 by 100 view box. */
export const RING = { outer: 46, inner: 35, gap: 0.07 } as const;

export interface Section {
  node: string;
  /** The instance name, when the source sends the `instances` field. */
  instance?: string;
  role?: string;
  status: PanelStatus;
  primary: boolean;
  path: string;
  /** The centre of the section, for the primary dot. */
  mid: [number, number];
}

/** The sections of a ring: equal sections with a small gap, clockwise from the top. */
export function sectionsOf(engine: HoardEngine): Section[] {
  const n = engine.nodes.length;
  if (n === 0) return [];
  const step = TAU / n;
  const gap = n === 1 ? 0 : RING.gap;
  const middle = (RING.outer + RING.inner) / 2;
  return engine.nodes.map((node, i) => {
    const start = i * step + gap / 2;
    const end = (i + 1) * step - gap / 2;
    const at = (start + end) / 2;
    return {
      node: node.name,
      instance: node.instance,
      role: node.role,
      status: node.status,
      primary: node.primary,
      path: arcPath(RING.inner, RING.outer, start, end),
      mid: [middle * Math.sin(at), -middle * Math.cos(at)],
    };
  });
}

/** The tooltip of a section: the instance name, node, role and status, and the reason if there is one. */
export const sectionTitle = (engine: HoardEngine, s: Section, note?: string): string =>
  s.instance !== undefined
    ? `${engine.name}, instance ${s.instance}, node ${s.node}, role ${
        s.role ?? 'unknown'
      }, status ${ENGINE_WORD[s.status].toLowerCase()}${note ? `, reason: ${note}` : ''}`
    : `${engine.name}, ${s.node}: ${ENGINE_WORD[s.status]}${s.primary ? ', primary' : ''}${
        note ? `. ${note}` : ''
      }`;

/** The tooltip of the icon: the engine with its count, and one line for each instance. */
export const engineTitle = (engine: HoardEngine): string =>
  [
    `${engine.name}: ${ENGINE_WORD[engine.status]}, ${engine.countText}`,
    ...engine.nodes.map(n =>
      n.instance !== undefined
        ? `${n.instance}, node ${n.name}, role ${n.role ?? 'unknown'}, status ${ENGINE_WORD[
            n.status
          ].toLowerCase()}${n.note ? `, reason: ${n.note}` : ''}`
        : `${n.name}: ${ENGINE_WORD[n.status]}${n.primary ? ', primary' : ''}${
            n.note ? `. ${n.note}` : ''
          }`
    ),
  ].join('\n');

function EngineRing(props: { engine: HoardEngine; source: PanelSource | undefined }): JSX.Element {
  const { engine, source } = props;
  const tk = useTokens();
  const url = useRowIconUrl(source, engine.icon);
  const sections = sectionsOf(engine);
  const track = tk.mode === 'dark' ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.07)';
  return (
    <Box
      data-hoard-ring
      sx={{ position: 'relative', width: '100%', maxWidth: 72, aspectRatio: '1 / 1', mx: 'auto' }}
    >
      <svg
        viewBox="-50 -50 100 100"
        width="100%"
        height="100%"
        role="img"
        aria-label={`${engine.name}: ${ENGINE_WORD[engine.status]}. ${engine.nodes
          .map(
            n =>
              `${n.instance !== undefined ? `${n.instance} on ` : ''}${n.name} ${
                ENGINE_WORD[n.status]
              }${n.primary ? ' (primary)' : ''}`
          )
          .join(', ')}`}
        style={{ display: 'block' }}
      >
        {/* The icon tooltip: the engine, its count and every instance. The circle catches the hover. */}
        <circle data-ring-hit r={RING.outer} fill="transparent">
          <title>{engineTitle(engine)}</title>
        </circle>
        {sections.length === 0 && <path d={arcPath(RING.inner, RING.outer, 0, TAU)} fill={track} />}
        {sections.map((s, i) => (
          <path
            key={`${s.instance ?? ''}/${s.node}`}
            data-section={s.node}
            data-instance={s.instance}
            data-section-status={s.status}
            data-primary={s.primary ? '' : undefined}
            d={s.path}
            fill={tk.status[s.status]}
            opacity={s.status === 'unknown' ? 0.55 : 1}
          >
            <title>{sectionTitle(engine, s, engine.nodes[i].note)}</title>
          </path>
        ))}
        {sections
          .filter(s => s.primary)
          .map(s => (
            <circle
              key={`p-${s.instance ?? ''}/${s.node}`}
              data-primary-dot
              cx={s.mid[0]}
              cy={s.mid[1]}
              r={3.2}
              fill={tk.mode === 'dark' ? '#101418' : '#ffffff'}
              pointerEvents="none"
            />
          ))}
      </svg>
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        {url !== null && engine.icon && (
          <Box
            component="img"
            data-row-icon
            src={url}
            alt={engine.icon.alt}
            sx={{
              width: '36%',
              height: '36%',
              objectFit: 'contain',
              filter: tk.mode === 'dark' ? darkIconFilter(engine.icon.src) : undefined,
            }}
          />
        )}
      </Box>
    </Box>
  );
}

function EngineTile(props: {
  engine: HoardEngine;
  source: PanelSource | undefined;
  link?: string;
  editing: boolean;
}): JSX.Element {
  const { engine, source, link, editing } = props;
  const tk = useTokens();
  const count = engine.countText;
  const body = (
    <Box
      data-engine={engine.name}
      data-engine-status={engine.status}
      title={`${engine.name}: ${ENGINE_WORD[engine.status]}${
        engine.issue ? `, ${engine.issue}` : ''
      }. ${count}.`}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '3px',
        minWidth: 0,
        p: '6px 2px',
        borderRadius: '8px',
        bgcolor: engine.status === 'ok' ? 'transparent' : tk.fill[engine.status],
        '&:hover': { bgcolor: tk.hover },
      }}
    >
      <EngineRing engine={engine} source={source} />
      <Box
        data-engine-label
        sx={{
          fontSize: 12,
          lineHeight: 1.2,
          maxWidth: '100%',
          textAlign: 'center',
          overflowWrap: 'anywhere',
        }}
      >
        {engine.name}
      </Box>
      <Box
        data-engine-count
        sx={{ fontSize: 12, lineHeight: 1.2, color: tk.fg2, fontVariantNumeric: 'tabular-nums' }}
      >
        {count}
      </Box>
    </Box>
  );
  return link && !editing ? (
    <InternalLink to={link} style={{ color: 'inherit', textDecoration: 'none', minWidth: 0 }}>
      {body}
    </InternalLink>
  ) : (
    body
  );
}

function Legend(props: { model: HoardModel }): JSX.Element {
  const { model } = props;
  const tk = useTokens();
  return (
    <Box
      data-legend
      role="list"
      aria-label="Nodes"
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '2px 14px',
        alignItems: 'center',
        fontSize: 12.5,
        color: tk.fg2,
        flex: 'none',
        px: 0.5,
      }}
    >
      {model.nodes.map(node => (
        <Box
          key={node}
          role="listitem"
          data-legend-node={node}
          sx={{ display: 'inline-flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}
        >
          <StatusMark status={model.nodeStatus[node]} size={10} />
          {node}
        </Box>
      ))}
      <Box
        data-legend-primary
        sx={{ display: 'inline-flex', alignItems: 'center', gap: '5px', ml: 'auto' }}
      >
        <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden>
          <circle r="5" fill={tk.mut} />
          <circle r="2.6" fill={tk.mode === 'dark' ? '#101418' : '#ffffff'} />
        </svg>
        Primary
      </Box>
    </Box>
  );
}

export function HoardView(props: {
  model: HoardModel;
  source: PanelSource | undefined;
  sourceId: string;
  editing: boolean;
}): JSX.Element {
  const { model, source, sourceId, editing } = props;
  const resolveLink = useResolveLink();
  return (
    <Box
      data-hoard
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        minWidth: 0,
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <ScrollArea label="Engines">
        <Box
          data-hoard-grid
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(68px, 1fr))',
            gap: '4px',
            alignContent: 'start',
            minWidth: 0,
          }}
        >
          {model.engines.map(engine => (
            <EngineTile
              key={engine.name}
              engine={engine}
              source={source}
              link={resolveLink(engine.link, { panelId: 'hoarddb', sourceId })}
              editing={editing}
            />
          ))}
        </Box>
      </ScrollArea>
      {model.nodes.length > 0 && <Legend model={model} />}
      <WidgetFooter status={model.status}>
        <span data-hoard-summary title={model.summaryTitle}>
          {model.summary}
        </span>
      </WidgetFooter>
    </Box>
  );
}
