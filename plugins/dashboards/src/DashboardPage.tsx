/*
 * A dashboard (/dashboards/<name>/<tab>). The URL is the single source of truth for the view:
 * the dashboard and tab are path segments (a tab change is pushed, so Back works), and edit
 * mode, kiosk, filters, the saved view and the refresh override are query params, replaced.
 *
 * Edit mode works on a draft of the spec. Nothing is saved until Save. A save sends the
 * ConfigMap's resourceVersion, so a change made by someone else shows a conflict message and
 * is never overwritten silently.
 */
import { Icon } from '@iconify/react';
import { Loader } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink, Prompt, useHistory, useLocation } from 'react-router-dom';
import { DashboardSettingsDialog } from './components/DashboardSettingsDialog';
import { FilterBar } from './components/FilterBar';
import { PaletteDrawer } from './components/PaletteDrawer';
import { LastRefreshed,RefreshControls } from './components/RefreshStatus';
import { SectionActions, SectionView } from './components/SectionView';
import { TabsActions, TabsDialog } from './components/TabsDialog';
import { FrameActions } from './components/WidgetFrame';
import { WidgetSettingsDialog, WidgetSettingsResult } from './components/WidgetSettingsDialog';
import { DashboardContext, DashboardContextValue } from './context';
import type { DashboardFilters, WidgetDefinition } from './contract';
import { useCanWrite, useClusterNames, useDashboard, useStorage, useWidgetDefinition, useWidgetDefinitions } from './hooks';
import { enterBrowserFullscreen, KioskOverlay } from './kiosk/Kiosk';
import { createRefreshStore } from './refreshStore';
import {
  addSection,
  addTab,
  addWidget,
  applyPositions,
  deleteSection,
  deleteTab,
  deleteView,
  deleteWidget,
  duplicateWidget,
  moveWidgetToTabSection,
  reorderSections,
  reorderTabs,
  saveView,
  updateSection,
  updateTab,
  updateWidget,
} from './spec/edit';
import { DashboardSpec, sameFilters } from './spec/model';
import { ConflictError, StoredDashboard } from './storage/storage';
import { baseFilters, buildPath, parsePath, parseQuery, pathBase, resolveFilters, serialiseQuery } from './urlState';

type SaveState = { saving: boolean; error?: string; conflict: boolean };

export function DashboardPage(): JSX.Element {
  const location = useLocation();
  const { name } = parsePath(location.pathname);
  // A new dashboard name starts with fresh state: draft, dialogs and refresh counter.
  return <DashboardView key={name} name={name} />;
}

function DashboardView({ name }: { name: string }): JSX.Element {
  const history = useHistory();
  const location = useLocation();
  const storage = useStorage();
  const loaded = useDashboard(storage, name);
  const canWrite = useCanWrite(storage.namespace);
  const stored: StoredDashboard | undefined = loaded.data;
  const { tab: tabParam } = parsePath(location.pathname);
  const query = React.useMemo(() => parseQuery(location.search), [location.search]);

  const [draft, setDraft] = React.useState<DashboardSpec | null>(null);
  const [save, setSave] = React.useState<SaveState>({ saving: false, conflict: false });
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [paletteSection, setPaletteSection] = React.useState('');
  const [tabsOpen, setTabsOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [widgetSettings, setWidgetSettings] = React.useState<{ sectionId: string; widgetId: string } | null>(null);
  const [menu, setMenu] = React.useState<{ anchor: HTMLElement; sectionId: string; widgetId: string } | null>(null);

  const refresh = React.useMemo(() => createRefreshStore(), []);
  const signal = React.useSyncExternalStore(refresh.subscribe, () => refresh.getState().signal);
  const definitions = useWidgetDefinitions();
  const namespaceOptions = useClusterNames('/api/v1/namespaces');
  const nodeOptions = useClusterNames('/api/v1/nodes');

  const writable = canWrite !== false && !!stored && !stored.error;
  const editing = query.edit && !query.kiosk && writable;
  const spec: DashboardSpec | undefined = editing && draft ? draft : stored?.spec;
  const dirty = editing && draft !== null && draft !== stored?.spec;

  // The edit callbacks below are stable while the stored spec is, so dragging a widget does not
  // recreate them. They work on the draft, which starts as the stored spec.
  const storedSpec = stored?.spec;
  const edit = React.useCallback(
    (fn: (s: DashboardSpec) => DashboardSpec) => {
      if (!storedSpec) return;
      setDraft(prev => fn(prev ?? storedSpec));
    },
    [storedSpec]
  );

  // ---- URL ----

  const activeTab = spec ? spec.tabs.find(t => t.id === tabParam) ?? spec.tabs[0] : undefined;
  const activeTabId = activeTab?.id ?? '';

  const specFilters = spec?.filters;
  const specViews = spec?.views;
  const urlFilters = React.useMemo(
    () => resolveFilters(baseFilters(specFilters && specViews ? { filters: specFilters, views: specViews } as DashboardSpec : undefined, query.view), query.filters),
    [query.view, query.filters, specFilters, specViews]
  );
  const stableFilters = React.useRef(urlFilters);
  // Keep the previous object when the values are equal, so widgets do not see a new filters prop.
  const filters: DashboardFilters = sameFilters(stableFilters.current, urlFilters) ? stableFilters.current : urlFilters;
  stableFilters.current = filters;

  const replaceQuery = (next: { edit?: boolean; kiosk?: boolean; view?: string; refresh?: number; filters?: DashboardFilters }) => {
    const merged = {
      edit: next.edit ?? query.edit,
      kiosk: next.kiosk ?? query.kiosk,
      view: next.view ?? query.view,
      refresh: 'refresh' in next ? next.refresh : query.refresh,
      filters: next.filters ?? filters,
    };
    const base = baseFilters(spec, merged.view);
    history.replace({ pathname: location.pathname, search: serialiseQuery(merged, base) });
  };

  const base = pathBase(location.pathname);
  const listPath = buildPath({ name: '', tab: '' }, base);
  const goTab = (id: string) => history.push({ pathname: buildPath({ name, tab: id }, base), search: location.search });

  // ---- refresh ----

  const seconds = query.refresh ?? spec?.refreshSeconds ?? 0;
  React.useEffect(() => {
    if (!seconds) return undefined;
    const t = setInterval(() => {
      if (!document.hidden) refresh.trigger();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [seconds, refresh]);

  const onSecondsChange = (s: number) => {
    if (editing) {
      edit(d => ({ ...d, refreshSeconds: s }));
      // The spec now holds the interval, so drop a URL override that would hide it.
      if (query.refresh !== undefined) replaceQuery({ refresh: undefined });
    } else {
      replaceQuery({ refresh: s });
    }
  };

  // ---- saving ----

  const persist = async (next: DashboardSpec, target: StoredDashboard | undefined = stored) => {
    if (!target) return false;
    setSave({ saving: true, conflict: false });
    try {
      const result = await storage.save(target, next);
      loaded.set(result);
      setDraft(null);
      setSave({ saving: false, conflict: false });
      return true;
    } catch (e) {
      setSave({ saving: false, conflict: e instanceof ConflictError, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };

  const reloadLatest = () => {
    setDraft(null);
    setSave({ saving: false, conflict: false });
    loaded.reload();
  };

  /** An explicit choice after a conflict: take the newest version, then save the draft over it. */
  const overwrite = async () => {
    if (!draft) return;
    setSave({ saving: true, conflict: false });
    try {
      const latest = await storage.get(name);
      await persist(draft, latest);
    } catch (e) {
      setSave({ saving: false, conflict: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const setEdit = (on: boolean) => {
    if (!on) setDraft(null);
    replaceQuery({ edit: on });
  };

  const discard = () => {
    setDraft(null);
    setSave({ saving: false, conflict: false });
  };

  React.useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // ---- stable actions for the grid ----

  const frameActions = React.useMemo<FrameActions>(
    () => ({
      menu: (anchor, sectionId, widgetId) => setMenu({ anchor, sectionId, widgetId }),
      settings: (sectionId, widgetId) => setWidgetSettings({ sectionId, widgetId }),
    }),
    []
  );

  const sectionActions = React.useMemo<SectionActions>(
    () => ({
      rename: (id, title) => edit(s => updateSection(s, activeTabId, id, { title })),
      setMode: (id, mode) => edit(s => updateSection(s, activeTabId, id, { mode })),
      setHeight: (id, height) => edit(s => updateSection(s, activeTabId, id, { height: Math.max(120, Math.min(4000, Math.round(height) || 400)) })),
      setShowTitle: (id, showTitle) => edit(s => updateSection(s, activeTabId, id, { showTitle })),
      move: (id, dir) =>
        edit(s => {
          const sections = s.tabs.find(t => t.id === activeTabId)?.sections ?? [];
          const i = sections.findIndex(x => x.id === id);
          return reorderSections(s, activeTabId, i, i + dir);
        }),
      remove: id => edit(s => deleteSection(s, activeTabId, id)),
      positions: (id, positions) => edit(s => applyPositions(s, activeTabId, id, positions)),
      moveWidget: (from, to, widgetId) =>
        edit(s => moveWidgetToTabSection(s, { tabId: activeTabId, sectionId: from }, { tabId: activeTabId, sectionId: to }, widgetId)),
    }),
    [edit, activeTabId]
  );

  const tabsActions = React.useMemo<TabsActions>(
    () => ({
      add: () => edit(s => addTab(s).spec),
      rename: (id, label) => edit(s => updateTab(s, id, { label })),
      setIcon: (id, icon) => edit(s => updateTab(s, id, { icon })),
      move: (from, to) => edit(s => reorderTabs(s, from, to)),
      remove: id => edit(s => deleteTab(s, id)),
      setPosition: tabPosition => edit(s => ({ ...s, tabPosition })),
    }),
    [edit]
  );

  const ctx = React.useMemo<DashboardContextValue>(
    () => ({ filters, refreshSignal: signal, editing, kiosk: query.kiosk, reportRefreshed: refresh.report }),
    [filters, signal, editing, query.kiosk, refresh]
  );

  // ---- render ----

  if (loaded.loading && !stored) return <Loader title="Loading the dashboard" />;
  if (!stored || !spec || !activeTab) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error" action={<Button color="inherit" component={RouterLink} to={listPath}>All dashboards</Button>}>
          {loaded.error?.message ?? 'The dashboard could not be loaded.'}
        </Alert>
      </Box>
    );
  }
  if (stored.error) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error" action={<Button color="inherit" component={RouterLink} to={listPath}>All dashboards</Button>}>
          This dashboard cannot be shown. {stored.error}
        </Alert>
      </Box>
    );
  }

  const sectionsOfTab = activeTab.sections;
  const paletteTarget = sectionsOfTab.some(s => s.id === paletteSection) ? paletteSection : sectionsOfTab[0].id;
  const left = spec.tabPosition === 'left';
  const showTabs = spec.tabs.length > 1 || editing;

  const onAddWidget = (def: WidgetDefinition, sectionId: string) =>
    edit(s => addWidget(s, activeTabId, sectionId, def.type, def.defaultSize, JSON.parse(JSON.stringify(def.defaultConfig))).spec);

  const filterBar = (
    <FilterBar
      filters={filters}
      onChange={f => replaceQuery({ view: '', filters: f })}
      namespaceOptions={namespaceOptions}
      nodeOptions={nodeOptions}
      views={spec.views}
      activeView={query.view}
      onSelectView={id => replaceQuery({ view: id, filters: spec.views.find(v => v.id === id)?.filters ?? filters })}
      onSaveView={
        writable
          ? async viewName => {
              const next = saveView(spec, viewName, filters);
              const id = next.views.find(v => v.name === viewName)?.id ?? '';
              if (await persist(next)) replaceQuery({ view: id, filters: next.views.find(v => v.id === id)?.filters ?? filters });
            }
          : undefined
      }
      onDeleteView={
        writable
          ? async id => {
              if (await persist(deleteView(spec, id)) && query.view === id) replaceQuery({ view: '', filters });
            }
          : undefined
      }
      onReset={() => replaceQuery({ view: '', filters: spec.filters })}
    />
  );

  const tabBar = showTabs && (
    <Box
      sx={{
        flex: 'none',
        borderBottom: left ? 0 : 1,
        borderRight: left ? 1 : 0,
        borderColor: 'divider',
        mb: left ? 0 : 1,
        mr: left ? 1 : 0,
        minWidth: left ? 160 : undefined,
      }}
    >
      <Tabs
        value={activeTab.id}
        orientation={left ? 'vertical' : 'horizontal'}
        variant="scrollable"
        scrollButtons="auto"
        aria-label="Dashboard tabs"
        onChange={(_e, id: string) => goTab(id)}
      >
        {spec.tabs.map(t => (
          <Tab
            key={t.id}
            value={t.id}
            label={t.label}
            icon={<Icon icon={t.icon} width={20} height={20} />}
            iconPosition="start"
            sx={{ minHeight: 48, textTransform: 'none', justifyContent: left ? 'flex-start' : undefined }}
          />
        ))}
      </Tabs>
    </Box>
  );

  const sections = (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      {sectionsOfTab.map((section, i) => (
        <SectionView
          key={section.id}
          section={section}
          index={i}
          count={sectionsOfTab.length}
          editing={editing}
          kiosk={query.kiosk}
          frameActions={frameActions}
          actions={sectionActions}
        />
      ))}
    </Box>
  );

  const content = (
    <DashboardContext.Provider value={ctx}>
      <Box sx={{ display: 'flex', flexDirection: left ? 'row' : 'column', alignItems: 'stretch' }}>
        {tabBar}
        {sections}
      </Box>
    </DashboardContext.Provider>
  );

  const dialogs = (
    <>
      <Prompt when={dirty} message="You have unsaved changes to this dashboard. Leave without saving?" />
      <PaletteDrawer
        open={editing && paletteOpen}
        onClose={() => setPaletteOpen(false)}
        definitions={definitions}
        sections={sectionsOfTab.map(s => ({ id: s.id, title: s.title }))}
        sectionId={paletteTarget}
        onSectionChange={setPaletteSection}
        onAdd={onAddWidget}
      />
      {editing && tabsOpen && <TabsDialog spec={spec} actions={tabsActions} onClose={() => setTabsOpen(false)} />}
      {editing && settingsOpen && (
        <DashboardSettingsDialog
          title={spec.title}
          description={spec.description}
          onCancel={() => setSettingsOpen(false)}
          onApply={(title, description) => {
            edit(s => ({ ...s, title, description }));
            setSettingsOpen(false);
          }}
        />
      )}
      {editing && widgetSettings && (
        <WidgetSettingsHost
          spec={spec}
          tabId={activeTabId}
          target={widgetSettings}
          onCancel={() => setWidgetSettings(null)}
          onApply={r => {
            edit(s => updateWidget(s, activeTabId, widgetSettings.sectionId, widgetSettings.widgetId, r));
            setWidgetSettings(null);
          }}
        />
      )}
      <Menu anchorEl={menu?.anchor} open={!!menu && editing} onClose={() => setMenu(null)}>
        {menu &&
          widgetMenuItems({
            spec,
            tabId: activeTabId,
            target: menu,
            close: () => setMenu(null),
            onSettings: () => setWidgetSettings({ sectionId: menu.sectionId, widgetId: menu.widgetId }),
            onDuplicate: () => edit(s => duplicateWidget(s, activeTabId, menu.sectionId, menu.widgetId).spec),
            onDelete: () => edit(s => deleteWidget(s, activeTabId, menu.sectionId, menu.widgetId)),
            onMove: to => edit(s => moveWidgetToTabSection(s, { tabId: activeTabId, sectionId: menu.sectionId }, to, menu.widgetId)),
          })}
      </Menu>
    </>
  );

  if (query.kiosk) {
    return (
      <KioskOverlay
        onExit={() => replaceQuery({ kiosk: false })}
        bar={
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5 }}>
            <Typography variant="h6" component="h1" sx={{ mr: 1 }}>
              {spec.title}
            </Typography>
            <LastRefreshed store={refresh} />
            <IconButton aria-label="Refresh now" onClick={() => refresh.trigger()}>
              <Icon icon="mdi:refresh" width={26} height={26} />
            </IconButton>
            {filterBar}
          </Box>
        }
      >
        <Box
          data-kiosk-scroll
          sx={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }}
        >
          {content}
        </Box>
      </KioskOverlay>
    );
  }

  return (
    <Box sx={{ p: 2 }}>
      {dialogs}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 1 }}>
        <Box sx={{ flex: 1, minWidth: 200 }}>
          <Typography variant="h5" component="h1">
            {spec.title}
          </Typography>
          {spec.description && (
            <Typography variant="body2" color="text.secondary">
              {spec.description}
            </Typography>
          )}
        </Box>
        <RefreshControls store={refresh} seconds={seconds} onSecondsChange={onSecondsChange} />
        <Tooltip title="Full screen">
          <IconButton
            aria-label="Full screen"
            onClick={() => {
              enterBrowserFullscreen();
              replaceQuery({ kiosk: true, edit: false });
            }}
          >
            <Icon icon="mdi:fullscreen" width={22} height={22} />
          </IconButton>
        </Tooltip>
        {!editing && (
          <Tooltip title={writable ? 'Edit this dashboard' : 'You have read-only access to dashboards here'}>
            <span>
              <Button variant="outlined" disabled={!writable} startIcon={<Icon icon="mdi:pencil-outline" width={18} height={18} />} onClick={() => setEdit(true)}>
                Edit
              </Button>
            </span>
          </Tooltip>
        )}
      </Box>
      {canWrite === false && (
        <Alert severity="info" sx={{ mb: 1 }}>
          You have read-only access to dashboards in the namespace "{storage.namespace}". You can view them but not change them.
        </Alert>
      )}
      {stored.migrated && !editing && (
        <Alert severity="info" sx={{ mb: 1 }}>
          This dashboard was saved with an older format. It is upgraded when you save it.
        </Alert>
      )}
      {editing && (
        <Box
          role="toolbar"
          aria-label="Edit tools"
          sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 1, p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}
        >
          <Button size="small" variant="contained" startIcon={<Icon icon="mdi:plus" width={18} height={18} />} onClick={() => setPaletteOpen(true)}>
            Add widget
          </Button>
          <Button size="small" startIcon={<Icon icon="mdi:view-agenda" width={18} height={18} />} onClick={() => edit(s => addSection(s, activeTabId, 'New section'))}>
            Add section
          </Button>
          <Button size="small" startIcon={<Icon icon="mdi:view-grid-outline" width={18} height={18} />} onClick={() => setTabsOpen(true)}>
            Tabs
          </Button>
          <Button size="small" startIcon={<Icon icon="mdi:cog-outline" width={18} height={18} />} onClick={() => setSettingsOpen(true)}>
            Dashboard settings
          </Button>
          <Box sx={{ flex: 1 }} />
          {dirty && (
            <Typography variant="caption" color="warning.main" role="status">
              Unsaved changes
            </Typography>
          )}
          <Button size="small" onClick={() => (dirty && !window.confirm('Discard your changes?') ? undefined : setEdit(false))}>
            {dirty ? 'Discard and close' : 'Close'}
          </Button>
          <Button size="small" disabled={!dirty || save.saving} onClick={discard}>
            Revert
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={!dirty || save.saving}
            onClick={async () => {
              if (draft && (await persist(draft))) setEdit(false);
            }}
          >
            {save.saving ? 'Saving…' : 'Save'}
          </Button>
        </Box>
      )}
      {save.conflict && (
        <Alert
          severity="warning"
          sx={{ mb: 1 }}
          action={
            <>
              <Button color="inherit" size="small" onClick={reloadLatest}>
                Reload and discard my changes
              </Button>
              <Button color="inherit" size="small" onClick={overwrite}>
                Overwrite with my changes
              </Button>
            </>
          }
        >
          {save.error}
        </Alert>
      )}
      {save.error && !save.conflict && (
        <Alert severity="error" sx={{ mb: 1 }} onClose={() => setSave(s => ({ ...s, error: undefined }))}>
          {save.error}
        </Alert>
      )}
      <Box sx={{ mb: 1.5 }}>{filterBar}</Box>
      {content}
    </Box>
  );
}

function WidgetSettingsHost(props: {
  spec: DashboardSpec;
  tabId: string;
  target: { sectionId: string; widgetId: string };
  onCancel: () => void;
  onApply: (r: WidgetSettingsResult) => void;
}): JSX.Element | null {
  const { spec, tabId, target } = props;
  const widget = spec.tabs.find(t => t.id === tabId)?.sections.find(s => s.id === target.sectionId)?.widgets.find(w => w.id === target.widgetId);
  const def = useWidgetDefinition(widget?.type ?? '');
  if (!widget) return null;
  return <WidgetSettingsDialog key={widget.id} widget={widget} def={def} onCancel={props.onCancel} onApply={props.onApply} />;
}

/** An array, not a component: a MUI Menu does not take a Fragment as a child. */
function widgetMenuItems(props: {
  spec: DashboardSpec;
  tabId: string;
  target: { sectionId: string; widgetId: string };
  close: () => void;
  onSettings: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (to: { tabId: string; sectionId: string }) => void;
}): JSX.Element[] {
  const { spec, tabId, target, close } = props;
  const destinations = spec.tabs.flatMap(t =>
    t.sections
      .filter(s => !(t.id === tabId && s.id === target.sectionId))
      .map(s => ({ tabId: t.id, sectionId: s.id, label: spec.tabs.length > 1 ? `${t.label} / ${s.title || 'Untitled'}` : s.title || 'Untitled' }))
  );
  const run = (fn: () => void) => () => {
    fn();
    close();
  };
  return [
    <MenuItem key="settings" onClick={run(props.onSettings)}>
      Settings
    </MenuItem>,
    <MenuItem key="duplicate" onClick={run(props.onDuplicate)}>
      Duplicate
    </MenuItem>,
    ...destinations.map(d => (
      <MenuItem key={`${d.tabId}/${d.sectionId}`} onClick={run(() => props.onMove(d))}>
        Move to {d.label}
      </MenuItem>
    )),
    <MenuItem key="delete" onClick={run(props.onDelete)}>
      Delete
    </MenuItem>,
  ];
}
