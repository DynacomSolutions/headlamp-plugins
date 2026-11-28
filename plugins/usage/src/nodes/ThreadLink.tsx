/*
 * The link to a thread on the usage page. It opens in a new tab. Only NodesPage uses it: a link in a
 * dashboard must never leave the dashboard, so the dashboard widget does not import this file.
 */
import Button from '@mui/material/Button';
import React from 'react';

export function threadLink(url: string): React.ReactNode {
  return (
    <Button
      component="a"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      variant="outlined"
      sx={{ minHeight: 48, minWidth: 48, fontSize: 16 }}
    >
      Open thread
    </Button>
  );
}
