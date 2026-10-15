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
  aggregate,
  buildProjectTree,
  cronRow,
  dataSourceRow,
  dataVolumeRow,
  folderIds,
  formatRelative,
  formatSize,
  groupUsages,
  parseKindPrefixes,
  parsePrefixes,
  podUsages,
  pruneTree,
  Repo,
  shortDigest,
  SortKey,
  sortTags,
  sortTree,
  TreeNode,
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

const indent = (depth: number) => ({ pl: 1 + depth * 3 });

function Created({ ms, now }: { ms: number | null; now: number }) {
  if (ms === null) return <>unknown</>;
  const iso = new Date(ms).toISOString();
  return (
    <Tooltip title={iso}>
      <span>{formatRelative(iso, now)}</span>
    </Tooltip>
  );
}

/** Sum of the in-use counts of the repositories under a node. */
function inUse(n: TreeNode, counts: Map<string, number>): number {
  return n.repo ? counts.get(n.repo.name) ?? 0 : n.children.reduce((t, c) => t + inUse(c, counts), 0);
}

function FolderRow({
  node,
  depth,
  open,
  onToggle,
  now,
  counts,
}: {
  node: TreeNode;
  depth: number;
  open: boolean;
  onToggle: () => void;
  now: number;
  counts: Map<string, number>;
}) {
  const agg = aggregate(node);
  return (
    <TableRow hover>
      <TableCell sx={indent(depth)}>
        <Button
          size="small"
          color="inherit"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${node.label}`}
          onClick={onToggle}
        >
          {open ? '▾' : '▸'} {node.label}
        </Button>
      </TableCell>
      <TableCell>{agg.count} repositories</TableCell>
      <TableCell>{agg.count ? formatSize(agg.sizeBytes) : 'unknown'}</TableCell>
      <TableCell>
        <Created ms={agg.created} now={now} />
      </TableCell>
      <TableCell>{inUse(node, counts)}</TableCell>
    </TableRow>
  );
}

function RepoRow({
  node,
  depth,
  now,
  counts,
}: {
  node: TreeNode;
  depth: number;
  now: number;
  counts: Map<string, number>;
}) {
  const repo = node.repo as Repo;
  const [open, setOpen] = React.useState(false);
  const agg = aggregate(node);
  return (
    <>
      <TableRow hover>
        <TableCell sx={indent(depth)}>
          <IconButton
            size="small"
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${repo.name}`}
            onClick={() => setOpen(o => !o)}
          >
            {open ? '▾' : '▸'}
          </IconButton>
          <Tooltip title={repo.name}>
            <span>{node.label}</span>
          </Tooltip>
        </TableCell>
        <TableCell>{repo.tags.length}</TableCell>
        <TableCell>{formatSize(agg.sizeBytes)}</TableCell>
        <TableCell>
          <Created ms={agg.created} now={now} />
        </TableCell>
        <TableCell>{counts.get(repo.name) ?? 0}</TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={5} sx={{ py: 0 }}>
          <Collapse in={open} unmountOnExit>
            <Box m={1}>{repo.tags.length ? <TagTable repo={repo} now={now} counts={counts} /> : 'No tags'}</Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

function TreeRows({
  nodes,
  depth,
  open,
  toggle,
  now,
  counts,
}: {
  nodes: TreeNode[];
  depth: number;
  open: Set<string>;
  toggle: (id: string) => void;
  now: number;
  counts: Map<string, number>;
}) {
  return (
    <>
      {nodes.map(n =>
        n.repo ? (
          <RepoRow key={n.id} node={n} depth={depth} now={now} counts={counts} />
        ) : (
          <React.Fragment key={n.id}>
            <FolderRow
              node={n}
              depth={depth}
              open={open.has(n.id)}
              onToggle={() => toggle(n.id)}
              now={now}
              counts={counts}
            />
            {open.has(n.id) && (
              <TreeRows nodes={n.children} depth={depth + 1} open={open} toggle={toggle} now={now} counts={counts} />
            )}
          </React.Fragment>
        )
      )}
    </>
  );
}

function RegistryImages({
  repos,
  counts,
  now,
  kindPrefixes,
}: {
  repos: Repo[];
  counts: Map<string, number>;
  now: number;
  kindPrefixes: string;
}) {
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<{ key: SortKey; desc: boolean }>({ key: 'name', desc: false });
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const tree = React.useMemo(() => buildProjectTree(repos, parseKindPrefixes(kindPrefixes)), [repos, kindPrefixes]);
  const rows = React.useMemo(() => sortTree(pruneTree(tree, query), sort.key, sort.desc), [tree, query, sort]);
  const toggle = (id: string) =>
    setOpen(o => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // A search opens every folder that holds a match; clearing it collapses all again.
  const search = (q: string) => {
    setQuery(q);
    setOpen(new Set(q.trim() ? folderIds(pruneTree(tree, q)) : []));
  };
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
      <TextField size="small" label="Search VM images" value={query} onChange={e => search(e.target.value)} />
      {rows.length === 0 ? (
        <Typography>{repos.length ? 'No VM images match the search.' : 'No VM images in the registry.'}</Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              {head('name', 'Repository')}
              <TableCell>Tags / repositories</TableCell>
              {head('size', 'Total size')}
              {head('created', 'Last created')}
              <TableCell>In use by</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            <TreeRows nodes={rows} depth={0} open={open} toggle={toggle} now={now} counts={counts} />
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
        {catalogue && (
          <RegistryImages
            repos={repos}
            counts={counts}
            now={now}
            kindPrefixes={settings.kindPrefixes}
          />
        )}
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
