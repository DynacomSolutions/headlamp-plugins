/* A settings form generated from a list of fields (see `ConfigField` in contract.ts). */
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import React from 'react';
import type { ConfigField } from '../contract';

export function SettingsForm<C extends Record<string, any>>(props: {
  fields: ConfigField[];
  config: C;
  onChange: (config: C) => void;
}): JSX.Element {
  const { fields, config, onChange } = props;
  const set = (key: string, value: unknown) => onChange({ ...config, [key]: value });
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
      {fields.map(f => {
        const value = config[f.key];
        switch (f.type) {
          case 'boolean':
            return (
              <FormControlLabel
                key={f.key}
                control={
                  <Switch checked={value === true} onChange={e => set(f.key, e.target.checked)} />
                }
                label={f.label}
              />
            );
          case 'select':
            return (
              <TextField
                key={f.key}
                select
                size="small"
                label={f.label}
                helperText={f.help}
                value={value ?? ''}
                onChange={e => set(f.key, e.target.value)}
              >
                {f.options.map(o => (
                  <MenuItem key={o.value} value={o.value}>
                    {o.label}
                  </MenuItem>
                ))}
              </TextField>
            );
          case 'number':
            return (
              <TextField
                key={f.key}
                type="number"
                size="small"
                label={f.label}
                helperText={f.help}
                value={typeof value === 'number' ? value : ''}
                inputProps={{ min: f.min, max: f.max, step: f.step }}
                onChange={e => {
                  const n = e.target.value === '' ? NaN : Number(e.target.value);
                  if (Number.isFinite(n)) set(f.key, n);
                }}
              />
            );
          default:
            return (
              <TextField
                key={f.key}
                size="small"
                label={f.label}
                helperText={f.help}
                placeholder={f.placeholder}
                multiline={f.type === 'multiline'}
                minRows={f.type === 'multiline' ? 4 : undefined}
                value={typeof value === 'string' ? value : ''}
                onChange={e => set(f.key, e.target.value)}
              />
            );
        }
      })}
    </Box>
  );
}
