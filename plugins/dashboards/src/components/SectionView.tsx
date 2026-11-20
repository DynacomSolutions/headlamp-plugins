/*
 * One section: its own grid of widgets. Modes: normal flow, sticky at the top or bottom of the
 * scrolling page, or self-scroll (a fixed height with its own scrollbar). In edit mode widgets
 * drag by their handle and resize from the bottom right corner, and a drop on another section
 * moves the widget there. The section is memoised, so editing one section leaves the rest alone.
 */
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Layout, Responsive, WidthProvider } from 'react-grid-layout';
import type { WidgetDefinition } from '../contract';
import {
  Breakpoint,
  BREAKPOINTS,
  COLS,
  GRID_MARGIN,
  isEditableBreakpoint,
  layoutPositions,
  otherSectionAt,
  pointerOf,
  ROW_HEIGHT,
  toLayout,
} from '../layout';
import { getRegistry } from '../registry';
import { MAX_SECTION_HEIGHT, MIN_SECTION_HEIGHT, Section, SectionMode } from '../spec/model';
import { FrameActions, WidgetFrame } from './WidgetFrame';

const ResponsiveGrid = WidthProvider(Responsive);

export const MODE_LABELS: Record<SectionMode, string> = {
  flow: 'Normal',
  'sticky-top': 'Sticky at the top',
  'sticky-bottom': 'Sticky at the bottom',
  'self-scroll': 'Self-scroll (fixed height)',
};

export interface SectionActions {
  rename(sectionId: string, title: string): void;
  setMode(sectionId: string, mode: SectionMode): void;
  setHeight(sectionId: string, height: number): void;
  setShowTitle(sectionId: string, show: boolean): void;
  move(sectionId: string, direction: -1 | 1): void;
  remove(sectionId: string): void;
  positions(
    sectionId: string,
    positions: ReadonlyArray<{ i: string; x: number; y: number; w: number; h: number }>
  ): void;
  moveWidget(fromSectionId: string, toSectionId: string, widgetId: string): void;
}

export interface SectionViewProps {
  section: Section;
  index: number;
  count: number;
  editing: boolean;
  kiosk: boolean;
  frameActions: FrameActions;
  actions: SectionActions;
  /**
   * The tab fits the screen height: the grid uses `rowHeight`, and a self-scroll section gives up
   * its fixed pixel height, so the grid sets the height. Off keeps `ROW_HEIGHT` and the fixed height.
   */
  fit?: boolean;
  /** Grid row height in px when `fit` is on. */
  rowHeight?: number;
  /** The header and the footer own their edit controls, so the section draws none of its own. */
  bare?: boolean;
}

const limitsOf = (type: string): Pick<WidgetDefinition, 'minSize' | 'maxSize'> | undefined =>
  getRegistry().get(type);

function SectionHeader(
  props: Pick<SectionViewProps, 'section' | 'index' | 'count' | 'actions'>
): JSX.Element {
  const { section, index, count, actions } = props;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 1 }}>
      <TextField
        size="small"
        label="Section title"
        value={section.title}
        onChange={e => actions.rename(section.id, e.target.value)}
        sx={{ minWidth: 160 }}
      />
      <TextField
        select
        size="small"
        label="Behaviour"
        value={section.mode}
        onChange={e => actions.setMode(section.id, e.target.value as SectionMode)}
        sx={{ minWidth: 210 }}
      >
        {(Object.keys(MODE_LABELS) as SectionMode[]).map(m => (
          <MenuItem key={m} value={m}>
            {MODE_LABELS[m]}
          </MenuItem>
        ))}
      </TextField>
      {section.mode === 'self-scroll' && (
        <TextField
          size="small"
          type="number"
          label="Height (px)"
          value={section.height}
          inputProps={{ min: MIN_SECTION_HEIGHT, max: MAX_SECTION_HEIGHT, step: 20 }}
          onChange={e => actions.setHeight(section.id, Number(e.target.value))}
          sx={{ width: 120 }}
        />
      )}
      <Chip
        size="small"
        variant={section.showTitle ? 'filled' : 'outlined'}
        label={section.showTitle ? 'Title shown' : 'Title hidden'}
        onClick={() => actions.setShowTitle(section.id, !section.showTitle)}
      />
      <Box sx={{ flex: 1 }} />
      <Tooltip title="Move section up">
        <span>
          <IconButton
            size="small"
            aria-label="Move section up"
            disabled={index === 0}
            onClick={() => actions.move(section.id, -1)}
          >
            <Icon icon="mdi:arrow-up" width={18} height={18} />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Move section down">
        <span>
          <IconButton
            size="small"
            aria-label="Move section down"
            disabled={index === count - 1}
            onClick={() => actions.move(section.id, 1)}
          >
            <Icon icon="mdi:arrow-down" width={18} height={18} />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={count <= 1 ? 'A tab keeps at least one section' : 'Delete section'}>
        <span>
          <IconButton
            size="small"
            aria-label="Delete section"
            disabled={count <= 1}
            onClick={() => actions.remove(section.id)}
          >
            <Icon icon="mdi:delete-outline" width={18} height={18} />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );
}

function SectionViewImpl(props: SectionViewProps): JSX.Element {
  const { section, index, count, editing, kiosk, frameActions, actions, bare, fit, rowHeight } =
    props;
  const [breakpoint, setBreakpoint] = React.useState<Breakpoint>('lg');
  const canEditLayout = editing && isEditableBreakpoint(breakpoint);

  // The layout is derived from the widgets. Positions come from the saved spec.
  const layout = React.useMemo(() => toLayout(section.widgets, limitsOf), [section.widgets]);
  const layouts = React.useMemo(
    () => ({ lg: layout, md: layout, sm: layout, xs: layout, xxs: layout }),
    [layout]
  );

  const sectionId = section.id;
  const onDragStop = React.useCallback(
    (l: Layout[], _old: Layout, item: Layout, _p: Layout, e: unknown) => {
      const point = pointerOf(e);
      const target = point ? otherSectionAt(point, sectionId) : null;
      if (target) actions.moveWidget(sectionId, target, item.i);
      else actions.positions(sectionId, layoutPositions(l));
    },
    [actions, sectionId]
  );
  const onResizeStop = React.useCallback(
    (l: Layout[]) => actions.positions(sectionId, layoutPositions(l)),
    [actions, sectionId]
  );

  const sticky = !editing && (section.mode === 'sticky-top' || section.mode === 'sticky-bottom');
  const fixedHeight = section.mode === 'self-scroll' && !fit;
  const hideScrollbars = kiosk
    ? { scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }
    : {};

  return (
    <Box
      component="section"
      data-section-id={section.id}
      data-section-mode={section.mode}
      aria-label={section.title}
      sx={{
        position: sticky ? 'sticky' : 'relative',
        top: sticky && section.mode === 'sticky-top' ? 0 : undefined,
        bottom: sticky && section.mode === 'sticky-bottom' ? 0 : undefined,
        zIndex: sticky ? 3 : undefined,
        bgcolor: sticky ? 'background.default' : undefined,
        mb: 1,
        minHeight: editing ? 96 : undefined,
        ...(editing ? { border: '1px dashed', borderColor: 'divider', borderRadius: 1, p: 1 } : {}),
      }}
    >
      {editing && !bare && (
        <SectionHeader section={section} index={index} count={count} actions={actions} />
      )}
      {!editing && section.showTitle && section.title && (
        <Typography variant="subtitle1" component="h2" sx={{ mb: 0.5 }}>
          {section.title}
        </Typography>
      )}
      <Box
        data-section-scroll={section.mode === 'self-scroll' ? '' : undefined}
        sx={{
          height: fixedHeight ? section.height : undefined,
          overflowY: fixedHeight ? 'auto' : undefined,
          overflowX: fixedHeight ? 'hidden' : undefined,
          ...hideScrollbars,
          // The grid animates its height on a change of the row height. The fit measures the height
          // right after the change, so in a fitted tab it must jump, not slide.
          ...(fit ? { '& .react-grid-layout, & .react-grid-item': { transition: 'none' } } : {}),
          '& .react-resizable-handle::after': { borderColor: 'text.secondary' },
          '& .react-grid-placeholder': { bgcolor: 'primary.main', borderRadius: 1 },
        }}
      >
        {section.widgets.length === 0 && editing && (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            Empty section. Use Add widget, or drag a widget here from another section.
          </Typography>
        )}
        <ResponsiveGrid
          layouts={layouts}
          breakpoints={BREAKPOINTS}
          cols={COLS}
          rowHeight={fit ? rowHeight ?? ROW_HEIGHT : ROW_HEIGHT}
          margin={GRID_MARGIN}
          containerPadding={[0, 0]}
          isDraggable={canEditLayout}
          isResizable={canEditLayout}
          draggableHandle=".widget-drag-handle"
          onBreakpointChange={(bp: string) => setBreakpoint(bp as Breakpoint)}
          onDragStop={onDragStop}
          onResizeStop={onResizeStop}
          useCSSTransforms
        >
          {section.widgets.map(w => (
            <div key={w.id}>
              <WidgetFrame
                sectionId={section.id}
                id={w.id}
                type={w.type}
                title={w.title}
                config={w.config}
                selfScroll={w.selfScroll}
                actions={frameActions}
              />
            </div>
          ))}
        </ResponsiveGrid>
        {editing && !isEditableBreakpoint(breakpoint) && (
          <Typography variant="caption" color="text.secondary">
            This window is narrow. Widen it to move or resize widgets.
          </Typography>
        )}
      </Box>
      {editing && !bare && section.mode !== 'flow' && (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
          {section.mode === 'self-scroll'
            ? 'In view mode this section keeps its height and scrolls inside.'
            : 'In view mode this section stays in view while the page scrolls. Sticky is off while you edit.'}
        </Typography>
      )}
    </Box>
  );
}

export const SectionView = React.memo(SectionViewImpl);
