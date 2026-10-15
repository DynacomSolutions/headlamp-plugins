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
import { useCatalogue, useSettings } from './data';
import {
  aggregate,
  buildProjectTree,
  folderIds,
  formatRelative,
  formatSize,
  parseKindPrefixes,
  pruneTree,
  Repo,
  shortDigest,
  SortKey,
  sortTags,
  sortTree,
  TreeNode,
} from './model';

export function TagTable({ tags, now }: { tags: Repo['tags']; now: number }) {
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Tag</TableCell>
          <TableCell>Digest</TableCell>
          <TableCell>Size</TableCell>
          <TableCell>Created</TableCell>
          <TableCell>Platforms</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {sortTags(tags).map(t => (
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

function FolderRow({
  node,
  depth,
  open,
  onToggle,
  now,
}: {
  node: TreeNode;
  depth: number;
  open: boolean;
  onToggle: () => void;
  now: number;
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
    </TableRow>
  );
}

function RepoRow({ node, depth, now }: { node: TreeNode; depth: number; now: number }) {
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
      </TableRow>
      <TableRow>
        <TableCell colSpan={4} sx={{ py: 0 }}>
          <Collapse in={open} unmountOnExit>
            <Box m={1}>
              {repo.tags.length ? <TagTable tags={repo.tags} now={now} /> : 'No tags'}
            </Box>
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
}: {
  nodes: TreeNode[];
  depth: number;
  open: Set<string>;
  toggle: (id: string) => void;
  now: number;
}) {
  return (
    <>
      {nodes.map(n =>
        n.repo ? (
          <RepoRow key={n.id} node={n} depth={depth} now={now} />
        ) : (
          <React.Fragment key={n.id}>
            <FolderRow node={n} depth={depth} open={open.has(n.id)} onToggle={() => toggle(n.id)} now={now} />
            {open.has(n.id) && (
              <TreeRows nodes={n.children} depth={depth + 1} open={open} toggle={toggle} now={now} />
            )}
          </React.Fragment>
        )
      )}
    </>
  );
}

export function RegistryPage() {
  const settings = useSettings();
  const { catalogue, loading, error, refresh } = useCatalogue(settings);
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<{ key: SortKey; desc: boolean }>({
    key: 'name',
    desc: false,
  });
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [catalogue]);
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const tree = React.useMemo(
    () => buildProjectTree(catalogue?.repositories ?? [], parseKindPrefixes(settings.kindPrefixes)),
    [catalogue, settings.kindPrefixes]
  );
  const rows = React.useMemo(
    () => sortTree(pruneTree(tree, query), sort.key, sort.desc),
    [tree, query, sort]
  );
  const matches = React.useMemo(() => rows.reduce((n, r) => n + aggregate(r).count, 0), [rows]);
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
    <SectionBox title="Registry">
      <Box display="flex" gap={2} alignItems="center" mb={2} flexWrap="wrap">
        <TextField
          size="small"
          label="Search repositories"
          value={query}
          onChange={e => search(e.target.value)}
        />
        <Button onClick={refresh}>Refresh</Button>
        {catalogue?.generatedAt && (
          <Tooltip title={catalogue.generatedAt}>
            <Typography variant="body2">
              Updated {formatRelative(catalogue.generatedAt, now)}
            </Typography>
          </Tooltip>
        )}
        {catalogue && <Chip size="small" label={`${matches} of ${catalogue.repositories.length}`} />}
      </Box>
      {error && <Alert severity="error">Could not load the catalogue: {error}</Alert>}
      {catalogue?.error && (
        <Alert severity="warning">Backend reports an error (showing cached data): {catalogue.error}</Alert>
      )}
      {loading && <CircularProgress aria-label="Loading" />}
      {!loading && catalogue && matches === 0 && (
        <Typography>
          {catalogue.repositories.length ? 'No repositories match the search.' : 'The registry has no repositories.'}
        </Typography>
      )}
      {rows.length > 0 && (
        <Table size="small">
          <TableHead>
            <TableRow>
              {head('name', 'Repository')}
              <TableCell>Tags / repositories</TableCell>
              {head('size', 'Total size')}
              {head('created', 'Last created')}
            </TableRow>
          </TableHead>
          <TableBody>
            <TreeRows nodes={rows} depth={0} open={open} toggle={toggle} now={now} />
          </TableBody>
        </Table>
      )}
    </SectionBox>
  );
}
