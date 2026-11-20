/* Per-widget settings: title, self-scroll, and the widget type's own settings form. */
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import { useTheme } from '@mui/material/styles';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import React from 'react';
import type { WidgetDefinition } from '../contract';
import type { WidgetInstance } from '../spec/model';
import { SettingsForm } from '../widgets/SettingsForm';

export interface WidgetSettingsResult {
  title: string;
  config: Record<string, unknown>;
  selfScroll: boolean | undefined;
}

export function WidgetSettingsDialog(props: {
  widget: WidgetInstance;
  def: WidgetDefinition | undefined;
  onCancel: () => void;
  onApply: (result: WidgetSettingsResult) => void;
}): JSX.Element {
  const { widget, def, onCancel, onApply } = props;
  const [title, setTitle] = React.useState(widget.title);
  const [config, setConfig] = React.useState<Record<string, unknown>>({ ...(def?.defaultConfig ?? {}), ...widget.config });
  const [selfScroll, setSelfScroll] = React.useState<boolean>(widget.selfScroll ?? def?.selfScroll ?? false);
  const narrow = useMediaQuery(useTheme().breakpoints.down('md'));
  const Custom = def?.SettingsComponent;
  // Only store a self-scroll override when it differs from the widget type's default.
  const scrollOverride = selfScroll === (def?.selfScroll ?? false) ? undefined : selfScroll;
  return (
    // Wide for the report editor and the query editors, and full screen on a small window.
    <Dialog open onClose={onCancel} fullWidth maxWidth="md" fullScreen={narrow} aria-labelledby="widget-settings-title">
      <DialogTitle id="widget-settings-title">{def ? `${def.title} settings` : 'Widget settings'}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
          <TextField
            size="small"
            label="Title"
            placeholder={def?.title}
            helperText="Leave blank for the widget's own title."
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
          <FormControlLabel
            control={<Switch checked={selfScroll} onChange={e => setSelfScroll(e.target.checked)} />}
            label="Self-scroll content (a scrollbar inside the widget when the content is taller)"
          />
          {!def && (
            <Typography variant="body2" color="text.secondary">
              The plugin that supplies this widget is not installed, so its settings cannot be edited. They are kept.
            </Typography>
          )}
          {def && Custom && <Custom config={config as any} onChange={c => setConfig(c as Record<string, unknown>)} />}
          {def && !Custom && def.configSchema && def.configSchema.length > 0 && (
            <SettingsForm fields={def.configSchema} config={config} onChange={setConfig} />
          )}
          {def && !Custom && !def.configSchema?.length && (
            <Typography variant="body2" color="text.secondary">
              This widget has no other settings.
            </Typography>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="contained" onClick={() => onApply({ title: title.trim(), config, selfScroll: scrollOverride })}>
          Apply
        </Button>
      </DialogActions>
    </Dialog>
  );
}
