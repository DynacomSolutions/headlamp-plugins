import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TableSortLabel from '@mui/material/TableSortLabel';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  ListResult,
  useCatalogue,
  useDataImportCrons,
  useDataSources,
  useDataVolumes,
  useNodes,
  usePods,
  usePvcs,
  useSettings,
  useVirtualMachineInstances,
  useVirtualMachines,
} from './data';
import {
  cronRow,
  dataSourceRow,
  dataVolumeRow,
  filterRepos,
  formatRelative,
  formatSize,
  groupUsages,
  lastCreated,
  parsePrefixes,
  podUsages,
  Repo,
  repoSize,
  shortDigest,
  SortKey,
  sortRepos,
  sortTags,
  usageCounts,
  virtualKubeletNodes,
  vmRepos,
  vmRows,
  vmUsages,
} from './model';

function Rows({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          {head.map(h => (
            <TableCell key={h}>{h}</TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i}>
            {r.map((c, j) => (
              <TableCell key={j}>{c}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Loading, error and empty handling shared by the Kubernetes tables; hidden when the CRD is absent. */
function Listing({ title, res, children }: { title: string; res: ListResult; children: React.ReactNode }) {
  if (res.absent) return null;
  return (
    <Box mb={2}>
      <Typography variant="subtitle1">{title}</Typography>
      {res.loading && <CircularProgress size={20} aria-label={`Loading ${title}`} />}
      {res.error && <Alert severity="error">{res.error}</Alert>}
      {!res.loading && !res.error && (res.items.length ? children : <Typography variant="body2">None found.</Typography>)}
    </Box>
  );
}

const nn = (r: { namespace: string; name: string }) => `${r.namespace}/${r.name}`;

function KubeVirtDisks({ vms }: { vms: ListResult }) {
  const sources = useDataSources();
  const crons = useDataImportCrons();
  const dvs = useDataVolumes();
  const pvcs = usePvcs();
  if (vms.absent && sources.absent && crons.absent && dvs.absent) return null;
  return (
    <SectionBox title="KubeVirt disks">
      <Listing title="DataSources" res={sources}>
        <Rows
          head={['DataSource', 'Ready', 'Source']}
          rows={sources.items.map(dataSourceRow).map(r => [nn(r), r.ready, r.source])}
        />
      </Listing>
      <Listing title="DataImportCrons" res={crons}>
        <Rows
          head={['DataImportCron', 'Schedule', 'Target', 'Up to date', 'Last import']}
          rows={crons.items
            .map(cronRow)
            .map(r => [nn(r), r.schedule, r.target, r.ready, formatRelative(r.lastImport, Date.now())])}
        />
      </Listing>
      <Listing title="DataVolumes" res={dvs}>
        <Rows
          head={['DataVolume', 'Phase', 'Progress', 'Source']}
          rows={dvs.items.map(dataVolumeRow).map(r => [nn(r), r.phase, r.progress, r.source])}
        />
      </Listing>
      <Listing title="Virtual machine disks" res={vms}>
        <Rows
          head={['VM', 'State', 'Volume', 'Type', 'Backing', 'Capacity', 'Storage class']}
          rows={vmRows(vms.items, pvcs.items).flatMap(vm =>
            (vm.disks.length ? vm.disks : [null]).map(d => [
              nn(vm),
              vm.state,
              d?.volume ?? '-',
              d?.kind ?? '-',
              d?.ref ?? '-',
              d?.capacity ?? '-',
              d?.storageClass ?? '-',
            ])
          )}
        />
      </Listing>
    </SectionBox>
  );
}

function TagTable({ repo, now, counts }: { repo: Repo; now: number; counts: Map<string, number> }) {
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Tag</TableCell>
          <TableCell>Digest</TableCell>
          <TableCell>Size</TableCell>
          <TableCell>Created</TableCell>
          <TableCell>Platforms</TableCell>
          <TableCell>In use by</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {sortTags(repo.tags).map(t => (
          <TableRow key={t.tag}>
            <TableCell>{t.tag}</TableCell>
            <TableCell>
              <code>{shortDigest(t.digest)}</code>
              {t.digest && (
                <Button
                  size="small"
                  aria-label={`Copy digest of ${t.tag}`}
                  onClick={() => navigator.clipboard?.writeText(t.digest as string)}
                >
                  Copy
                </Button>
              )}
            </TableCell>
            <TableCell>{formatSize(t.sizeBytes)}</TableCell>
            <TableCell>
              <Tooltip title={t.created ?? 'unknown'}>
                <span>{formatRelative(t.created, now)}</span>
              </Tooltip>
            </TableCell>
            <TableCell>{t.platforms.join(', ') || 'unknown'}</TableCell>
            <TableCell>{counts.get(`${repo.name}:${t.tag}`) ?? 0}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RepoRow({ repo, now, counts }: { repo: Repo; now: number; counts: Map<string, number> }) {
  const [open, setOpen] = React.useState(false);
  const created = lastCreated(repo);
  return (
    <>
      <TableRow hover>
        <TableCell padding="checkbox">
          <IconButton
            size="small"
            aria-label={`${open ? 'Collapse' : 'Expand'} ${repo.name}`}
            onClick={() => setOpen(o => !o)}
          >
            {open ? '▾' : '▸'}
          </IconButton>
        </TableCell>
        <TableCell>{repo.name}</TableCell>
        <TableCell>{repo.tags.length}</TableCell>
        <TableCell>{formatSize(repoSize(repo))}</TableCell>
        <TableCell>
          {created === null ? (
            'unknown'
          ) : (
            <Tooltip title={new Date(created).toISOString()}>
              <span>{formatRelative(new Date(created).toISOString(), now)}</span>
            </Tooltip>
          )}
        </TableCell>
        <TableCell>{counts.get(repo.name) ?? 0}</TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={6} sx={{ py: 0 }}>
          <Collapse in={open} unmountOnExit>
            <Box m={1}>{repo.tags.length ? <TagTable repo={repo} now={now} counts={counts} /> : 'No tags'}</Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

function RegistryImages({
  repos,
  counts,
  now,
}: {
  repos: Repo[];
  counts: Map<string, number>;
  now: number;
}) {
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<{ key: SortKey; desc: boolean }>({ key: 'name', desc: false });
  const rows = React.useMemo(
    () => sortRepos(filterRepos(repos, query), sort.key, sort.desc),
    [repos, query, sort]
  );
  const head = (key: SortKey, label: string) => (
    <TableCell sortDirection={sort.key === key ? (sort.desc ? 'desc' : 'asc') : false}>
      <TableSortLabel
        active={sort.key === key}
        direction={sort.desc ? 'desc' : 'asc'}
        onClick={() => setSort(s => ({ key, desc: s.key === key ? !s.desc : false }))}
      >
        {label}
      </TableSortLabel>
    </TableCell>
  );
  return (
    <>
      <TextField size="small" label="Search VM images" value={query} onChange={e => setQuery(e.target.value)} />
      {rows.length === 0 ? (
        <Typography>{repos.length ? 'No VM images match the search.' : 'No VM images in the registry.'}</Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox" />
              {head('name', 'Repository')}
              <TableCell>Tags</TableCell>
              {head('size', 'Total size')}
              {head('created', 'Last created')}
              <TableCell>In use by</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map(r => (
              <RepoRow key={r.name} repo={r} now={now} counts={counts} />
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

export function VmImagesPage() {
  const settings = useSettings();
  const { catalogue, loading, error, refresh } = useCatalogue(settings);
  const vms = useVirtualMachines();
  const vmis = useVirtualMachineInstances();
  const pods = usePods();
  const nodes = useNodes();
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [catalogue]);

  const allRepos = React.useMemo(() => catalogue?.repositories ?? [], [catalogue]);
  const repos = React.useMemo(
    () => vmRepos(allRepos, parsePrefixes(settings.namePrefixes)),
    [allRepos, settings.namePrefixes]
  );
  const groups = React.useMemo(
    () =>
      groupUsages(
        [...podUsages(pods.items, virtualKubeletNodes(nodes.items)), ...vmUsages(vms.items, vmis.items)],
        allRepos
      ),
    [pods.items, nodes.items, vms.items, vmis.items, allRepos]
  );
  const counts = React.useMemo(() => usageCounts(groups), [groups]);

  return (
    <>
      <KubeVirtDisks vms={vms} />
      <SectionBox title="Registry VM images">
        <Box display="flex" gap={2} alignItems="center" mb={2} flexWrap="wrap">
          <Button onClick={refresh}>Refresh</Button>
          {catalogue?.generatedAt && (
            <Tooltip title={catalogue.generatedAt}>
              <Typography variant="body2">Updated {formatRelative(catalogue.generatedAt, now)}</Typography>
            </Tooltip>
          )}
          {catalogue && <Chip size="small" label={`${repos.length} VM image repositories`} />}
        </Box>
        {error && <Alert severity="error">Could not load the catalogue: {error}</Alert>}
        {catalogue?.error && (
          <Alert severity="warning">Backend reports an error (showing cached data): {catalogue.error}</Alert>
        )}
        {loading && <CircularProgress aria-label="Loading" />}
        {catalogue && <RegistryImages repos={repos} counts={counts} now={now} />}
      </SectionBox>
      <SectionBox title="In use">
        {(pods.error || nodes.error) && <Alert severity="error">{pods.error || nodes.error}</Alert>}
        {groups.length === 0 ? (
          <Typography>No pods on virtual-kubelet nodes or KubeVirt containerDisks are using images.</Typography>
        ) : (
          <Rows
            head={['Image', 'Registry match', 'Used by', 'Node']}
            rows={groups.map(g => [
              `${g.ref.path}${g.ref.tag ? `:${g.ref.tag}` : ''}${g.ref.digest ? `@${shortDigest(g.ref.digest)}` : ''}`,
              g.repo ? `${g.repo}${g.tag ? `:${g.tag}` : ' (tag not in registry)'}` : 'not in registry',
              <Box key="u" component="ul" sx={{ m: 0, pl: 2 }}>
                {g.users.map(u => (
                  <li key={`${u.kind}/${nn(u)}`}>
                    {u.kind} {nn(u)}
                  </li>
                ))}
              </Box>,
              <Box key="n" component="ul" sx={{ m: 0, pl: 2 }}>
                {g.users.map(u => (
                  <li key={`${u.kind}/${nn(u)}`}>{u.node ?? '-'}</li>
                ))}
              </Box>,
            ])}
          />
        )}
      </SectionBox>
    </>
  );
}
