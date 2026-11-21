/*
 * The footer of a widget frame. The frame draws a footer line at the bottom of its box and gives its
 * element to the widget (through this context and the `footer` prop). A widget puts its summary
 * line there with `WidgetFooter`, so the summary sits at the same place in every widget. Without a
 * frame (a test, a header widget) the summary draws where the widget puts it.
 */
import Box from '@mui/material/Box';
import React from 'react';
import { createPortal } from 'react-dom';
import type { PanelStatus } from './panels/model';
import { StatusMark } from './panels/StatusMark';

export const FooterContext = React.createContext<HTMLElement | null>(null);

export function WidgetFooter(props: {
  status: PanelStatus;
  children: React.ReactNode;
  /** The footer element from the `footer` prop. Missing: the context value. */
  footer?: HTMLElement | null;
  dataAttr?: string;
}): JSX.Element {
  const fromContext = React.useContext(FooterContext);
  const target = props.footer ?? fromContext;
  const line = (
    <Box
      data-widget-summary={props.dataAttr ?? ''}
      sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, fontSize: 13 }}
    >
      <StatusMark status={props.status} size={13} />
      <Box
        component="span"
        sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {props.children}
      </Box>
    </Box>
  );
  return target ? createPortal(line, target) : line;
}
