/* The query editor for the settings dialog: a multiline field and a Run button with a preview. */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { defaultFilters } from '../../spec/model';
import { parseBlocks } from './blocks';
import { useMetricsEndpoint } from './endpoint';
import { parseVector } from './mapping';
import { runInstant } from './prom';

interface Preview {
  title: string;
  count: number;
  rows: Array<{ name: string; value: string }>;
}

export function QueryEditor(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: string;
  /** Preview each query block of a table widget. */
  multi?: boolean;
}): JSX.Element {
  const { label, value, onChange, help, multi } = props;
  const endpoint = useMetricsEndpoint();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [previews, setPreviews] = React.useState<Preview[]>();
  const ctrl = React.useRef<AbortController>();

  // Stop a request that is still running when the dialog closes.
  React.useEffect(() => () => ctrl.current?.abort(), []);

  const run = () => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    const blocks = multi ? parseBlocks(value) : [{ title: '', unit: undefined, query: value.trim() }];
    if (blocks.length === 0 || blocks.every(b => b.query === '')) {
      setError('Type a query first.');
      setPreviews(undefined);
      return;
    }
    setBusy(true);
    setError(undefined);
    const now = Date.now();
    Promise.all(
      blocks.map(async (b): Promise<Preview> => {
        const res = await runInstant(b.query, defaultFilters(), now, { endpoint, signal: c.signal });
        const samples = res.resultType === 'matrix' ? [] : parseVector(res.result, undefined, res.resultType);
        return {
          title: b.title,
          count: Array.isArray(res.result) ? res.result.length : samples.length,
          rows: samples.slice(0, 8).map(s => ({ name: s.name, value: s.value === null ? 'no value' : String(s.value) })),
        };
      })
    ).then(
      list => {
        if (c.signal.aborted) return;
        setPreviews(list);
        setBusy(false);
      },
      (e: unknown) => {
        if (c.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setPreviews(undefined);
        setBusy(false);
      }
    );
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <TextField
        size="small"
        label={label}
        multiline
        minRows={4}
        maxRows={14}
        value={value}
        onChange={e => onChange(e.target.value)}
        helperText={help}
        spellCheck={false}
        inputProps={{ style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 13 } }}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Button size="small" variant="outlined" onClick={run} disabled={busy}>
          {busy ? 'Running...' : 'Run'}
        </Button>
        <Typography variant="caption" color="text.secondary">
          The preview is an instant query with no filters: every namespace and node.
        </Typography>
      </Box>
      {error && (
        <Alert severity="error" sx={{ overflowWrap: 'anywhere' }}>
          {error}
        </Alert>
      )}
      {previews?.map((p, i) => (
        <Box key={i} data-query-preview sx={{ fontSize: 12 }}>
          <Typography variant="caption" sx={{ fontWeight: 600 }}>
            {p.title ? `${p.title}: ` : ''}
            {p.count} {p.count === 1 ? 'series' : 'series'}
          </Typography>
          {p.rows.map((r, j) => (
            <Box key={j} sx={{ fontFamily: 'ui-monospace, monospace', overflowWrap: 'anywhere', color: 'text.secondary' }}>
              {r.name} = {r.value}
            </Box>
          ))}
          {p.count > p.rows.length && <Box color="text.secondary">and {p.count - p.rows.length} more</Box>}
        </Box>
      ))}
    </Box>
  );
}
