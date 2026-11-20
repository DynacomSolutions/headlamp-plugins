import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { WidgetDefinition, WidgetProps, WidgetSettingsProps } from '../contract';
import { SettingsForm } from './SettingsForm';

export interface HeaderConfig {
  text: string;
  subtitle: string;
  /** 'header' shows text, 'divider' shows a line, 'both' shows text over a line. */
  style: 'header' | 'divider' | 'both';
  size: 'small' | 'medium' | 'large';
  align: 'left' | 'center' | 'right';
}

const VARIANT = { small: 'subtitle1', medium: 'h6', large: 'h5' } as const;
const JUSTIFY = { left: 'flex-start', center: 'center', right: 'flex-end' } as const;

export function HeaderView({ config }: { config: HeaderConfig }): JSX.Element {
  const showText = config.style !== 'divider' && (config.text !== '' || config.subtitle !== '');
  const showLine = config.style !== 'header';
  return (
    <Box
      data-header-widget
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: JUSTIFY[config.align] ?? 'flex-start',
        textAlign: config.align,
      }}
    >
      {showText && (
        <>
          <Typography
            variant={VARIANT[config.size] ?? 'h6'}
            component="h2"
            sx={{ fontWeight: 600 }}
            noWrap
          >
            {config.text}
          </Typography>
          {config.subtitle && (
            <Typography variant="body2" color="text.secondary" noWrap>
              {config.subtitle}
            </Typography>
          )}
        </>
      )}
      {showLine && <Divider flexItem sx={{ mt: showText ? 0.5 : 0 }} />}
    </Box>
  );
}

function HeaderWidget({ config }: WidgetProps<HeaderConfig>): JSX.Element {
  return <HeaderView config={config} />;
}

function HeaderSettings({ config, onChange }: WidgetSettingsProps<HeaderConfig>): JSX.Element {
  return (
    <SettingsForm
      config={config}
      onChange={onChange}
      fields={[
        {
          key: 'style',
          label: 'Style',
          type: 'select',
          options: [
            { value: 'both', label: 'Header with a line' },
            { value: 'header', label: 'Header only' },
            { value: 'divider', label: 'Line only' },
          ],
        },
        { key: 'text', label: 'Header text', type: 'text' },
        { key: 'subtitle', label: 'Subtitle', type: 'text' },
        {
          key: 'size',
          label: 'Size',
          type: 'select',
          options: [
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
          ],
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

export const headerWidget: WidgetDefinition<HeaderConfig> = {
  type: 'core.header',
  title: 'Header or divider',
  description: 'A heading, a line, or both, to group widgets.',
  icon: 'mdi:page-layout-header',
  category: 'Text and layout',
  defaultSize: { w: 12, h: 2 },
  minSize: { w: 1, h: 1 },
  defaultConfig: { text: 'Heading', subtitle: '', style: 'both', size: 'medium', align: 'left' },
  SettingsComponent: HeaderSettings,
  Component: HeaderWidget,
  card: false,
};
