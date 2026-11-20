/*
 * The settings editor of the Kubernetes report: five steps (Source, Columns, Filters, Grouping,
 * Chart) and a live preview that uses the real data. Every step edits the same draft object.
 */
import { Icon } from '@iconify/react';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Step from '@mui/material/Step';
import StepButton from '@mui/material/StepButton';
import Stepper from '@mui/material/Stepper';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { WidgetSettingsProps } from '../../contract';
import { defaultFilters } from '../../spec/model';
import {
  AGG_FNS,
  AggFn,
  AggregateSpec,
  ChartType,
  ColumnSpec,
  normaliseConfig,
  ReportConfig,
  ReportType,
  SourceRef,
} from './config';
import { KindEntry } from './discovery';
import {
  COMMON_FIELD_LABELS,
  COMMON_FIELDS,
  defaultHeader,
  isCommonField,
  isValidFieldPath,
} from './fields';
import { suggestPaths } from './fieldSuggest';
import { FILTER_OP_LABELS, FILTER_OPS, FilterOp, parseFilterLogic, ReportFilter } from './filters';
import { ReportBody } from './ReportBody';
import { useKinds } from './useKinds';
import { useResources } from './useResources';

const STEPS = ['Source', 'Columns', 'Filters', 'Grouping', 'Chart'] as const;
const NO_SCOPE = { namespaces: [] as string[], nodes: [] as string[] };
const NO_FILTERS = defaultFilters();

/* ------------------------------- shared controls ------------------------------- */

/** A field choice: a common field, a path suggested from the loaded data, or any path typed in. */
function FieldPicker(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  /** Offer only numeric-friendly choices first. Not enforced. */
  help?: string;
  allowEmpty?: boolean;
}): JSX.Element {
  const { label, value, onChange, suggestions } = props;
  const options = React.useMemo(() => [...COMMON_FIELDS, ...suggestions], [suggestions]);
  const invalid = value.trim() !== '' && !isCommonField(value) && !isValidFieldPath(value);
  return (
    <Autocomplete
      freeSolo
      size="small"
      options={options}
      inputValue={value}
      onInputChange={(_, v) => onChange(v)}
      groupBy={o => (isCommonField(o) ? 'Common fields' : 'Fields in your data')}
      getOptionLabel={o => (typeof o === 'string' ? o : '')}
      renderOption={(optionProps, o) => (
        <li {...optionProps} key={o}>
          {isCommonField(o) ? `${COMMON_FIELD_LABELS[o]} (${o})` : o}
        </li>
      )}
      sx={{ minWidth: 200, flex: 1 }}
      renderInput={params => (
        <TextField
          {...params}
          label={label}
          error={invalid}
          helperText={invalid ? 'Not a valid path. Example: .spec.replicas' : props.help}
          inputProps={{ ...params.inputProps, 'aria-label': label }}
        />
      )}
    />
  );
}

function Row(props: { children: React.ReactNode }): JSX.Element {
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mb: 1.5 }}>{props.children}</Box>
  );
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

type Patch = (p: Partial<ReportConfig>) => void;

/* ------------------------------------ steps ------------------------------------ */

function SourceStep(props: { cfg: ReportConfig; patch: Patch }): JSX.Element {
  const { cfg, patch } = props;
  const { kinds, loading, error } = useKinds();
  const current =
    kinds.find(k => k.group === cfg.source.group && k.plural === cfg.source.plural) ?? null;
  const choose = (k: KindEntry | null) => {
    if (!k) return;
    const source: SourceRef = {
      group: k.group,
      version: k.version,
      plural: k.plural,
      kind: k.kind,
      namespaced: k.namespaced,
    };
    // New kind, new defaults: the old fields may not exist on it.
    patch({
      source,
      columns: [
        { field: 'name', header: '' },
        ...(k.namespaced ? [{ field: 'namespace', header: '' }] : []),
        { field: 'status', header: '' },
        { field: 'age', header: '' },
      ],
      filters: [],
      logic: '',
      groupBy: k.namespaced ? ['namespace'] : ['status'],
      aggregates: [],
      sortField: '',
      chart: 'none',
      chartMeasure: -1,
      matrixRow: k.namespaced ? 'namespace' : 'status',
      matrixCol: 'status',
    });
  };
  return (
    <Box>
      <Autocomplete
        size="small"
        loading={loading}
        options={kinds}
        value={current}
        groupBy={k => (k.custom ? 'Custom resources' : 'Built-in kinds')}
        getOptionLabel={k => k.label}
        isOptionEqualToValue={(a, b) => a.group === b.group && a.plural === b.plural}
        onChange={(_, k) => choose(k)}
        renderInput={params => (
          <TextField
            {...params}
            label="Resource kind"
            helperText={
              current
                ? `${
                    current.namespaced ? 'Namespaced' : 'Cluster scoped'
                  }. Custom resources are listed after the built-in kinds.`
                : `Now: ${cfg.source.kind} (${cfg.source.group ? `${cfg.source.group}/` : ''}${
                    cfg.source.version
                  })`
            }
          />
        )}
      />
      {error && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          Could not load the kinds from the API server: {error}
        </Alert>
      )}
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
        The dashboard filters (namespaces, label selector, and nodes for Pods) narrow the report
        too. Add more filters in the Filters step.
      </Typography>
    </Box>
  );
}

function ColumnsStep(props: {
  cfg: ReportConfig;
  patch: Patch;
  suggestions: string[];
}): JSX.Element {
  const { cfg, patch, suggestions } = props;
  const [draft, setDraft] = React.useState('');
  const setColumn = (i: number, c: Partial<ColumnSpec>) =>
    patch({ columns: cfg.columns.map((x, j) => (j === i ? { ...x, ...c } : x)) });
  const add = () => {
    const field = draft.trim();
    if (field === '' || (!isCommonField(field) && !isValidFieldPath(field))) return;
    patch({ columns: [...cfg.columns, { field, header: '' }] });
    setDraft('');
  };
  return (
    <Box>
      {cfg.columns.map((c, i) => (
        <Row key={`${c.field}:${i}`}>
          <FieldPicker
            label={`Column ${i + 1}`}
            value={c.field}
            suggestions={suggestions}
            onChange={v => setColumn(i, { field: v })}
          />
          <TextField
            size="small"
            label="Header"
            placeholder={defaultHeader(c.field)}
            value={c.header}
            onChange={e => setColumn(i, { header: e.target.value })}
            sx={{ width: 150 }}
          />
          <IconButton
            size="small"
            aria-label={`Move column ${i + 1} up`}
            disabled={i === 0}
            onClick={() => patch({ columns: move(cfg.columns, i, i - 1) })}
          >
            <Icon icon="mdi:arrow-up" width={18} />
          </IconButton>
          <IconButton
            size="small"
            aria-label={`Move column ${i + 1} down`}
            disabled={i === cfg.columns.length - 1}
            onClick={() => patch({ columns: move(cfg.columns, i, i + 1) })}
          >
            <Icon icon="mdi:arrow-down" width={18} />
          </IconButton>
          <IconButton
            size="small"
            aria-label={`Remove column ${i + 1}`}
            onClick={() => patch({ columns: cfg.columns.filter((_, j) => j !== i) })}
          >
            <Icon icon="mdi:close" width={18} />
          </IconButton>
        </Row>
      ))}
      <Row>
        <FieldPicker
          label="Add a column"
          value={draft}
          suggestions={suggestions}
          onChange={setDraft}
          help="A common field, or a path such as .spec.replicas"
        />
        <Button variant="outlined" size="small" onClick={add} sx={{ mt: 0.5 }}>
          Add
        </Button>
      </Row>
      <Row>
        <FieldPicker
          label="Sort by"
          value={cfg.sortField}
          suggestions={suggestions}
          onChange={v => patch({ sortField: v })}
          help="Must be one of the columns. Click a header to sort too."
        />
        <TextField
          select
          size="small"
          label="Direction"
          value={cfg.sortDir}
          onChange={e => patch({ sortDir: e.target.value as 'asc' | 'desc' })}
          sx={{ width: 130 }}
        >
          <MenuItem value="asc">Ascending</MenuItem>
          <MenuItem value="desc">Descending</MenuItem>
        </TextField>
      </Row>
    </Box>
  );
}

function FiltersStep(props: {
  cfg: ReportConfig;
  patch: Patch;
  suggestions: string[];
}): JSX.Element {
  const { cfg, patch, suggestions } = props;
  const setFilter = (i: number, f: Partial<ReportFilter>) =>
    patch({ filters: cfg.filters.map((x, j) => (j === i ? { ...x, ...f } : x)) });
  const logicProblem = React.useMemo(() => {
    if (cfg.logic.trim() === '' || cfg.filters.length === 0) return null;
    const r = parseFilterLogic(cfg.logic, cfg.filters.length);
    return r.ok ? null : r.error ?? 'The logic is not valid.';
  }, [cfg.logic, cfg.filters.length]);
  return (
    <Box>
      {cfg.filters.map((f, i) => (
        <Row key={i}>
          <Typography sx={{ width: 22, pt: 1, color: 'text.secondary' }}>{i + 1}</Typography>
          <FieldPicker
            label="Field"
            value={f.field}
            suggestions={suggestions}
            onChange={v => setFilter(i, { field: v })}
          />
          <TextField
            select
            size="small"
            label="Operator"
            value={f.op}
            onChange={e => setFilter(i, { op: e.target.value as FilterOp })}
            sx={{ width: 150 }}
          >
            {FILTER_OPS.map(op => (
              <MenuItem key={op} value={op}>
                {FILTER_OP_LABELS[op]}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label="Value"
            value={f.value}
            onChange={e => setFilter(i, { value: e.target.value })}
            helperText={
              f.op === 'exists' ? 'Type false to match when it does not exist.' : undefined
            }
            sx={{ width: 150 }}
          />
          <IconButton
            size="small"
            aria-label={`Remove filter ${i + 1}`}
            onClick={() => patch({ filters: cfg.filters.filter((_, j) => j !== i) })}
          >
            <Icon icon="mdi:close" width={18} />
          </IconButton>
        </Row>
      ))}
      <Button
        variant="outlined"
        size="small"
        onClick={() => patch({ filters: [...cfg.filters, { field: '', op: 'eq', value: '' }] })}
      >
        Add filter
      </Button>
      {cfg.filters.length > 1 && (
        <TextField
          fullWidth
          size="small"
          sx={{ mt: 2 }}
          label="Filter logic (optional)"
          placeholder={`1 AND (2 OR 3)`}
          value={cfg.logic}
          error={logicProblem !== null}
          helperText={
            logicProblem ??
            'Leave empty to apply every filter with AND. Use AND, OR, NOT and brackets.'
          }
          onChange={e => patch({ logic: e.target.value })}
        />
      )}
    </Box>
  );
}

function GroupingStep(props: {
  cfg: ReportConfig;
  patch: Patch;
  suggestions: string[];
}): JSX.Element {
  const { cfg, patch, suggestions } = props;
  const setAgg = (i: number, a: Partial<AggregateSpec>) =>
    patch({ aggregates: cfg.aggregates.map((x, j) => (j === i ? { ...x, ...a } : x)) });
  const group0 = cfg.groupBy[0] ?? '';
  const group1 = cfg.groupBy[1] ?? '';
  const setGroups = (a: string, b: string) =>
    patch({ groupBy: [a, b].filter((x, i) => (i === 0 ? true : x.trim() !== '')) });
  return (
    <Box>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={cfg.reportType}
        onChange={(_, v: ReportType | null) => v && patch({ reportType: v })}
        aria-label="Report type"
        sx={{ mb: 2 }}
      >
        <ToggleButton value="tabular">Tabular</ToggleButton>
        <ToggleButton value="summary">Summary</ToggleButton>
        <ToggleButton value="matrix">Matrix</ToggleButton>
      </ToggleButtonGroup>
      {cfg.reportType === 'tabular' && (
        <Typography variant="body2" color="text.secondary">
          A plain table of the columns. Choose Summary to group rows with counts and totals, or
          Matrix to cross two fields.
        </Typography>
      )}
      {cfg.reportType === 'summary' && (
        <>
          <Row>
            <FieldPicker
              label="Group by"
              value={group0}
              suggestions={suggestions}
              onChange={v => setGroups(v, group1)}
            />
            <FieldPicker
              label="Then group by (optional)"
              value={group1}
              suggestions={suggestions}
              onChange={v => setGroups(group0, v)}
            />
          </Row>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Totals for numeric fields
          </Typography>
          {cfg.aggregates.map((a, i) => (
            <Row key={i}>
              <TextField
                select
                size="small"
                label="Function"
                value={a.fn}
                onChange={e => setAgg(i, { fn: e.target.value as AggFn })}
                sx={{ width: 110 }}
              >
                {AGG_FNS.map(fn => (
                  <MenuItem key={fn} value={fn}>
                    {fn}
                  </MenuItem>
                ))}
              </TextField>
              <FieldPicker
                label="Field"
                value={a.field}
                suggestions={suggestions}
                onChange={v => setAgg(i, { field: v })}
              />
              <IconButton
                size="small"
                aria-label={`Remove total ${i + 1}`}
                onClick={() => patch({ aggregates: cfg.aggregates.filter((_, j) => j !== i) })}
              >
                <Icon icon="mdi:close" width={18} />
              </IconButton>
            </Row>
          ))}
          <Button
            size="small"
            variant="outlined"
            onClick={() =>
              patch({ aggregates: [...cfg.aggregates, { field: 'restarts', fn: 'sum' }] })
            }
            sx={{ mb: 1.5 }}
          >
            Add a total
          </Button>
          <Box>
            <TextField
              select
              size="small"
              label="Order groups by"
              value={cfg.groupSort}
              onChange={e => patch({ groupSort: e.target.value as 'key' | 'count' })}
              sx={{ width: 200, mr: 2 }}
            >
              <MenuItem value="key">Value</MenuItem>
              <MenuItem value="count">Row count</MenuItem>
            </TextField>
            <FormControlLabel
              control={
                <Switch
                  checked={cfg.expandGroups}
                  onChange={e => patch({ expandGroups: e.target.checked })}
                />
              }
              label="Groups start open"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={cfg.showRows}
                  onChange={e => patch({ showRows: e.target.checked })}
                />
              }
              label="Show the rows in each group"
            />
          </Box>
        </>
      )}
      {cfg.reportType === 'matrix' && (
        <>
          <Row>
            <FieldPicker
              label="Rows"
              value={cfg.matrixRow}
              suggestions={suggestions}
              onChange={v => patch({ matrixRow: v })}
            />
            <FieldPicker
              label="Columns"
              value={cfg.matrixCol}
              suggestions={suggestions}
              onChange={v => patch({ matrixCol: v })}
            />
          </Row>
          <Row>
            <TextField
              select
              size="small"
              label="Cell value"
              value={cfg.matrixFn}
              onChange={e => patch({ matrixFn: e.target.value as ReportConfig['matrixFn'] })}
              sx={{ width: 150 }}
            >
              <MenuItem value="count">Row count</MenuItem>
              {AGG_FNS.map(fn => (
                <MenuItem key={fn} value={fn}>
                  {fn} of a field
                </MenuItem>
              ))}
            </TextField>
            {cfg.matrixFn !== 'count' && (
              <FieldPicker
                label="Numeric field"
                value={cfg.matrixField}
                suggestions={suggestions}
                onChange={v => patch({ matrixField: v })}
              />
            )}
          </Row>
        </>
      )}
    </Box>
  );
}

function ChartStep(props: { cfg: ReportConfig; patch: Patch }): JSX.Element {
  const { cfg, patch } = props;
  if (cfg.reportType !== 'summary') {
    return (
      <Typography variant="body2" color="text.secondary">
        Charts are for Summary reports. Choose Summary in the Grouping step.
      </Typography>
    );
  }
  const stackedNeedsTwo = cfg.chart === 'stacked' && cfg.groupBy.length < 2;
  return (
    <Box>
      <Row>
        <TextField
          select
          size="small"
          label="Chart"
          value={cfg.chart}
          onChange={e => patch({ chart: e.target.value as ChartType })}
          sx={{ width: 220 }}
        >
          <MenuItem value="none">No chart</MenuItem>
          <MenuItem value="bar">Bar</MenuItem>
          <MenuItem value="hbar">Horizontal bar</MenuItem>
          <MenuItem value="donut">Donut</MenuItem>
          <MenuItem value="stacked">Stacked bar</MenuItem>
        </TextField>
        {cfg.chart !== 'none' && (
          <TextField
            select
            size="small"
            label="Value"
            value={cfg.chartMeasure}
            onChange={e => patch({ chartMeasure: Number(e.target.value) })}
            sx={{ width: 220 }}
          >
            <MenuItem value={-1}>Row count</MenuItem>
            {cfg.aggregates.map((a, i) => (
              <MenuItem key={i} value={i}>{`${a.fn} of ${defaultHeader(a.field)}`}</MenuItem>
            ))}
          </TextField>
        )}
      </Row>
      {stackedNeedsTwo && (
        <Alert severity="info">
          A stacked bar needs two group fields. With one, it shows plain bars.
        </Alert>
      )}
      <Typography variant="caption" color="text.secondary" component="p">
        Every group is its own bar or slice, at its real size. Nothing is merged into an Other
        group.
      </Typography>
    </Box>
  );
}

/* ----------------------------------- editor ----------------------------------- */

export function ReportSettings({
  config,
  onChange,
}: WidgetSettingsProps<ReportConfig>): JSX.Element {
  const cfg = React.useMemo(() => normaliseConfig(config), [config]);
  const [step, setStep] = React.useState(0);
  const patch: Patch = React.useCallback(p => onChange({ ...cfg, ...p }), [cfg, onChange]);
  const live = useResources(cfg.source, NO_FILTERS, 0, noop);
  const suggestions = React.useMemo(() => suggestPaths(live.items), [live.items]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
      <Stepper nonLinear activeStep={step} alternativeLabel={false}>
        {STEPS.map((label, i) => (
          <Step key={label}>
            <StepButton onClick={() => setStep(i)}>{label}</StepButton>
          </Step>
        ))}
      </Stepper>
      <Box sx={{ minHeight: 190 }}>
        {step === 0 && <SourceStep cfg={cfg} patch={patch} />}
        {step === 1 && <ColumnsStep cfg={cfg} patch={patch} suggestions={suggestions} />}
        {step === 2 && <FiltersStep cfg={cfg} patch={patch} suggestions={suggestions} />}
        {step === 3 && <GroupingStep cfg={cfg} patch={patch} suggestions={suggestions} />}
        {step === 4 && <ChartStep cfg={cfg} patch={patch} />}
      </Box>
      <Box>
        <Typography variant="overline" color="text.secondary">
          Live preview
        </Typography>
        <Box
          sx={{
            height: 340,
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            overflow: 'hidden',
          }}
        >
          <ReportBody
            objects={live.items}
            config={cfg}
            scope={NO_SCOPE}
            kiosk={false}
            editing
            preview
            loading={live.loading}
            error={live.error}
          />
        </Box>
        <Typography variant="caption" color="text.secondary">
          The preview ignores the dashboard filters. The dashboard applies them.
        </Typography>
      </Box>
    </Box>
  );
}

function noop(): void {}
