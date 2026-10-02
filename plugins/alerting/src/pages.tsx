/// <reference types="@kinvolk/headlamp-plugin" />
import { CommonComponents } from '@kinvolk/headlamp-plugin/lib';
const { SectionBox, StatusLabel, Table } = CommonComponents;
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  applyLive,
  deleteLive,
  requestTestSend,
  useResources,
  useSecretKeys,
  useSecretNames,
  useSettings,
  useStateApi,
} from './data';
import {
  CHANNEL_TYPES,
  ChannelForm,
  channelFromResource,
  channelResource,
  emptyChannel,
  emptyRoute,
  manifestFileName,
  parseList,
  ROUTE_KINDS,
  RouteForm,
  routeFromResource,
  routeResource,
  SecretRef,
  Settings,
  stateSeverity,
  testState,
  toYaml,
  validateChannel,
  validateRoute,
} from './model';

type Kind = 'NotificationChannel' | 'AlertRoute';

function Missing({ settings, error }: { settings: Settings; error?: string | null }) {
  return (
    <Alert severity={error ? 'error' : 'info'}>
      {error
        ? `Could not read resources: ${error}`
        : `The ${settings.group}/${settings.version} custom resources are not installed in this cluster. Check the plugin settings.`}
    </Alert>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/yaml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Shows generated YAML and the ways to ship it: pull request, copy, download, optional live apply. */
function ChangeDialog(props: {
  settings: Settings;
  kind: Kind;
  resource: any;
  existing: any | null;
  onClose: () => void;
}) {
  const { settings: s, kind, resource, existing, onClose } = props;
  const yaml = React.useMemo(() => toYaml(resource), [resource]);
  const fileName = manifestFileName(kind, resource.metadata.name);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{
    severity: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setMsg({ severity: 'error', text: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        {existing ? 'Update' : 'Create'} {kind}
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1 }}>
          Saving writes this resource to the cluster. If the resource is also managed in Git, copy
          or download the YAML and commit it there too.
        </Typography>
        <Box
          component="pre"
          sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 1, overflow: 'auto', fontSize: 13 }}
        >
          {yaml}
        </Box>
        {msg && (
          <Alert severity={msg.severity} sx={{ mt: 1 }}>
            {msg.text}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button
          variant="contained"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await applyLive(s, kind, resource, existing);
              setMsg({ severity: 'success', text: 'Saved to the cluster.' });
            })
          }
        >
          Save
        </Button>
        <Button
          onClick={() =>
            navigator.clipboard
              ?.writeText(yaml)
              .then(() => setMsg({ severity: 'info', text: 'YAML copied.' }))
          }
        >
          Copy YAML
        </Button>
        <Button onClick={() => download(fileName, yaml)}>Download YAML</Button>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function SecretPicker(props: {
  label: string;
  settings: Settings;
  names: string[];
  /** false: Secrets cannot be listed, so name and key are typed */
  listable: boolean;
  value: SecretRef;
  onChange: (v: SecretRef) => void;
  required?: boolean;
}) {
  const { label, settings, names, listable, value, onChange, required } = props;
  const { keys, available: keysAvailable } = useSecretKeys(settings, value.name, listable);
  if (!listable || !keysAvailable) {
    return (
      <Box display="flex" gap={1}>
        <TextField
          size="small"
          fullWidth
          required={required}
          label={`${label}: Secret name`}
          value={value.name}
          onChange={e => onChange({ ...value, name: e.target.value })}
        />
        <TextField
          size="small"
          fullWidth
          required={required}
          label="Key"
          disabled={!value.name}
          value={value.key}
          onChange={e => onChange({ ...value, key: e.target.value })}
        />
      </Box>
    );
  }
  return (
    <Box display="flex" gap={1}>
      <TextField
        select
        size="small"
        fullWidth
        required={required}
        label={`${label}: Secret`}
        value={value.name}
        onChange={e => onChange({ name: e.target.value, key: '' })}
      >
        {!required && <MenuItem value="">None</MenuItem>}
        {value.name && !names.includes(value.name) && (
          <MenuItem value={value.name}>{value.name}</MenuItem>
        )}
        {names.map(n => (
          <MenuItem key={n} value={n}>
            {n}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        select
        size="small"
        fullWidth
        required={required}
        label="Key"
        disabled={!value.name}
        value={value.key}
        onChange={e => onChange({ ...value, key: e.target.value })}
      >
        {value.key && !keys.includes(value.key) && (
          <MenuItem value={value.key}>{value.key}</MenuItem>
        )}
        {keys.map(k => (
          <MenuItem key={k} value={k}>
            {k}
          </MenuItem>
        ))}
      </TextField>
    </Box>
  );
}

function ChannelEditor(props: {
  settings: Settings;
  initial: ChannelForm;
  isNew: boolean;
  onCancel: () => void;
  onDone: (f: ChannelForm) => void;
}) {
  const { settings, isNew, onCancel, onDone } = props;
  const [f, setF] = React.useState<ChannelForm>(props.initial);
  const { names, available: listable } = useSecretNames(settings);
  const problems = validateChannel(f);
  const up = (patch: Partial<ChannelForm>) => setF(prev => ({ ...prev, ...patch }));
  return (
    <Dialog open onClose={onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>{isNew ? 'New channel' : `Edit channel ${f.name}`}</DialogTitle>
      <DialogContent>
        <Box display="flex" flexDirection="column" gap={2} sx={{ pt: 1 }}>
          <TextField
            label="Name"
            size="small"
            value={f.name}
            disabled={!isNew}
            onChange={e => up({ name: e.target.value })}
          />
          <TextField
            select
            label="Type"
            size="small"
            value={f.type}
            onChange={e => up({ type: e.target.value as ChannelForm['type'] })}
          >
            {CHANNEL_TYPES.map(t => (
              <MenuItem key={t} value={t}>
                {t}
              </MenuItem>
            ))}
          </TextField>
          <FormControlLabel
            control={
              <Switch checked={f.enabled} onChange={e => up({ enabled: e.target.checked })} />
            }
            label="Enabled"
          />
          {f.type === 'email' && (
            <TextField
              label="Recipients"
              size="small"
              helperText="Comma or newline separated."
              multiline
              value={f.emailTo.join(', ')}
              onChange={e => up({ emailTo: parseList(e.target.value) })}
            />
          )}
          {f.type === 'ntfy' && (
            <>
              <TextField
                label="Server"
                size="small"
                value={f.ntfyServer}
                onChange={e => up({ ntfyServer: e.target.value })}
              />
              <TextField
                label="Topic"
                size="small"
                value={f.ntfyTopic}
                onChange={e => up({ ntfyTopic: e.target.value })}
              />
              <TextField
                label="Priority (optional)"
                size="small"
                value={f.ntfyPriority}
                onChange={e => up({ ntfyPriority: e.target.value })}
              />
              <SecretPicker
                label="Token (optional)"
                settings={settings}
                names={names}
                listable={listable}
                value={f.ntfyTokenSecret}
                onChange={v => up({ ntfyTokenSecret: v })}
              />
            </>
          )}
          {f.type === 'pushover' && (
            <>
              <SecretPicker
                required
                label="User key"
                settings={settings}
                names={names}
                listable={listable}
                value={f.pushoverUserKeySecret}
                onChange={v => up({ pushoverUserKeySecret: v })}
              />
              <SecretPicker
                required
                label="App token"
                settings={settings}
                names={names}
                listable={listable}
                value={f.pushoverTokenSecret}
                onChange={v => up({ pushoverTokenSecret: v })}
              />
            </>
          )}
          {f.type === 'webhook' && (
            <>
              <TextField
                label="URL"
                size="small"
                value={f.webhookUrl}
                onChange={e => up({ webhookUrl: e.target.value })}
              />
              <SecretPicker
                label="Headers (optional)"
                settings={settings}
                names={names}
                listable={listable}
                value={f.webhookHeadersSecret}
                onChange={v => up({ webhookHeadersSecret: v })}
              />
            </>
          )}
          {problems.length > 0 && (
            <Alert severity="warning">
              {problems.map(p => (
                <div key={p}>{p}</div>
              ))}
            </Alert>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="contained" disabled={problems.length > 0} onClick={() => onDone(f)}>
          Review change
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function TestCell({ cr, settings }: { cr: any; settings: Settings }) {
  const t = testState(cr, settings);
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <Box display="flex" alignItems="center" gap={1}>
      <Button
        size="small"
        variant="outlined"
        disabled={t.state === 'pending'}
        onClick={() => {
          setErr(null);
          requestTestSend(settings, cr.metadata.name).catch(e => setErr(String(e?.message || e)));
        }}
      >
        Send test
      </Button>
      {t.state === 'pending' && (
        <Box display="flex" alignItems="center" gap={0.5}>
          <CircularProgress size={14} />
          <Typography variant="caption">Pending</Typography>
        </Box>
      )}
      {t.state === 'handled' && (
        <StatusLabel status={t.result === 'success' || t.result === 'ok' ? 'success' : 'error'}>
          {t.result || 'handled'}
        </StatusLabel>
      )}
      {err && (
        <Typography variant="caption" color="error">
          {err}
        </Typography>
      )}
    </Box>
  );
}

export function ChannelsPage() {
  const settings = useSettings();
  const list = useResources('NotificationChannel', settings);
  const [editing, setEditing] = React.useState<{ form: ChannelForm; existing: any | null } | null>(
    null
  );
  const [reviewing, setReviewing] = React.useState<{ resource: any; existing: any | null } | null>(
    null
  );
  const [notice, setNotice] = React.useState<string | null>(null);
  return (
    <SectionBox
      title="Notification channels"
      headerProps={{
        actions: [
          <Button
            key="new"
            variant="contained"
            onClick={() => setEditing({ form: emptyChannel(), existing: null })}
          >
            New channel
          </Button>,
        ],
      }}
    >
      {notice && (
        <Alert severity="info" sx={{ mb: 1 }} onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      <Typography variant="body2" sx={{ mb: 1 }}>
        Edits are written to the cluster. Test sends are applied live as annotations.
      </Typography>
      {list.absent || list.error ? (
        <Missing settings={settings} error={list.error} />
      ) : (
        <Table
          loading={list.loading}
          data={list.items}
          columns={[
            { header: 'Name', accessorFn: (c: any) => c.metadata.name },
            { header: 'Type', accessorFn: (c: any) => c.spec?.type },
            {
              header: 'Enabled',
              accessorFn: (c: any) => (c.spec?.enabled === false ? 'no' : 'yes'),
              Cell: ({ row }: any) => (
                <StatusLabel status={row.original.spec?.enabled === false ? 'warning' : 'success'}>
                  {row.original.spec?.enabled === false ? 'disabled' : 'enabled'}
                </StatusLabel>
              ),
            },
            { header: 'Last result', accessorFn: (c: any) => c.status?.lastResult || '' },
            { header: 'Last send', accessorFn: (c: any) => c.status?.lastSendTime || '' },
            { header: 'Last error', accessorFn: (c: any) => c.status?.lastError || '' },
            {
              header: 'Test',
              id: 'test',
              enableSorting: false,
              Cell: ({ row }: any) => <TestCell cr={row.original} settings={settings} />,
            },
            {
              header: 'Actions',
              id: 'actions',
              enableSorting: false,
              Cell: ({ row }: any) => (
                <Box display="flex" gap={1}>
                  <Button
                    size="small"
                    onClick={() =>
                      setEditing({
                        form: channelFromResource(row.original),
                        existing: row.original,
                      })
                    }
                  >
                    Edit
                  </Button>
                  {
                    <Button
                      size="small"
                      color="error"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete channel ${row.original.metadata.name} from the cluster?`
                          )
                        )
                          deleteLive(
                            settings,
                            'NotificationChannel',
                            row.original.metadata.name
                          ).catch(e => setNotice(String(e?.message || e)));
                      }}
                    >
                      Delete
                    </Button>
                  }
                </Box>
              ),
            },
          ]}
        />
      )}
      {editing && (
        <ChannelEditor
          settings={settings}
          initial={editing.form}
          isNew={!editing.existing}
          onCancel={() => setEditing(null)}
          onDone={f => {
            setReviewing({ resource: channelResource(f, settings), existing: editing.existing });
            setEditing(null);
          }}
        />
      )}
      {reviewing && (
        <ChangeDialog
          settings={settings}
          kind="NotificationChannel"
          {...reviewing}
          onClose={() => setReviewing(null)}
        />
      )}
    </SectionBox>
  );
}

function RouteEditor(props: {
  settings: Settings;
  initial: RouteForm;
  isNew: boolean;
  channelNames: string[];
  onCancel: () => void;
  onDone: (f: RouteForm) => void;
}) {
  const { isNew, channelNames, onCancel, onDone } = props;
  const [f, setF] = React.useState<RouteForm>(props.initial);
  const problems = validateRoute(f);
  const up = (patch: Partial<RouteForm>) => setF(prev => ({ ...prev, ...patch }));
  return (
    <Dialog open onClose={onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>{isNew ? 'New route' : `Edit route ${f.name}`}</DialogTitle>
      <DialogContent>
        <Box display="flex" flexDirection="column" gap={2} sx={{ pt: 1 }}>
          <TextField
            label="Name"
            size="small"
            value={f.name}
            disabled={!isNew}
            onChange={e => up({ name: e.target.value })}
          />
          <Autocomplete
            multiple
            size="small"
            options={channelNames}
            value={f.channels}
            onChange={(_, v) => up({ channels: v })}
            renderInput={params => <TextField {...params} label="Channels" />}
          />
          <TextField
            label="Match targets (optional)"
            size="small"
            helperText="Comma or newline separated. Empty matches every target."
            value={f.targets.join(', ')}
            onChange={e => up({ targets: parseList(e.target.value) })}
          />
          <Autocomplete
            multiple
            size="small"
            options={[...ROUTE_KINDS]}
            value={f.kinds}
            onChange={(_, v) => up({ kinds: v as RouteForm['kinds'] })}
            renderInput={params => (
              <TextField
                {...params}
                label="Match kinds (optional)"
                helperText="Empty matches every kind."
              />
            )}
          />
          <FormControlLabel
            control={
              <Switch
                checked={f.quietEnabled}
                onChange={e => up({ quietEnabled: e.target.checked })}
              />
            }
            label="Quiet hours"
          />
          {f.quietEnabled && (
            <Box display="flex" flexDirection="column" gap={2}>
              <Box display="flex" gap={1}>
                <TextField
                  label="Start (HH:MM)"
                  size="small"
                  value={f.quietStart}
                  onChange={e => up({ quietStart: e.target.value })}
                />
                <TextField
                  label="End (HH:MM)"
                  size="small"
                  value={f.quietEnd}
                  onChange={e => up({ quietEnd: e.target.value })}
                />
                <TextField
                  label="Timezone"
                  size="small"
                  value={f.quietTimezone}
                  onChange={e => up({ quietTimezone: e.target.value })}
                />
              </Box>
              <FormControlLabel
                control={
                  <Switch
                    checked={f.quietAllowUrgent}
                    onChange={e => up({ quietAllowUrgent: e.target.checked })}
                  />
                }
                label="Allow urgent notifications during quiet hours"
              />
            </Box>
          )}
          {problems.length > 0 && (
            <Alert severity="warning">
              {problems.map(p => (
                <div key={p}>{p}</div>
              ))}
            </Alert>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="contained" disabled={problems.length > 0} onClick={() => onDone(f)}>
          Review change
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function RoutesPage() {
  const settings = useSettings();
  const list = useResources('AlertRoute', settings);
  const channels = useResources('NotificationChannel', settings);
  const [editing, setEditing] = React.useState<{ form: RouteForm; existing: any | null } | null>(
    null
  );
  const [reviewing, setReviewing] = React.useState<{ resource: any; existing: any | null } | null>(
    null
  );
  const [notice, setNotice] = React.useState<string | null>(null);
  const channelNames = React.useMemo(
    () => channels.items.map(c => c.metadata.name as string).sort(),
    [channels.items]
  );
  return (
    <SectionBox
      title="Alert routes"
      headerProps={{
        actions: [
          <Button
            key="new"
            variant="contained"
            onClick={() => setEditing({ form: emptyRoute(), existing: null })}
          >
            New route
          </Button>,
        ],
      }}
    >
      {notice && (
        <Alert severity="info" sx={{ mb: 1 }} onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {list.absent || list.error ? (
        <Missing settings={settings} error={list.error} />
      ) : (
        <Table
          loading={list.loading}
          data={list.items}
          columns={[
            { header: 'Name', accessorFn: (r: any) => r.metadata.name },
            { header: 'Channels', accessorFn: (r: any) => (r.spec?.channels || []).join(', ') },
            {
              header: 'Targets',
              accessorFn: (r: any) => (r.spec?.match?.targets || []).join(', ') || 'all',
            },
            {
              header: 'Kinds',
              accessorFn: (r: any) => (r.spec?.match?.kinds || []).join(', ') || 'all',
            },
            {
              header: 'Quiet hours',
              accessorFn: (r: any) => {
                const q = r.spec?.quietHours;
                return q
                  ? `${q.start}-${q.end} ${q.timezone}${q.allowUrgent ? ' (urgent allowed)' : ''}`
                  : '';
              },
            },
            {
              header: 'Actions',
              id: 'actions',
              enableSorting: false,
              Cell: ({ row }: any) => (
                <Box display="flex" gap={1}>
                  <Button
                    size="small"
                    onClick={() =>
                      setEditing({ form: routeFromResource(row.original), existing: row.original })
                    }
                  >
                    Edit
                  </Button>
                  {
                    <Button
                      size="small"
                      color="error"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete route ${row.original.metadata.name} from the cluster?`
                          )
                        )
                          deleteLive(settings, 'AlertRoute', row.original.metadata.name).catch(e =>
                            setNotice(String(e?.message || e))
                          );
                      }}
                    >
                      Delete
                    </Button>
                  }
                </Box>
              ),
            },
          ]}
        />
      )}
      {editing && (
        <RouteEditor
          settings={settings}
          initial={editing.form}
          isNew={!editing.existing}
          channelNames={channelNames}
          onCancel={() => setEditing(null)}
          onDone={f => {
            setReviewing({ resource: routeResource(f, settings), existing: editing.existing });
            setEditing(null);
          }}
        />
      )}
      {reviewing && (
        <ChangeDialog
          settings={settings}
          kind="AlertRoute"
          {...reviewing}
          onClose={() => setReviewing(null)}
        />
      )}
    </SectionBox>
  );
}

export function StatusPage() {
  const settings = useSettings();
  const state = useStateApi(settings.stateApiUrl);
  if (!settings.stateApiUrl) {
    return (
      <SectionBox title="Status">
        <Alert severity="info">
          No state API URL is configured. Set one in the plugin settings to see target status.
        </Alert>
      </SectionBox>
    );
  }
  return (
    <SectionBox title="Status">
      {state.error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {state.error}
        </Alert>
      )}
      <Table
        loading={state.loading}
        data={state.targets}
        columns={[
          { header: 'Target', accessorFn: (t: any) => t.name },
          { header: 'Kind', accessorFn: (t: any) => t.kind || '' },
          {
            header: 'State',
            accessorFn: (t: any) => t.state,
            Cell: ({ row }: any) => (
              <StatusLabel status={stateSeverity(row.original.state)}>
                {row.original.state}
              </StatusLabel>
            ),
          },
          { header: 'Since', accessorFn: (t: any) => t.since || '' },
          { header: 'Detail', accessorFn: (t: any) => t.detail || '' },
          {
            header: 'Recent episodes',
            id: 'episodes',
            enableSorting: false,
            Cell: ({ row }: any) =>
              row.original.episodes.length === 0 ? (
                <Typography variant="caption">None</Typography>
              ) : (
                <Box>
                  {row.original.episodes.slice(0, 5).map((e: any, i: number) => (
                    <Typography key={i} variant="caption" component="div">
                      {[e.start, e.end ? `to ${e.end}` : 'ongoing', e.state, e.detail]
                        .filter(Boolean)
                        .join(' ')}
                    </Typography>
                  ))}
                </Box>
              ),
          },
        ]}
      />
    </SectionBox>
  );
}
