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
  filterRepos,
  formatRelative,
  formatSize,
  lastCreated,
  Repo,
  repoSize,
  shortDigest,
  SortKey,
  sortRepos,
  sortTags,
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

function RepoRow({ repo, now }: { repo: Repo; now: number }) {
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
      </TableRow>
      <TableRow>
        <TableCell colSpan={5} sx={{ py: 0 }}>
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
  const rows = React.useMemo(
    () => sortRepos(filterRepos(catalogue?.repositories ?? [], query), sort.key, sort.desc),
    [catalogue, query, sort]
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
    <SectionBox title="Registry">
      <Box display="flex" gap={2} alignItems="center" mb={2} flexWrap="wrap">
        <TextField
          size="small"
          label="Search repositories"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <Button onClick={refresh}>Refresh</Button>
        {catalogue?.generatedAt && (
          <Tooltip title={catalogue.generatedAt}>
            <Typography variant="body2">
              Updated {formatRelative(catalogue.generatedAt, now)}
            </Typography>
          </Tooltip>
        )}
        {catalogue && <Chip size="small" label={`${rows.length} of ${catalogue.repositories.length}`} />}
      </Box>
      {error && <Alert severity="error">Could not load the catalogue: {error}</Alert>}
      {catalogue?.error && (
        <Alert severity="warning">Backend reports an error (showing cached data): {catalogue.error}</Alert>
      )}
      {loading && <CircularProgress aria-label="Loading" />}
      {!loading && catalogue && rows.length === 0 && (
        <Typography>
          {catalogue.repositories.length ? 'No repositories match the search.' : 'The registry has no repositories.'}
        </Typography>
      )}
      {rows.length > 0 && (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox" />
              {head('name', 'Repository')}
              <TableCell>Tags</TableCell>
              {head('size', 'Total size')}
              {head('created', 'Last created')}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map(r => (
              <RepoRow key={r.name} repo={r} now={now} />
            ))}
          </TableBody>
        </Table>
      )}
    </SectionBox>
  );
}
