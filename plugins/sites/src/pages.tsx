import { CommonComponents } from '@kinvolk/headlamp-plugin/lib';
const { Link: HLink, SectionBox, StatusLabel, Table } = CommonComponents;
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import MuiLink from '@mui/material/Link';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import React from 'react';
import { MAPPING_CRD, useSites } from './data';
import {
  aliasesOf,
  DEFAULT_FILTERS,
  Filters,
  filtersDirty,
  Kind,
  KindFilter,
  matchesSite,
  namespaceCounts,
  pathUrl,
  Site,
} from './model';

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <MuiLink href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </MuiLink>
  );
}

function kindStatus(kind: Kind): 'success' | 'warning' | '' {
  if (kind === 'tailnet') return 'success';
  if (kind === 'local' || kind === 'lan') return 'warning';
  return '';
}

function MappingLink({ m }: { m: Site['mappings'][number] }) {
  return (
    <HLink
      routeName="customresource"
      params={{ crd: MAPPING_CRD, namespace: m.namespace, crName: m.name }}
    >
      {m.name}
    </HLink>
  );
}

function SiteCell({ site }: { site: Site }) {
  const aliases = aliasesOf(site);
  const extra = site.paths.filter(p => p !== '/');
  return (
    <Box>
      <Typography variant="subtitle2" component="div">
        <Ext href={site.primaryUrl}>{site.app}</Ext>
      </Typography>
      <Typography variant="body2" color="text.secondary" component="div">
        {site.primaryUrl}
      </Typography>
      {aliases.length > 0 && (
        <Typography variant="caption" color="text.secondary" component="div">
          alias {aliases.join(', ')}
        </Typography>
      )}
      {extra.length > 0 && (
        <Typography variant="caption" component="div">
          {extra.map(p => (
            <Box key={p} component="span" sx={{ mr: 1.5 }}>
              <Ext href={pathUrl(site, p)}>{pathUrl(site, p)}</Ext>
            </Box>
          ))}
        </Typography>
      )}
    </Box>
  );
}

function Toolbar({
  filters,
  setFilters,
  namespaces,
  shown,
}: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  namespaces: [string, number][];
  shown: number;
}) {
  const toggleNs = (ns: string) =>
    setFilters({
      ...filters,
      namespaces: filters.namespaces.includes(ns)
        ? filters.namespaces.filter(n => n !== ns)
        : [...filters.namespaces, ns],
    });
  return (
    <Box role="search" aria-label="Filter sites" display="flex" flexDirection="column" gap={1.5} p={2}>
      <Box display="flex" gap={2} alignItems="center" flexWrap="wrap">
        <TextField
          size="small"
          type="search"
          label="Search"
          placeholder="App, host, namespace"
          value={filters.q}
          onChange={e => setFilters({ ...filters, q: e.target.value })}
          sx={{ minWidth: 280 }}
        />
        <ToggleButtonGroup
          size="small"
          exclusive
          value={filters.kind}
          aria-label="Kind"
          onChange={(_e, v: KindFilter | null) => v && setFilters({ ...filters, kind: v })}
        >
          <ToggleButton value="tailnet">Tailnet</ToggleButton>
          <ToggleButton value="all">All</ToggleButton>
          <ToggleButton value="local">Local</ToggleButton>
        </ToggleButtonGroup>
        <Button size="small" disabled={!filtersDirty(filters)} onClick={() => setFilters(DEFAULT_FILTERS)}>
          Clear filters
        </Button>
        <Typography variant="body2" aria-live="polite">
          {shown} site{shown === 1 ? '' : 's'}
        </Typography>
      </Box>
      {namespaces.length > 0 && (
        <Box display="flex" gap={1} alignItems="center" flexWrap="wrap">
          <Typography variant="body2">Namespace</Typography>
          {namespaces.map(([ns, n]) => (
            <Chip
              key={ns}
              size="small"
              label={`${ns} ${n}`}
              color={filters.namespaces.includes(ns) ? 'primary' : 'default'}
              variant={filters.namespaces.includes(ns) ? 'filled' : 'outlined'}
              onClick={() => toggleNs(ns)}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

export function SitesPage() {
  const { sites, loading, absent, error } = useSites();
  const [filters, setFilters] = React.useState<Filters>(DEFAULT_FILTERS);
  const shown = React.useMemo(() => sites.filter(s => matchesSite(s, filters)), [sites, filters]);
  const namespaces = React.useMemo(() => namespaceCounts(sites), [sites]);
  const tailnet = sites.filter(s => s.kind === 'tailnet').length;

  if (loading) {
    return (
      <SectionBox title="Sites">
        <CircularProgress aria-label="Loading sites" />
      </SectionBox>
    );
  }
  return (
    <SectionBox title="Sites">
      {absent && (
        <Alert severity="info" sx={{ mb: 1 }}>
          Mappings are not available: the Emissary CRDs (getambassador.io/v3alpha1) are not
          installed in this cluster, or are not visible to you.
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          Could not list Mappings: {error}
        </Alert>
      )}
      <Typography variant="body2" sx={{ px: 2, pt: 1 }}>
        {sites.length} sites, {tailnet} on the tailnet, {namespaces.length} namespaces. Updates live.
      </Typography>
      <Toolbar filters={filters} setFilters={setFilters} namespaces={namespaces} shown={shown.length} />
      {shown.length === 0 ? (
        <Typography sx={{ p: 2 }}>No sites match the current filters.</Typography>
      ) : (
        <Table
          data={shown}
          columns={
            [
              {
                header: 'Site',
                accessorFn: (s: Site) => `${s.app} ${s.primaryUrl}`,
                Cell: ({ row }: any) => <SiteCell site={row.original} />,
              },
              { header: 'Namespace', accessorFn: (s: Site) => s.namespace },
              { header: 'Service', accessorFn: (s: Site) => s.service },
              {
                header: 'Kind',
                accessorFn: (s: Site) => s.kind,
                Cell: ({ row }: any) => (
                  <StatusLabel status={kindStatus(row.original.kind)}>{row.original.kind}</StatusLabel>
                ),
              },
              {
                header: 'Mappings',
                accessorFn: (s: Site) => s.mappings.map(m => m.name).join(' '),
                Cell: ({ row }: any) => (
                  <Box display="flex" flexDirection="column">
                    {(row.original as Site).mappings.map(m => (
                      <MappingLink key={`${m.namespace}/${m.name}`} m={m} />
                    ))}
                  </Box>
                ),
              },
            ] as any
          }
        />
      )}
    </SectionBox>
  );
}
