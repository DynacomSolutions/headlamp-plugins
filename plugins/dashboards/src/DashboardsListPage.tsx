/* The list of dashboards (/dashboards): create, open, rename, duplicate and delete. */
import { Icon } from '@iconify/react';
import { Loader, SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink, useHistory } from 'react-router-dom';
import { useCanWrite, useDashboardList, useStorage } from './hooks';
import { cloneSpec } from './spec/edit';
import { countWidgets, emptySpec, slugify, uniqueSlug } from './spec/model';
import { StoredDashboard } from './storage/storage';
import { buildPath } from './urlState';

type Dialogue =
  | { kind: 'create' }
  | { kind: 'rename'; item: StoredDashboard }
  | { kind: 'duplicate'; item: StoredDashboard }
  | { kind: 'delete'; item: StoredDashboard };

function NameDialog(props: { title: string; label: string; initial: string; action: string; busy: boolean; onCancel: () => void; onSubmit: (v: string) => void }) {
  const [value, setValue] = React.useState(props.initial);
  const valid = value.trim() !== '';
  return (
    <Dialog open onClose={props.onCancel} aria-labelledby="name-dialog-title">
      <DialogTitle id="name-dialog-title">{props.title}</DialogTitle>
      <DialogContent>
        <TextField
          fullWidth
          size="small"
          label={props.label}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && valid && !props.busy && props.onSubmit(value.trim())}
          sx={{ mt: 1, minWidth: 320 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onCancel}>Cancel</Button>
        <Button variant="contained" disabled={!valid || props.busy} onClick={() => props.onSubmit(value.trim())}>
          {props.action}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function DashboardsListPage(): JSX.Element {
  const history = useHistory();
  const storage = useStorage();
  const list = useDashboardList(storage);
  const canWrite = useCanWrite(storage.namespace);
  const [dialogue, setDialogue] = React.useState<Dialogue | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const items = list.data ?? [];
  const writable = canWrite !== false;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setDialogue(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const freeName = (title: string) => uniqueSlug(slugify(title), items.map(i => i.name));

  const create = (title: string) =>
    run(async () => {
      const created = await storage.create(freeName(title), emptySpec(title));
      history.push(buildPath({ name: created.name, tab: '' }) + '?edit=1');
    });
  const duplicate = (item: StoredDashboard, title: string) =>
    run(async () => {
      const created = await storage.create(freeName(title), cloneSpec(item.spec, title));
      list.reload();
      history.push(buildPath({ name: created.name, tab: '' }));
    });
  const rename = (item: StoredDashboard, title: string) =>
    run(async () => {
      await storage.save(item, { ...item.spec, title });
      list.reload();
    });
  const remove = (item: StoredDashboard) =>
    run(async () => {
      await storage.remove(item.name);
      list.reload();
    });

  return (
    <SectionBox
      title="Dashboards"
      headerProps={{
        actions: [
          <Button
            key="new"
            variant="contained"
            disabled={!writable}
            startIcon={<Icon icon="mdi:plus" width={18} height={18} />}
            onClick={() => {
              setError('');
              setDialogue({ kind: 'create' });
            }}
          >
            New dashboard
          </Button>,
        ],
      }}
    >
      {canWrite === false && (
        <Alert severity="info" sx={{ mb: 2 }}>
          You have read-only access to dashboards in the namespace "{storage.namespace}". You can open them but not create or change them.
        </Alert>
      )}
      {list.error && (
        <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" onClick={list.reload}>Retry</Button>}>
          {list.error.message}
        </Alert>
      )}
      {error && !dialogue && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {list.loading && !list.data ? (
        <Loader title="Loading dashboards" />
      ) : (
        <Table size="small" aria-label="Dashboards">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell align="right">Tabs</TableCell>
              <TableCell align="right">Widgets</TableCell>
              <TableCell>Last saved</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.length === 0 && !list.error && (
              <TableRow>
                <TableCell colSpan={5}>
                  <Typography variant="body2" color="text.secondary">
                    No dashboards yet in the namespace "{storage.namespace}". Create one to start.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {items.map(item => (
              <TableRow key={item.name} hover>
                <TableCell>
                  <RouterLink to={buildPath({ name: item.name, tab: '' })}>{item.spec.title}</RouterLink>
                  {item.error && (
                    <Typography variant="caption" color="error" component="div">
                      {item.error}
                    </Typography>
                  )}
                  {item.spec.description && (
                    <Typography variant="caption" color="text.secondary" component="div">
                      {item.spec.description}
                    </Typography>
                  )}
                </TableCell>
                <TableCell align="right">{item.spec.tabs.length}</TableCell>
                <TableCell align="right">{countWidgets(item.spec)}</TableCell>
                <TableCell>{item.spec.modifiedAt ? new Date(item.spec.modifiedAt).toLocaleString() : ''}</TableCell>
                <TableCell align="right">
                  <Box sx={{ display: 'inline-flex' }}>
                    {(
                      [
                        ['Rename', 'mdi:pencil-outline', 'rename'],
                        ['Duplicate', 'mdi:content-copy', 'duplicate'],
                        ['Delete', 'mdi:delete-outline', 'delete'],
                      ] as const
                    ).map(([label, icon, kind]) => (
                      <Tooltip key={kind} title={`${label} ${item.spec.title}`}>
                        <span>
                          <IconButton
                            size="small"
                            aria-label={`${label} ${item.spec.title}`}
                            disabled={!writable || (kind === 'rename' && !!item.error)}
                            onClick={() => {
                              setError('');
                              setDialogue({ kind, item });
                            }}
                          >
                            <Icon icon={icon} width={18} height={18} />
                          </IconButton>
                        </span>
                      </Tooltip>
                    ))}
                  </Box>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {dialogue?.kind === 'create' && (
        <NameDialog title="New dashboard" label="Title" initial="" action="Create" busy={busy} onCancel={() => setDialogue(null)} onSubmit={create} />
      )}
      {dialogue?.kind === 'rename' && (
        <NameDialog title="Rename dashboard" label="Title" initial={dialogue.item.spec.title} action="Rename" busy={busy} onCancel={() => setDialogue(null)} onSubmit={v => rename(dialogue.item, v)} />
      )}
      {dialogue?.kind === 'duplicate' && (
        <NameDialog title="Duplicate dashboard" label="Title of the copy" initial={`${dialogue.item.spec.title} copy`} action="Duplicate" busy={busy} onCancel={() => setDialogue(null)} onSubmit={v => duplicate(dialogue.item, v)} />
      )}
      {dialogue?.kind === 'delete' && (
        <Dialog open onClose={() => setDialogue(null)} aria-labelledby="delete-title">
          <DialogTitle id="delete-title">Delete dashboard</DialogTitle>
          <DialogContent>
            <DialogContentText>Delete "{dialogue.item.spec.title}"? This removes its ConfigMap and cannot be undone.</DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDialogue(null)}>Cancel</Button>
            <Button color="error" variant="contained" disabled={busy} onClick={() => remove(dialogue.item)}>
              Delete
            </Button>
          </DialogActions>
        </Dialog>
      )}
      {dialogue && error && (
        <Alert severity="error" sx={{ position: 'fixed', bottom: 16, left: 16, zIndex: 2000 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
    </SectionBox>
  );
}
