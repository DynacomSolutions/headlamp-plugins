import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import MuiLink from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TableSortLabel from '@mui/material/TableSortLabel';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink, useHistory, useLocation, useParams } from 'react-router-dom';
import { LoadState, useReport } from './data';
import {
  BASE_PATH,
  blockerChain,
  Component,
  countsOf,
  detailPath,
  filterComponents,
  formatAge,
  isStale,
  nodeSkew,
  Report,
  reportAgeHours,
  sortComponents,
  SortKey,
  STALE_AFTER_HOURS,
  STATUSES,
  View,
  viewFromSearch,
  viewToSearch,
} from './model';

const STATUS_LABEL = {
  'up-to-date': 'Up to date',
  available: 'Update available',
  blocked: 'Blocked',
  unknown: 'Unknown',
} as const;
const STATUS_COLOUR = {
  'up-to-date': 'success',
  available: 'info',
  blocked: 'warning',
  unknown: 'default',
} as const;

const safeUrl = (u: string): string => (/^https?:\/\//i.test(u) ? u : '');

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  const url = safeUrl(href);
  if (!url) return <>{children}</>;
  return (
    <MuiLink href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </MuiLink>
  );
}

export function StatusChips({ c }: { c: Component }) {
  return (
    <Box display="flex" gap={0.5} flexWrap="wrap">
      <Chip size="small" label={STATUS_LABEL[c.status]} color={STATUS_COLOUR[c.status]} />
      {c.security && <Chip size="small" label="Security" color="error" />}
    </Box>
  );
}

function Blockers({ c }: { c: Component }) {
  if (!c.blockers.length) return <>-</>;
  return (
    <Box component="ul" sx={{ m: 0, pl: 2 }}>
      {c.blockers.map((b, i) => (
        <li key={i}>
          <Ext href={b.source}>{b.reason || 'Blocked'}</Ext>
          {b.requires && (
            <Typography variant="caption" component="div" color="text.secondary">
              Requires {b.requires}
            </Typography>
          )}
        </li>
      ))}
    </Box>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <Card variant="outlined" sx={{ minWidth: 150, flex: '1 1 150px' }}>
      <CardContent>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="h5" component="div" sx={{ color: tone }}>
          {value}
        </Typography>
      </CardContent>
    </Card>
  );
}

export function Summary({ report, now }: { report: Report; now: number }) {
  const counts = countsOf(report.components);
  const age = reportAgeHours(report.generatedAt, now);
  const { server, nodes } = report.kubernetes;
  return (
    <Box p={2} display="flex" flexDirection="column" gap={2}>
      <Box display="flex" gap={2} flexWrap="wrap" role="group" aria-label="Update counts">
        <SummaryCard label="Updates available" value={counts.available} />
        <SummaryCard
          label="Blocked"
          value={counts.blocked}
          tone={counts.blocked ? 'warning.main' : undefined}
        />
        <SummaryCard
          label="Security"
          value={counts.security}
          tone={counts.security ? 'error.main' : undefined}
        />
        <SummaryCard label="Unknown" value={counts.unknown} />
      </Box>
      {isStale(age) && (
        <Alert severity="warning">
          {age === null
            ? 'The report has no valid generation time, so its freshness cannot be checked.'
            : `The report is ${formatAge(
                age
              )} old (more than ${STALE_AFTER_HOURS} h). The version tracker may have stopped running.`}
        </Alert>
      )}
      <Box display="flex" gap={2} flexWrap="wrap" alignItems="flex-start">
        <SummaryCard label="Kubernetes server" value={server || 'Unknown'} />
        <SummaryCard label="Report age" value={formatAge(age)} />
        <Card variant="outlined" sx={{ flex: '3 1 320px' }}>
          <CardContent>
            <Typography variant="body2" color="text.secondary" id="node-versions">
              Node versions
            </Typography>
            <Box
              display="flex"
              gap={1}
              flexWrap="wrap"
              mt={1}
              component="ul"
              sx={{ listStyle: 'none', m: 0, p: 0 }}
              aria-labelledby="node-versions"
            >
              {nodes.length === 0 && <li>No nodes reported</li>}
              {nodes.map(n => {
                const skew = nodeSkew(server, n.version);
                return (
                  <li key={n.name}>
                    <Chip
                      size="small"
                      variant={skew === 'none' ? 'outlined' : 'filled'}
                      color={skew === 'newer' ? 'error' : skew === 'older' ? 'warning' : 'default'}
                      label={`${n.name}: ${n.version || 'unknown'}${
                        skew === 'newer'
                          ? ' (newer than server)'
                          : skew === 'older'
                          ? ' (older than server)'
                          : ''
                      }`}
                    />
                  </li>
                );
              })}
            </Box>
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Component' },
  { key: 'category', label: 'Category' },
  { key: 'current', label: 'Current' },
  { key: 'latest', label: 'Latest' },
  { key: 'status', label: 'Status' },
];

function ListView({ report }: { report: Report }) {
  const history = useHistory();
  const location = useLocation();
  const view = viewFromSearch(location.search);
  const setView = (patch: Partial<View>) =>
    history.replace({ pathname: location.pathname, search: viewToSearch({ ...view, ...patch }) });
  const categories = Array.from(new Set(report.components.map(c => c.category))).sort();
  const rows = sortComponents(filterComponents(report.components, view), view.sort, view.dir);
  const sortBy = (key: SortKey) =>
    setView({ sort: key, dir: view.sort === key && view.dir === 'asc' ? 'desc' : 'asc' });

  return (
    <SectionBox title="Components">
      <Box
        role="search"
        aria-label="Filter components"
        display="flex"
        gap={2}
        flexWrap="wrap"
        p={2}
      >
        <TextField
          size="small"
          type="search"
          label="Search"
          value={view.q}
          onChange={e => setView({ q: e.target.value })}
          sx={{ minWidth: 240 }}
        />
        <TextField
          select
          size="small"
          label="Status"
          value={view.status}
          onChange={e => setView({ status: e.target.value as View['status'] })}
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="">All</MenuItem>
          {STATUSES.map(s => (
            <MenuItem key={s} value={s}>
              {STATUS_LABEL[s]}
            </MenuItem>
          ))}
          <MenuItem value="security">Security</MenuItem>
        </TextField>
        <TextField
          select
          size="small"
          label="Category"
          value={view.category}
          onChange={e => setView({ category: e.target.value })}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="">All</MenuItem>
          {categories.map(c => (
            <MenuItem key={c} value={c}>
              {c}
            </MenuItem>
          ))}
        </TextField>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ px: 2 }} role="status">
        Showing {rows.length} of {report.components.length} components
      </Typography>
      <TableContainer>
        <Table size="small" aria-label="Component update status">
          <TableHead>
            <TableRow>
              {COLUMNS.map(col => (
                <TableCell key={col.key} sortDirection={view.sort === col.key ? view.dir : false}>
                  <TableSortLabel
                    active={view.sort === col.key}
                    direction={view.sort === col.key ? view.dir : 'asc'}
                    onClick={() => sortBy(col.key)}
                  >
                    {col.label}
                  </TableSortLabel>
                </TableCell>
              ))}
              <TableCell>Blockers</TableCell>
              <TableCell>Blocks</TableCell>
              <TableCell>Release notes</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map(c => (
              <TableRow key={c.id} hover>
                <TableCell>
                  <MuiLink
                    component={RouterLink}
                    to={{ pathname: detailPath(c.id), search: location.search }}
                  >
                    {c.name}
                  </MuiLink>
                </TableCell>
                <TableCell>{c.category}</TableCell>
                <TableCell>{c.current || '-'}</TableCell>
                <TableCell>
                  <Ext href={c.latestUrl}>{c.latest || '-'}</Ext>
                </TableCell>
                <TableCell>
                  <StatusChips c={c} />
                </TableCell>
                <TableCell>
                  <Blockers c={c} />
                </TableCell>
                <TableCell>{c.blocks.join(', ') || '-'}</TableCell>
                <TableCell>
                  {safeUrl(c.releaseNotesUrl) ? (
                    <Ext href={c.releaseNotesUrl}>Release notes</Ext>
                  ) : (
                    '-'
                  )}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={COLUMNS.length + 3}>
                  No components match the current filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </SectionBox>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <Typography component="dt" variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography component="dd" variant="body1" sx={{ m: 0 }}>
        {children}
      </Typography>
    </>
  );
}

function ComponentLinks({ list, search }: { list: Component[]; search: string }) {
  if (!list.length) return <>None</>;
  return (
    <>
      {list.map((x, i) => (
        <React.Fragment key={x.id}>
          {i > 0 && ', '}
          <MuiLink component={RouterLink} to={{ pathname: detailPath(x.id), search }}>
            {x.name}
          </MuiLink>
        </React.Fragment>
      ))}
    </>
  );
}

function DetailView({ report, id }: { report: Report; id: string }) {
  const location = useLocation();
  const c = report.components.find(x => x.id === id);
  const back = (
    <MuiLink component={RouterLink} to={{ pathname: BASE_PATH, search: location.search }}>
      Back to all components
    </MuiLink>
  );
  if (!c) {
    return (
      <SectionBox title="Component not found">
        <Box p={2}>
          <Alert severity="warning">The report has no component with id "{id}".</Alert>
          <Box mt={2}>{back}</Box>
        </Box>
      </SectionBox>
    );
  }
  const { blockedBy, blocks } = blockerChain(report, c);
  return (
    <SectionBox title={c.name}>
      <Box p={2} display="flex" flexDirection="column" gap={2}>
        <Box>{back}</Box>
        {c.error && <Alert severity="error">The last check failed: {c.error}</Alert>}
        <Box
          component="dl"
          sx={{
            display: 'grid',
            gridTemplateColumns: 'max-content 1fr',
            columnGap: 3,
            rowGap: 1,
            m: 0,
          }}
        >
          <Field label="Id">{c.id}</Field>
          <Field label="Category">{c.category}</Field>
          <Field label="Status">
            <StatusChips c={c} />
          </Field>
          <Field label="Current version">{c.current || '-'}</Field>
          <Field label="Latest version">
            <Ext href={c.latestUrl}>{c.latest || '-'}</Ext>
          </Field>
          <Field label="Release notes">
            {safeUrl(c.releaseNotesUrl) ? (
              <Ext href={c.releaseNotesUrl}>{c.releaseNotesUrl}</Ext>
            ) : (
              '-'
            )}
          </Field>
          <Field label="Last checked">{c.checkedAt || '-'}</Field>
        </Box>
        <Typography variant="h6" component="h3">
          Blocker chain
        </Typography>
        <Box
          component="dl"
          sx={{
            display: 'grid',
            gridTemplateColumns: 'max-content 1fr',
            columnGap: 3,
            rowGap: 1,
            m: 0,
          }}
        >
          <Field label="Blocked by">
            {c.blockers.length ? <Blockers c={c} /> : 'Nothing'}
            {blockedBy.length > 0 && (
              <div>
                Also blocked by <ComponentLinks list={blockedBy} search={location.search} />
              </div>
            )}
          </Field>
          <Field label="Blocks">
            <ComponentLinks list={blocks} search={location.search} />
            {c.blocks.filter(b => !blocks.some(x => x.id === b)).length > 0 && (
              <div>
                Not tracked: {c.blocks.filter(b => !blocks.some(x => x.id === b)).join(', ')}
              </div>
            )}
          </Field>
        </Box>
      </Box>
    </SectionBox>
  );
}

/** Presentational entry point: everything the URL says is read from the router. */
export function UpdatesView({ state, now }: { state: LoadState; now: number }) {
  const { id } = useParams<{ id?: string }>();
  let body: React.ReactNode;
  switch (state.phase) {
    case 'loading':
      body = <CircularProgress aria-label="Loading the update report" />;
      break;
    case 'missing':
      body = (
        <Alert severity="info">
          No update report found. Expected a ConfigMap named version-tracker-report labelled
          app.kubernetes.io/name=version-tracker; check that the version tracker is deployed and has
          run once.
        </Alert>
      );
      break;
    case 'forbidden':
      body = (
        <Alert severity="error">
          You are not allowed to read the update report ConfigMap ({state.message}). Grant read
          access to ConfigMaps in the namespace that holds it.
        </Alert>
      );
      break;
    case 'error':
      body = <Alert severity="error">Could not load the update report: {state.message}</Alert>;
      break;
    case 'loaded':
      if (state.result.kind !== 'ok') {
        body = (
          <Alert severity="error">
            {state.result.kind === 'schema'
              ? 'Unsupported report version. '
              : 'The report is unreadable. '}
            {state.result.message}
          </Alert>
        );
      } else if (id) {
        return <DetailView report={state.result.report} id={id} />;
      } else {
        return (
          <>
            <SectionBox title="Updates">
              <Summary report={state.result.report} now={now} />
            </SectionBox>
            <ListView report={state.result.report} />
          </>
        );
      }
  }
  return (
    <SectionBox title="Updates">
      <Box p={2}>{body}</Box>
    </SectionBox>
  );
}

export function UpdatesPage() {
  const state = useReport();
  return <UpdatesView state={state} now={Date.now()} />;
}
