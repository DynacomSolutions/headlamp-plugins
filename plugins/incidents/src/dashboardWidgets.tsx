/*
 * Widgets that the Incidents plugin adds to the Dashboards plugin, through the cross-plugin
 * `window.headlampDashboards` contract (see dashboardsContract.ts):
 *   incidents.list  The incident summary (counts by severity and status) stays at the top. The
 *                   diagnoses list below it scrolls on its own. A row selects the incident for the
 *                   chat widget when the dashboard has one. Otherwise it opens the incident page.
 *   incidents.chat  The incident agent chat. It talks about the incident that the list widget
 *                   selected, or about the cluster in general when nothing is selected.
 * Both reuse the code of the Incidents pages (DiagnosesTable, ChatPage parts, chat-data). They
 * fetch when the dashboard refresh signal changes, never on a layout change. The chat also polls
 * its own chat once a second while the agent answers, as the chat page does.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  cancelChat,
  createChat,
  sendMessage,
  useChat,
  useFavourites,
  useModels,
} from './chat-data';
import { cleanErrorText } from './chat-model';
import { Composer, EXAMPLE_PROMPTS, MessageView, useStickToBottom } from './ChatPage';
import { registerDashboardWidget, WidgetDefinition, WidgetProps } from './dashboardsContract';
import { fetchAllDiagnoses, rerunDiagnosis, useSettings } from './data';
import { IncidentHero } from './IncidentHero';
import { IncidentRows } from './IncidentRows';
import {
  backendUrl,
  DEFAULT_FILTER,
  DiagnosisSummary,
  filterDiagnoses,
  IncidentFilter,
  Settings,
  summariseDiagnoses,
} from './model';
import { ModelPicker } from './ModelPicker';
import {
  getSelectedIncident,
  registerChatWidget,
  selectIncident,
  useHasChatWidget,
  useSelectedIncident,
} from './selection';

/** A scroll area that scrolls by touch with no visible scrollbar in the kiosk. */
const scrollSx = (kiosk: boolean) => ({
  overflowY: 'auto' as const,
  overscrollBehavior: 'contain' as const,
  touchAction: 'pan-y' as const,
  ...(kiosk ? { scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } } : {}),
});

/* ---------- incidents.list ---------- */

export type IncidentListConfig = IncidentFilter;

interface Fetched {
  rows: DiagnosisSummary[] | null;
  error: string | null;
}

/**
 * The diagnoses. Fetches when the settings or the refresh signal change, never on its own timer.
 * The last good data stays on screen when a refresh fails.
 */
export function useDiagnosesOnSignal(
  settings: Settings,
  refreshSignal: number,
  reportRefreshed: (at?: number) => void,
  /** A number that the widget raises to fetch again now (after a re-run). */
  reload = 0
): Fetched & { loading: boolean } {
  const [state, setState] = React.useState<Fetched>({ rows: null, error: null });
  // A string key, so a new but equal settings object does not fetch again.
  const key = backendUrl(settings, '/api/diagnoses');
  React.useEffect(() => {
    let live = true;
    fetchAllDiagnoses(settings).then(
      rows => {
        if (!live) return;
        setState({ rows, error: null });
        reportRefreshed(Date.now());
      },
      (e: unknown) => live && setState(prev => ({ rows: prev.rows, error: cleanErrorText(e) }))
    );
    return () => {
      live = false;
    };
    // `key` covers every field of the settings that the request uses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshSignal, reportRefreshed, reload]);
  return { ...state, loading: state.rows === null && state.error === null };
}

function IncidentListWidget({
  config,
  refreshSignal,
  reportRefreshed,
  editing,
  kiosk,
}: WidgetProps<IncidentListConfig>): JSX.Element {
  const settings = useSettings();
  const [reload, setReload] = React.useState(0);
  const state = useDiagnosesOnSignal(settings, refreshSignal, reportRefreshed, reload);
  const rerun = React.useCallback(
    async (d: DiagnosisSummary) => {
      await rerunDiagnosis(settings, d.id);
      // The agent has queued the run. Fetch the rows again, so this row shows it.
      setReload(n => n + 1);
    },
    [settings]
  );
  const selected = useSelectedIncident();
  const hasChat = useHasChatWidget();
  // The selection belongs to the list on screen: clear it when the list goes away.
  React.useEffect(() => () => selectIncident(null), []);
  const rows = React.useMemo(() => filterDiagnoses(state.rows ?? [], config), [state.rows, config]);
  const counts = React.useMemo(() => summariseDiagnoses(rows), [rows]);
  const onSelect = React.useCallback((d: DiagnosisSummary) => {
    selectIncident(
      getSelectedIncident()?.id === d.id ? null : { id: d.id, alertName: d.alertName || d.id }
    );
  }, []);
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <Box sx={{ flex: 'none' }}>
        <IncidentHero counts={counts} />
        {state.error && (
          <Alert severity={state.rows ? 'warning' : 'error'} sx={{ mt: 1 }}>
            {state.rows
              ? `Refresh failed, showing the last data: ${state.error}`
              : `Could not load diagnoses: ${state.error}`}
          </Alert>
        )}
      </Box>
      <Box data-incident-list-scroll sx={{ flex: '1 1 0', minHeight: 0, ...scrollSx(kiosk) }}>
        {state.loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
            <CircularProgress size={24} aria-label="Loading" />
          </Box>
        ) : state.rows && rows.length === 0 ? (
          <Typography sx={{ p: 2 }} color="text.secondary">
            {state.rows.length === 0
              ? 'No diagnoses yet.'
              : 'No diagnoses match the filters of this widget.'}
          </Typography>
        ) : (
          <IncidentRows
            rows={rows}
            touch={kiosk}
            selectedId={selected?.id ?? null}
            onSelect={hasChat ? onSelect : undefined}
            disableNavigation={editing}
            onRerun={editing ? undefined : rerun}
          />
        )}
      </Box>
    </Box>
  );
}

export const incidentListWidget: WidgetDefinition<IncidentListConfig> = {
  type: 'incidents.list',
  title: 'Incidents',
  description:
    'The incident diagnoses, with a summary by severity and status that stays at the top.',
  icon: 'mdi:alert-circle-outline',
  category: 'Monitoring',
  defaultSize: { w: 6, h: 14 },
  minSize: { w: 3, h: 6 },
  defaultConfig: { ...DEFAULT_FILTER },
  configSchema: [
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'all', label: 'All' },
        { value: 'queued', label: 'Queued' },
        { value: 'running', label: 'Running' },
        { value: 'done', label: 'Done' },
        { value: 'failed', label: 'Failed' },
      ],
    },
    {
      key: 'severity',
      label: 'Severity',
      type: 'select',
      options: [
        { value: 'all', label: 'All' },
        { value: 'critical', label: 'Critical' },
        { value: 'warning', label: 'Warning' },
        { value: 'other', label: 'Other' },
      ],
    },
    {
      key: 'openOnly',
      label: 'Hide resolved',
      type: 'boolean',
      help: 'Shows only the diagnoses whose alert is still firing.',
    },
  ],
  Component: IncidentListWidget,
};

/* ---------- incidents.chat ---------- */

export type IncidentChatConfig = Record<string, never>;

const INCIDENT_PROMPTS = [
  'Why did this alert fire?',
  'What should I check first?',
  'Is this still happening?',
];

function IncidentChatWidget({
  refreshSignal,
  reportRefreshed,
  kiosk,
}: WidgetProps<IncidentChatConfig>): JSX.Element {
  const settings = useSettings();
  const selected = useSelectedIncident();
  React.useEffect(() => registerChatWidget(), []);
  // One chat per context: the selected incident, or '' for the cluster in general.
  const ctxKey = selected?.id ?? '';
  const [chatIds, setChatIds] = React.useState<Record<string, string>>({});
  const chatId: string | undefined = chatIds[ctxKey];
  const models = useModels(settings);
  const chat = useChat(settings, chatId);
  const [favourites, toggleFavourite] = useFavourites();
  const [picked, setPicked] = React.useState<string | null>(null);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const messages = chat.data?.messages ?? [];
  const running = !!chat.data?.running;
  const model = picked ?? chat.data?.model ?? models.data?.default ?? '';
  const scroll = useStickToBottom(messages);

  // Fetch again when the dashboard asks for it, never on the first render.
  const lastSignal = React.useRef(refreshSignal);
  const refreshModels = models.refresh;
  const refreshChat = chat.refresh;
  React.useEffect(() => {
    if (lastSignal.current === refreshSignal) return;
    lastSignal.current = refreshSignal;
    refreshModels();
    refreshChat();
  }, [refreshSignal, refreshModels, refreshChat]);
  React.useEffect(() => {
    if (models.data) reportRefreshed(Date.now());
  }, [models.data, reportRefreshed]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setSendError(null);
    try {
      await work();
    } catch (e) {
      setSendError(cleanErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const onSend = (text: string) =>
    run(async () => {
      if (!chatId) {
        const key = ctxKey;
        const newId = await createChat(settings, {
          ...(model ? { model } : {}),
          ...(selected ? { diagnosisId: selected.id } : {}),
        });
        try {
          await sendMessage(settings, newId, text);
        } finally {
          // Opened after the message was sent, so the first read already shows the running turn.
          setChatIds(ids => ({ ...ids, [key]: newId }));
        }
        return;
      }
      await sendMessage(
        settings,
        chatId,
        text,
        picked && picked !== chat.data?.model ? picked : undefined
      );
      setPicked(null);
      chat.refresh();
    });

  const onStop = () =>
    run(async () => {
      if (chatId) await cancelChat(settings, chatId);
      chat.refresh();
    });

  const prompts = selected ? INCIDENT_PROMPTS : EXAMPLE_PROMPTS;
  const loadError = chat.error || models.error;
  return (
    <Box
      data-incident-chat
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <Box
        sx={theme => ({
          flex: 'none',
          pb: 1,
          minHeight: 28,
          display: 'flex',
          alignItems: 'center',
          borderBottom: `1px solid ${theme.palette.divider}`,
        })}
      >
        {selected ? (
          <Chip
            size="small"
            color="primary"
            variant="outlined"
            label={`About incident: ${selected.alertName}`}
            onDelete={() => selectIncident(null)}
            sx={{ maxWidth: '100%' }}
          />
        ) : (
          <Typography variant="caption" color="text.secondary">
            No incident selected. Select one in the list to ask about it, or ask about the cluster
            in general.
          </Typography>
        )}
      </Box>
      <Box
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        sx={{ flex: '1 1 0', minHeight: 0, ...scrollSx(kiosk), pr: kiosk ? 0 : 0.5 }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minHeight: '100%' }}>
          {chatId && chat.loading && !chat.data && <CircularProgress aria-label="Loading" />}
          {messages.length === 0 && !(chatId && chat.loading) && (
            <Box
              sx={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                justifyContent: 'flex-end',
                textAlign: 'left',
              }}
            >
              <Typography
                variant="subtitle1"
                component="h2"
                color="text.secondary"
                sx={{ fontSize: 13, mb: 1 }}
              >
                {selected
                  ? `Ask the agent about ${selected.alertName}`
                  : 'What do you want to know about the cluster?'}
              </Typography>
              <Box
                sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, justifyContent: 'flex-start' }}
              >
                {prompts.map(p => (
                  <Button
                    key={p}
                    size="small"
                    variant="outlined"
                    color="inherit"
                    disabled={busy}
                    onClick={() => onSend(p)}
                    sx={{ textTransform: 'none', borderRadius: 4, fontSize: 12.5, py: 0.25 }}
                  >
                    {p}
                  </Button>
                ))}
              </Box>
            </Box>
          )}
          {messages.map(m => (
            <MessageView key={m.id} m={m} />
          ))}
        </Box>
      </Box>
      <Box sx={{ flex: 'none', pt: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {loadError && <Alert severity="error">Could not load the chat: {loadError}</Alert>}
        {sendError && (
          <Alert severity="error" onClose={() => setSendError(null)}>
            {sendError}
          </Alert>
        )}
        <Composer
          running={running}
          disabled={busy}
          onSend={onSend}
          onStop={onStop}
          picker={
            <ModelPicker
              models={models.data?.models ?? []}
              value={model}
              onChange={setPicked}
              favourites={favourites}
              onToggleFavourite={toggleFavourite}
              disabled={running}
            />
          }
        />
      </Box>
    </Box>
  );
}

export const incidentChatWidget: WidgetDefinition<IncidentChatConfig> = {
  type: 'incidents.chat',
  title: 'Incident chat',
  description:
    'Chat with the incident agent. It talks about the incident selected in an Incidents widget.',
  icon: 'mdi:chat-processing-outline',
  category: 'Monitoring',
  defaultSize: { w: 6, h: 14 },
  minSize: { w: 3, h: 8 },
  defaultConfig: {},
  Component: IncidentChatWidget,
};

export const INCIDENT_WIDGETS: Array<WidgetDefinition<any>> = [
  incidentListWidget,
  incidentChatWidget,
];

/** Registers the widgets. Safe in any plugin load order (see dashboardsContract.ts). */
export function registerIncidentWidgets(): void {
  for (const w of INCIDENT_WIDGETS) registerDashboardWidget(w);
}

registerIncidentWidgets();
