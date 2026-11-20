import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import React from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { WidgetDefinition, WidgetProps, WidgetSettingsProps } from '../contract';
import { SettingsForm } from './SettingsForm';

export interface NoteConfig {
  markdown: string;
  align: 'left' | 'center' | 'right';
}

/** Only web and mail links are followed. A `javascript:` or `data:` link is shown as text. */
export function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return /^(https?:|mailto:|\/|#)/i.test(url.trim()) ? url : undefined;
}

const COMPONENTS: Components = {
  a: ({ href, children }) => {
    const safe = safeHref(href);
    return safe ? (
      <Link href={safe} target="_blank" rel="noopener noreferrer">
        {children}
      </Link>
    ) : (
      <span>{children}</span>
    );
  },
  h1: ({ children }) => (
    <Typography variant="h5" component="h2" gutterBottom>
      {children}
    </Typography>
  ),
  h2: ({ children }) => (
    <Typography variant="h6" component="h3" gutterBottom>
      {children}
    </Typography>
  ),
  h3: ({ children }) => (
    <Typography variant="subtitle1" component="h4" gutterBottom sx={{ fontWeight: 600 }}>
      {children}
    </Typography>
  ),
  p: ({ children }) => (
    <Typography variant="body2" component="p" sx={{ my: 0.5 }}>
      {children}
    </Typography>
  ),
  code: ({ children }) => (
    <Box
      component="code"
      sx={{ fontFamily: 'monospace', bgcolor: 'action.hover', px: 0.5, borderRadius: 0.5 }}
    >
      {children}
    </Box>
  ),
  img: ({ alt }) => <span>{alt}</span>,
};

const PLUGINS = [remarkGfm];

export function NoteView({ config }: { config: NoteConfig }): JSX.Element {
  return (
    <Box data-note-widget sx={{ textAlign: config.align, wordBreak: 'break-word' }}>
      {config.markdown.trim() === '' ? (
        <Typography variant="body2" color="text.secondary">
          Empty note. Open the widget settings to write in Markdown.
        </Typography>
      ) : (
        // No raw HTML (no rehype-raw), and images are not loaded, so a note cannot run script or call out.
        <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS} urlTransform={u => u}>
          {config.markdown}
        </ReactMarkdown>
      )}
    </Box>
  );
}

function NoteWidget({ config }: WidgetProps<NoteConfig>): JSX.Element {
  return <NoteView config={config} />;
}

function NoteSettings({ config, onChange }: WidgetSettingsProps<NoteConfig>): JSX.Element {
  return (
    <SettingsForm
      config={config}
      onChange={onChange}
      fields={[
        {
          key: 'markdown',
          label: 'Text (Markdown)',
          type: 'multiline',
          help: 'Headings, lists, bold, italic, code and links. HTML and images are not shown.',
        },
        {
          key: 'align',
          label: 'Alignment',
          type: 'select',
          options: [
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Centre' },
            { value: 'right', label: 'Right' },
          ],
        },
      ]}
    />
  );
}

export const noteWidget: WidgetDefinition<NoteConfig> = {
  type: 'core.note',
  title: 'Note',
  description: 'Text in Markdown: instructions, links or a legend.',
  icon: 'mdi:text-box-outline',
  category: 'Text and layout',
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 2, h: 2 },
  defaultConfig: { markdown: '## Notes\n\nWrite **Markdown** here.', align: 'left' },
  SettingsComponent: NoteSettings,
  Component: NoteWidget,
  selfScroll: true,
};
