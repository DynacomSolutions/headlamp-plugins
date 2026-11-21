/*
 * The one scroll area of a widget. A widget keeps its title, stat tiles, legend, summary line and
 * footer fixed, and only the list of rows scrolls inside this box. The box fills the height that is
 * left (`flex: 1 1 0`), so no row is ever folded into a "+N more" line or cut off.
 *
 * It shows that there is more: a thin scrollbar that is always visible (also in the kiosk) and a
 * soft fade at each edge that has more rows behind it. It scrolls by touch (`pan-y`), and the wheel
 * scrolls the list, never the page (`overscroll-behavior: contain`).
 */
import Box from '@mui/material/Box';
import type { SxProps, Theme } from '@mui/material/styles';
import React from 'react';

/** The height of the soft fade at a scroll edge, in px. */
export const FADE = 20;

/** Which edges have more rows behind them. */
export interface Edges {
  top: boolean;
  bottom: boolean;
}

/** Reads the edges of a scroll element. A fraction of a pixel of slack stops a flicker at the end. */
export function edgesOf(
  el: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>
): Edges {
  return {
    top: el.scrollTop > 1,
    bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
  };
}

/** The mask that fades the edges with more rows behind them. */
export function fadeMask(e: Edges): string {
  const top = e.top ? `transparent 0, #000 ${FADE}px` : '#000 0';
  const bottom = e.bottom ? `#000 calc(100% - ${FADE}px), transparent 100%` : '#000 100%';
  return `linear-gradient(to bottom, ${top}, ${bottom})`;
}

export function ScrollArea(props: {
  children: React.ReactNode;
  /** A name for tests and for the accessible region. */
  label?: string;
  sx?: SxProps<Theme>;
}): JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState<Edges>({ top: false, bottom: false });
  const update = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = edgesOf(el);
    setEdges(prev => (prev.top === next.top && prev.bottom === next.bottom ? prev : next));
  }, []);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    // The box and its content both change size: a new list, a new widget size, a font load.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [update]);
  const mask = edges.top || edges.bottom ? fadeMask(edges) : undefined;
  return (
    <Box
      ref={ref}
      data-scroll-area=""
      data-scroll-top={edges.top ? 'more' : 'end'}
      data-scroll-bottom={edges.bottom ? 'more' : 'end'}
      onScroll={update}
      tabIndex={0}
      role="region"
      aria-label={props.label ?? 'Rows'}
      sx={[
        theme => ({
          flex: '1 1 0',
          minHeight: 0,
          minWidth: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          overscrollBehavior: 'contain',
          touchAction: 'pan-y',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'thin',
          scrollbarColor: `${
            theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)'
          } transparent`,
          '&::-webkit-scrollbar': { width: 6 },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': {
            borderRadius: 3,
            background: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)',
          },
          '&:focus-visible': { outline: '2px solid', outlineColor: theme.palette.primary.main },
          ...(mask ? { maskImage: mask, WebkitMaskImage: mask } : {}),
        }),
        ...(Array.isArray(props.sx) ? props.sx : props.sx ? [props.sx] : []),
      ]}
    >
      {props.children}
    </Box>
  );
}
