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
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Prompt, useHistory, useLocation } from 'react-router-dom';
import { writeCachedDashboard } from './cache/dashboardCache';
import { lastGoodStore } from './cache/lastGood';
import { BandActions, BandView } from './components/BandView';
import { ConnectionIndicator } from './components/ConnectionIndicator';
import { DashboardSettingsDialog } from './components/DashboardSettingsDialog';
import { FilterBar } from './components/FilterBar';
import { HeaderIconButton } from './components/HeaderIconButton';
import { HeaderPart, HeaderStrip } from './components/HeaderStrip';
import { PaletteDrawer } from './components/PaletteDrawer';
import { RefreshControls } from './components/RefreshStatus';
import { SectionActions, SectionView } from './components/SectionView';
import { TabBadge } from './components/TabBadge';
import { TabsActions, TabsDialog } from './components/TabsDialog';
import { FrameActions } from './components/WidgetFrame';
import { WidgetSettingsDialog, WidgetSettingsResult } from './components/WidgetSettingsDialog';
import { DashboardContext, DashboardContextValue } from './context';
import type { DashboardFilters, WidgetDefinition } from './contract';
import { scalableRows, useFillRowHeight } from './fillHeight';
import {
  isTransientError,
  useAfterFirstData,
  useCanWrite,
  useClusterNames,
  useDashboard,
  useSpecWatch,
  useStorage,
  useWidgetDefinition,
  useWidgetDefinitions,
} from './hooks';
import { removeBootCover } from './kiosk/bootCover';
import { enterBrowserFullscreen, KioskExitButton, KioskFrame, KioskOverlay } from './kiosk/Kiosk';
import { useScrollMemory } from './kiosk/scrollMemory';
import { LinkContext } from './links';
import { createRefreshStore } from './refreshStore';
import { useConnection } from './resilience/useConnection';
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
  sectionsOf,
  updateBand,
  updateSection,
  updateTab,
  updateWidget,
} from './spec/edit';
import {
  BandKey,
  baseWidgetType,
  DashboardSpec,
  FOOTER_ID,
  HEADER_ID,
  isBandId,
  sameFilters,
  tabFitsHeight,
} from './spec/model';
import { ConflictError, StoredDashboard } from './storage/storage';
import {
  baseFilters,
  buildPath,
  parseFocus,
  parsePath,
  parseQuery,
  pathBase,
  resolveFilters,
  serialiseQuery,
} from './urlState';
import { TAB_AREA_TOUCH, useTabSwipe } from './useTabSwipe';
import { ensureClusterSources } from './widgets/panels/clusterSources';
import { transportFor } from './widgets/panels/sourcesConfig';

/** The tab id the edit operations use for a section: the header and the footer have their own. */
const tabOf = (sectionId: string, activeTabId: string): string =>
  isBandId(sectionId) ? sectionId : activeTabId;

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
  // Starts the link probe and the chunk error listeners for this page (see resilience/connection.ts).
  const link = useConnection();
  const stored: StoredDashboard | undefined = loaded.data;
  const { tab: tabParam } = parsePath(location.pathname);
  const query = React.useMemo(() => parseQuery(location.search), [location.search]);

  const [draft, setDraft] = React.useState<DashboardSpec | null>(null);
  const [save, setSave] = React.useState<SaveState>({ saving: false, conflict: false });
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [paletteSection, setPaletteSection] = React.useState('');
  const [tabsOpen, setTabsOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [widgetSettings, setWidgetSettings] = React.useState<{
    sectionId: string;
    widgetId: string;
  } | null>(null);
  const [menu, setMenu] = React.useState<{
    anchor: HTMLElement;
    sectionId: string;
    widgetId: string;
  } | null>(null);

  // The latest draft and the running save, for the callbacks that must not see an old value.
  const draftRef = React.useRef<DashboardSpec | null>(null);
  draftRef.current = draft;
  const savingRef = React.useRef(false);
  // True when the last save was of the draft that is on screen now (nothing was edited since).
  const savedDraftRef = React.useRef(false);
  // How to build the spec for "Overwrite" after a conflict: from the newest stored spec.
  const retryRef = React.useRef<((latest: DashboardSpec) => DashboardSpec) | null>(null);

  const refresh = React.useMemo(() => createRefreshStore(), []);
  const signal = React.useSyncExternalStore(refresh.subscribe, () => refresh.getState().signal);
  // A long-open page (a kiosk) keeps the shared cluster sources up to date. This asks only when the cache is old.
  React.useEffect(() => {
    ensureClusterSources(transportFor(undefined), undefined, storage.namespace);
  }, [signal, storage.namespace]);
  // When the server answers again after an outage, fetch fresh data at once, without waiting for each widget's retry.
  const wasOnline = React.useRef(true);
  React.useEffect(() => {
    if (link.online && !wasOnline.current) refresh.trigger();
    wasOnline.current = link.online;
  }, [link.online, refresh]);
  const definitions = useWidgetDefinitions();
  // The pick lists are for the filter fields. A kiosk without filter fields does not ask for them, and
  // any page asks after its widgets have data.
  const afterData = useAfterFirstData(refresh);
  const filtersShown = !query.kiosk || !!stored?.spec.kioskShowFilters;
  const namespaceOptions = useClusterNames('/api/v1/namespaces', afterData && filtersShown);
  const nodeOptions = useClusterNames('/api/v1/nodes', afterData && filtersShown);

  // A spec from the browser cache has no resourceVersion: the page saves only after the cluster answered.
  const writable = canWrite !== false && !!stored && !stored.error && !loaded.fromCache;
  const editing = query.edit && !query.kiosk && writable;
  const spec: DashboardSpec | undefined = editing && draft ? draft : stored?.spec;
  const dirty = editing && draft !== null && draft !== stored?.spec;
  // Each refresh tick reads the saved spec again. A change shows in place. Unsaved edits are never replaced.
  const specWatch = useSpecWatch(storage, name, loaded, signal, dirty || save.saving);

  // The edit callbacks below are stable while the stored spec is, so dragging a widget does not
  // recreate them. They work on the draft, which starts as the stored spec.
  const storedSpec = stored?.spec;
  const edit = React.useCallback(
    (fn: (s: DashboardSpec) => DashboardSpec) => {
      // The grid is read-only while a save runs, so the saved spec and the draft stay in step.
      if (!storedSpec || savingRef.current) return;
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
    () =>
      resolveFilters(
        baseFilters(
          specFilters && specViews
            ? ({ filters: specFilters, views: specViews } as DashboardSpec)
            : undefined,
          query.view
        ),
        query.filters
      ),
    [query.view, query.filters, specFilters, specViews]
  );
  const stableFilters = React.useRef(urlFilters);
  // Keep the previous object when the values are equal, so widgets do not see a new filters prop.
  const filters: DashboardFilters = sameFilters(stableFilters.current, urlFilters)
    ? stableFilters.current
    : urlFilters;
  stableFilters.current = filters;

  const replaceQuery = (next: {
    edit?: boolean;
    kiosk?: boolean;
    view?: string;
    refresh?: number;
    filters?: DashboardFilters;
  }) => {
    const merged = {
      edit: next.edit ?? query.edit,
      kiosk: next.kiosk ?? query.kiosk,
      view: next.view ?? query.view,
      refresh: 'refresh' in next ? next.refresh : query.refresh,
      filters: next.filters ?? filters,
    };
    const base = baseFilters(spec, merged.view);
    history.replace({
      pathname: location.pathname,
      // `keep` carries the `w.<widget id>` params, which belong to the widgets.
      search: serialiseQuery(merged, base, location.search),
    });
  };

  const base = pathBase(location.pathname);
  const listPath = buildPath({ name: '', tab: '' }, base);
  // Each tab change is a history push, so Back returns to the tab before. The query stays.
  const goTab = (id: string) =>
    history.push({ pathname: buildPath({ name, tab: id }, base), search: location.search });
  // What a widget focuses on (a selected incident) is in the path after the tab. A change is a
  // history push, so Back undoes it. A tab change drops it.
  const focusKey = parseFocus(location.pathname).join('/');
  const focus = React.useMemo(() => parseFocus(location.pathname), [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const pathname = location.pathname;
  const search = location.search;
  const setFocus = React.useCallback(
    (segments: string[] | null) => {
      const next = (segments ?? []).filter(Boolean);
      // Without a tab id (the dashboard has not loaded) the path cannot carry a focus.
      if (next.join('/') === focusKey || (next.length > 0 && !activeTabId)) return;
      history.push({
        pathname: buildPath({ name, tab: activeTabId, focus: next }, pathBase(pathname)),
        search,
      });
    },
    [history, name, activeTabId, focusKey, pathname, search]
  );
  const tabIds = React.useMemo(() => spec?.tabs.map(t => t.id) ?? [], [spec?.tabs]);
  const linkTargets = React.useMemo(
    () => ({ base, dashboard: name, tabs: tabIds }),
    [base, name, tabIds]
  );
  const activeIndex = Math.max(0, tabIds.indexOf(tabParam));
  const [swipeArea, setSwipeArea] = React.useState<HTMLElement | null>(null);
  useTabSwipe(swipeArea, {
    enabled: !editing && tabIds.length > 1,
    canStep: step => tabIds[activeIndex + step] !== undefined,
    onStep: step => {
      const next = tabIds[activeIndex + step];
      if (next !== undefined) goTab(next);
    },
  });

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

  /**
   * Save the spec that `build` makes from `base` (the stored spec, or the newest one after a
   * conflict). The draft is cleared only when it is still the object that was saved, so an edit
   * made while the save runs stays on screen.
   */
  const persist = async (
    build: (base: DashboardSpec) => DashboardSpec,
    target: StoredDashboard | undefined = stored
  ) => {
    if (!target) return false;
    const next = build(target.spec);
    savingRef.current = true;
    retryRef.current = build;
    setSave({ saving: true, conflict: false });
    try {
      const result = await storage.save(target, next);
      loaded.set(result);
      writeCachedDashboard(lastGoodStore(), result);
      savedDraftRef.current = draftRef.current === next;
      setDraft(d => (d === next ? null : d));
      retryRef.current = null;
      setSave({ saving: false, conflict: false });
      return true;
    } catch (e) {
      setSave({
        saving: false,
        conflict: e instanceof ConflictError,
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    } finally {
      savingRef.current = false;
    }
  };

  /** Save the whole draft. */
  const saveDraft = (d: DashboardSpec) => persist(() => draftRef.current ?? d);

  const reloadLatest = () => {
    setDraft(null);
    retryRef.current = null;
    setSave({ saving: false, conflict: false });
    loaded.reload();
  };

  /** An explicit choice after a conflict: take the newest version, then save my change over it. */
  const overwrite = async () => {
    const build = retryRef.current;
    if (!build) return;
    setSave({ saving: true, conflict: false });
    try {
      const latest = await storage.get(name);
      await persist(build, latest);
    } catch (e) {
      setSave({
        saving: false,
        conflict: false,
        error: e instanceof Error ? e.message : String(e),
      });
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

  // One set of section actions for the tab sections, and one for each of the header and the footer.
  const makeSectionActions = React.useCallback(
    (tabId: string): SectionActions => ({
      rename: (id, title) => edit(s => updateSection(s, tabId, id, { title })),
      setMode: (id, mode) => edit(s => updateSection(s, tabId, id, { mode })),
      setHeight: (id, height) =>
        edit(s =>
          updateSection(s, tabId, id, {
            height: Math.max(120, Math.min(4000, Math.round(height) || 400)),
          })
        ),
      setShowTitle: (id, showTitle) => edit(s => updateSection(s, tabId, id, { showTitle })),
      move: (id, dir) =>
        edit(s => {
          const sections = sectionsOf(s, tabId);
          const i = sections.findIndex(x => x.id === id);
          return reorderSections(s, tabId, i, i + dir);
        }),
      remove: id => edit(s => deleteSection(s, tabId, id)),
      positions: (id, positions) => edit(s => applyPositions(s, tabId, id, positions)),
      moveWidget: (from, to, widgetId) =>
        edit(s =>
          moveWidgetToTabSection(
            s,
            { tabId: tabOf(from, activeTabId), sectionId: from },
            { tabId: tabOf(to, activeTabId), sectionId: to },
            widgetId
          )
        ),
    }),
    [edit, activeTabId]
  );
  const sectionActions = React.useMemo(
    () => makeSectionActions(activeTabId),
    [makeSectionActions, activeTabId]
  );
  const headerActions = React.useMemo(() => makeSectionActions(HEADER_ID), [makeSectionActions]);
  const footerActions = React.useMemo(() => makeSectionActions(FOOTER_ID), [makeSectionActions]);
  const bandActions = React.useMemo<BandActions>(
    () => ({
      setSticky: (key, sticky) => edit(s => updateBand(s, key, { sticky })),
      setShow: (key, show) => edit(s => updateBand(s, key, { show })),
    }),
    [edit]
  );

  const tabsActions = React.useMemo<TabsActions>(
    () => ({
      add: () => edit(s => addTab(s).spec),
      rename: (id, label) => edit(s => updateTab(s, id, { label })),
      setIcon: (id, icon) => edit(s => updateTab(s, id, { icon })),
      setFitHeight: (id, fitHeight) => edit(s => updateTab(s, id, { fitHeight })),
      move: (from, to) => edit(s => reorderTabs(s, from, to)),
      remove: id => edit(s => deleteTab(s, id)),
      setPosition: tabPosition => edit(s => ({ ...s, tabPosition })),
      setRail: tabRail => edit(s => ({ ...s, tabRail })),
    }),
    [edit]
  );

  const ctx = React.useMemo<DashboardContextValue>(
    () => ({
      filters,
      refreshSignal: signal,
      // The grid and the widget controls are read-only while a save runs.
      editing: editing && !save.saving,
      kiosk: query.kiosk,
      reportRefreshed: refresh.report,
      cacheScope: `${storage.namespace}/${name}`,
      reportCached: refresh.cached,
      focus,
      setFocus,
    }),
    [
      filters,
      signal,
      editing,
      save.saving,
      query.kiosk,
      refresh,
      storage.namespace,
      name,
      focus,
      setFocus,
    ]
  );

  // Fit to screen height: the grid rows of the tab stretch to fill the screen. It is off while
  // editing, so a drag or a resize works on rows that stay still.
  const fitOn =
    !!spec && !!activeTab && tabFitsHeight(spec, activeTab) && !(editing && !save.saving);
  const fill = useFillRowHeight(
    fitOn,
    activeTab ? scalableRows(activeTab.sections) : 0,
    `${activeTabId}|${query.kiosk}`
  );

  // The kiosk has drawn (cached or fresh data, or the waiting screen): the boot cover can go.
  React.useEffect(() => {
    if (query.kiosk) removeBootCover();
  }, [query.kiosk, stored, loaded.loading]);

  // A kiosk keeps its scroll position across a reload (see kiosk/scrollMemory.ts).
  const [scrollEl, setScrollEl] = React.useState<HTMLElement | null>(null);
  useScrollMemory(scrollEl, query.kiosk ? `${storage.namespace}/${name}/${activeTabId}` : '');

  // The title bar is one row. A narrow bar folds the filter fields into one button (level 1), and
  // then drops the "Refreshed" text (level 2). The width unknown (a test) shows the full bar.
  const [barEl, barRef] = React.useState<HTMLDivElement | null>(null);
  const barWidth = useElementWidth(barEl);
  const barLevel =
    barWidth === 0 ? 0 : barWidth >= BAR_FULL_WIDTH ? 0 : barWidth >= BAR_TIGHT_WIDTH ? 1 : 2;
  // A wide bar has three equal parts, so the clock sits in the exact middle. A narrower bar flows
  // its controls in one wrapping row, and the clock follows the left part.
  const centred = barWidth >= BAR_CENTRED_WIDTH;

  // ---- render ----

  // A kiosk never shows an error screen for a server that is only away: it waits and the load retries.
  if (!stored && query.kiosk && (loaded.loading || isTransientError(loaded.error))) {
    return (
      <KioskOverlay onExit={() => replaceQuery({ kiosk: false })} bar={<ConnectionIndicator />}>
        <Box
          data-kiosk-waiting
          sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <Typography variant="h6" color="text.secondary">
            Waiting for the server. This page loads the dashboard when it answers.
          </Typography>
        </Box>
      </KioskOverlay>
    );
  }
  if (loaded.loading && !stored) return <Loader title="Loading the dashboard" />;
  if (!stored || !spec || !activeTab) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert
          severity="error"
          action={
            // No dashboard is on screen here. In kiosk mode the button is not shown, so a click
            // cannot leave full screen.
            !query.kiosk && (
              <Button color="inherit" onClick={() => history.push(listPath)}>
                All dashboards
              </Button>
            )
          }
        >
          {loaded.error?.message ?? 'The dashboard could not be loaded.'}
        </Alert>
      </Box>
    );
  }
  if (stored.error) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert
          severity="error"
          action={
            // No dashboard is on screen here. In kiosk mode the button is not shown, so a click
            // cannot leave full screen.
            !query.kiosk && (
              <Button color="inherit" onClick={() => history.push(listPath)}>
                All dashboards
              </Button>
            )
          }
        >
          This dashboard cannot be shown. {stored.error}
        </Alert>
      </Box>
    );
  }

  const sectionsOfTab = activeTab.sections;
  const paletteTarget = sectionsOfTab.some(s => s.id === paletteSection)
    ? paletteSection
    : sectionsOfTab[0].id;
  const left = spec.tabPosition === 'left';
  const compact = left && spec.tabRail === 'compact';
  const showTabs = spec.tabs.length > 1 || editing;

  const onAddWidget = (def: WidgetDefinition, sectionId: string) => {
    // A palette entry of a panel source adds the base type with the source in its settings.
    // Sources are per browser, so the spec must not depend on one.
    const variant = baseWidgetType(def.type);
    const config = JSON.parse(JSON.stringify(def.defaultConfig));
    if (variant) config.source = variant.source;
    edit(
      s =>
        addWidget(
          s,
          tabOf(sectionId, activeTabId),
          sectionId,
          variant?.type ?? def.type,
          def.defaultSize,
          config
        ).spec
    );
  };

  const filterBar = (
    <FilterBar
      filters={filters}
      onChange={f => replaceQuery({ view: '', filters: f })}
      namespaceOptions={namespaceOptions}
      nodeOptions={nodeOptions}
      views={spec.views}
      activeView={query.view}
      onSelectView={id =>
        replaceQuery({ view: id, filters: spec.views.find(v => v.id === id)?.filters ?? filters })
      }
      onSaveView={
        writable
          ? async viewName => {
              // Only the view is saved. Other edits in the draft stay unsaved.
              const build = (base: DashboardSpec) => saveView(base, viewName, filters);
              const view = build(stored.spec).views.find(v => v.name === viewName);
              if (await persist(build)) {
                setDraft(d => (d ? saveView(d, viewName, filters) : d));
                replaceQuery({ view: view?.id ?? '', filters: view?.filters ?? filters });
              }
            }
          : undefined
      }
      onDeleteView={
        writable
          ? async id => {
              const build = (base: DashboardSpec) => deleteView(base, id);
              if (await persist(build)) {
                setDraft(d => (d ? deleteView(d, id) : d));
                if (query.view === id) replaceQuery({ view: '', filters });
              }
            }
          : undefined
      }
      onReset={() => replaceQuery({ view: '', filters: spec.filters })}
      // The three parts of a wide bar leave no room for open fields: they stay behind the Filters button.
      compact={barLevel >= 1 || centred}
      tight={barLevel >= 2}
    />
  );

  const tabBar = showTabs && (
    <Box
      data-tab-rail={left ? (compact ? 'compact' : 'wide') : undefined}
      sx={{
        flex: 'none',
        borderBottom: left ? 0 : 1,
        borderRight: left ? 1 : 0,
        borderColor: 'divider',
        mb: left ? 0 : 1,
        mr: left ? 1 : 0,
        // The compact rail is narrow: an icon with its label under it.
        width: compact ? COMPACT_RAIL_WIDTH : undefined,
        ...(compact ? { borderRight: 1, borderColor: 'divider' } : {}),
        minWidth: left && !compact ? 160 : undefined,
      }}
    >
      <Tabs
        value={activeTab.id}
        orientation={left ? 'vertical' : 'horizontal'}
        variant="scrollable"
        scrollButtons="auto"
        aria-label="Dashboard tabs"
        TabIndicatorProps={compact ? { sx: { display: 'none' } } : undefined}
        onChange={(_e, id: string) => goTab(id)}
      >
        {spec.tabs.map(t => (
          <Tab
            key={t.id}
            value={t.id}
            label={compact ? <RailLabel text={t.label} /> : t.label}
            title={compact ? t.label : undefined}
            aria-label={compact ? t.label : undefined}
            icon={
              <Box component="span" sx={{ position: 'relative', display: 'inline-flex' }}>
                <Icon icon={t.icon} width={compact ? 22 : 20} height={compact ? 22 : 20} />
                {t.badge && <TabBadge badge={t.badge} refreshSignal={signal} inline={!compact} />}
              </Box>
            }
            iconPosition={compact ? 'top' : 'start'}
            sx={
              compact
                ? {
                    minHeight: 64,
                    maxHeight: 72,
                    width: '100%',
                    minWidth: 0,
                    maxWidth: 'none',
                    px: 0.5,
                    py: 1,
                    borderRadius: '4px',
                    textTransform: 'none',
                    fontSize: '0.71875rem',
                    lineHeight: 1.2,
                    color: 'text.secondary',
                    position: 'relative',
                    '& .MuiTab-iconWrapper': { mb: 0.5, mr: 0 },
                    // The active tab: a soft fill and a 3 px bar on the left edge.
                    '&.Mui-selected': {
                      color: 'text.primary',
                      bgcolor: 'action.selected',
                      '&::before': {
                        content: '""',
                        position: 'absolute',
                        left: 0,
                        top: 8,
                        bottom: 8,
                        width: 3,
                        borderRadius: '0 2px 2px 0',
                        bgcolor: 'info.main',
                      },
                    },
                  }
                : {
                    minHeight: 48,
                    textTransform: 'none',
                    justifyContent: left ? 'flex-start' : undefined,
                  }
            }
          />
        ))}
      </Tabs>
    </Box>
  );

  const sections = (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Box
        ref={fill.ref}
        data-fill-height={fitOn ? fill.rowHeight : undefined}
        sx={{ display: 'flow-root' }}
      >
        {sectionsOfTab.map((section, i) => (
          <SectionView
            fit={fitOn}
            rowHeight={fill.rowHeight}
            key={section.id}
            section={section}
            index={i}
            count={sectionsOfTab.length}
            editing={editing && !save.saving}
            kiosk={query.kiosk}
            frameActions={frameActions}
            actions={sectionActions}
          />
        ))}
      </Box>
    </Box>
  );

  const bandView = (key: BandKey) => (
    <BandView
      bandKey={key}
      band={spec[key]}
      editing={editing && !save.saving}
      kiosk={query.kiosk}
      frameActions={frameActions}
      sectionActions={key === 'header' ? headerActions : footerActions}
      bandActions={bandActions}
    />
  );

  // The header and the footer sit outside the tabs, so they stay when the tab changes. In the
  // kiosk the block is at least as tall as the screen, so a footer sits at the bottom.
  const content = (
    <DashboardContext.Provider value={ctx}>
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: query.kiosk ? '100%' : undefined,
        }}
      >
        {/* View mode draws the header widgets inline in the title bar. */}
        {editing && bandView('header')}
        <Box
          ref={setSwipeArea}
          data-tab-area
          sx={{
            ...TAB_AREA_TOUCH,
            display: 'flex',
            flexDirection: left ? 'row' : 'column',
            alignItems: 'stretch',
            flex: 1,
          }}
        >
          {tabBar}
          {sections}
        </Box>
        {bandView('footer')}
      </Box>
    </DashboardContext.Provider>
  );

  // The header widgets, inline in the title bar, in three parts: the alert chips on the left, the
  // clock in the middle and any other widget on the right. Edit mode keeps the header band under
  // the toolbar.
  const headerPart = (part: HeaderPart) =>
    !editing && (
      <DashboardContext.Provider value={ctx}>
        <HeaderStrip
          band={spec.header}
          kiosk={query.kiosk}
          frameActions={frameActions}
          part={part}
        />
      </DashboardContext.Provider>
    );

  const dialogs = (
    <>
      {/* Only leaving this dashboard asks. A query change, a tab change and the exit from edit mode after Save stay on it. */}
      <Prompt
        when={dirty}
        message={next =>
          parsePath(next.pathname).name === name
            ? true
            : 'You have unsaved changes to this dashboard. Leave without saving?'
        }
      />
      <PaletteDrawer
        open={editing && paletteOpen}
        onClose={() => setPaletteOpen(false)}
        definitions={definitions}
        sections={[
          ...sectionsOfTab.map(s => ({ id: s.id, title: s.title })),
          { id: HEADER_ID, title: 'Header (every tab)' },
          { id: FOOTER_ID, title: 'Footer (every tab)' },
        ]}
        sectionId={paletteTarget}
        onSectionChange={setPaletteSection}
        onAdd={onAddWidget}
      />
      {editing && tabsOpen && (
        <TabsDialog spec={spec} actions={tabsActions} onClose={() => setTabsOpen(false)} />
      )}
      {editing && settingsOpen && (
        <DashboardSettingsDialog
          title={spec.title}
          description={spec.description}
          kioskShowFilters={spec.kioskShowFilters}
          fitHeight={spec.fitHeight}
          onCancel={() => setSettingsOpen(false)}
          onApply={(title, description, kioskShowFilters, fitHeight) => {
            edit(s => ({ ...s, title, description, kioskShowFilters, fitHeight }));
            setSettingsOpen(false);
          }}
        />
      )}
      {editing && widgetSettings && (
        <WidgetSettingsHost
          spec={spec}
          tabId={tabOf(widgetSettings.sectionId, activeTabId)}
          target={widgetSettings}
          onCancel={() => setWidgetSettings(null)}
          onApply={r => {
            edit(s =>
              updateWidget(
                s,
                tabOf(widgetSettings.sectionId, activeTabId),
                widgetSettings.sectionId,
                widgetSettings.widgetId,
                r
              )
            );
            setWidgetSettings(null);
          }}
        />
      )}
      <Menu
        anchorEl={menu?.anchor}
        open={!!menu && editing && !save.saving}
        onClose={() => setMenu(null)}
      >
        {menu &&
          widgetMenuItems({
            spec,
            tabId: tabOf(menu.sectionId, activeTabId),
            target: menu,
            close: () => setMenu(null),
            onSettings: () =>
              setWidgetSettings({ sectionId: menu.sectionId, widgetId: menu.widgetId }),
            onDuplicate: () =>
              edit(
                s =>
                  duplicateWidget(
                    s,
                    tabOf(menu.sectionId, activeTabId),
                    menu.sectionId,
                    menu.widgetId
                  ).spec
              ),
            onDelete: () =>
              edit(s =>
                deleteWidget(s, tabOf(menu.sectionId, activeTabId), menu.sectionId, menu.widgetId)
              ),
            onMove: to =>
              edit(s =>
                moveWidgetToTabSection(
                  s,
                  { tabId: tabOf(menu.sectionId, activeTabId), sectionId: menu.sectionId },
                  to,
                  menu.widgetId
                )
              ),
          })}
      </Menu>
    </>
  );

  const kiosk = query.kiosk;
  // One tree for the page and the full screen view. Only styles change between the two, so
  // every widget keeps its state and its data when the page enters or leaves full screen.
  return (
    <LinkContext.Provider value={linkTargets}>
      <KioskFrame active={kiosk} onExit={() => replaceQuery({ kiosk: false })}>
        {dialogs}
        <Box
          ref={barRef}
          data-title-bar
          data-title-bar-level={barLevel}
          data-title-bar-sticky={!kiosk && !editing && spec.header.sticky ? '' : undefined}
          sx={{
            ...(centred
              ? {
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
                  // The page bar can have a second row of filters on the left. The clock and the
                  // buttons stay level with the title, in the first row.
                  alignItems: kiosk ? 'center' : 'start',
                }
              : {
                  display: 'flex',
                  // The bar folds its controls as it narrows (see barLevel). When they still do
                  // not fit in one row, they wrap to the next row. A control is never drawn over
                  // another one.
                  flexWrap: 'wrap',
                  alignItems: 'center',
                }),
            columnGap: kiosk ? 3 : 2,
            rowGap: 1,
            mb: 1,
            minWidth: 0,
            // The wall header sits straight on the page background: no fill, edge or side padding.
            ...(kiosk ? { minHeight: 68 } : {}),
            ...(!kiosk && !editing && spec.header.sticky
              ? { position: 'sticky', top: 0, zIndex: 4, bgcolor: 'background.default' }
              : {}),
          }}
        >
          <Box
            data-title-bar-left
            sx={{
              // A narrow bar draws the left part as part of its own wrapping row.
              display: centred ? 'flex' : 'contents',
              flexWrap: 'wrap',
              alignItems: 'center',
              columnGap: kiosk ? 3 : 2,
              rowGap: 1,
              minWidth: 0,
            }}
          >
            <Box
              sx={{
                minWidth: 80,
                maxWidth: kiosk ? 'none' : centred ? 180 : barLevel >= 2 ? 150 : 240,
                flex: '0 1 auto',
              }}
            >
              <Typography
                variant={kiosk ? 'h6' : 'h5'}
                component="h1"
                noWrap
                sx={kiosk ? { fontSize: 26, fontWeight: 700 } : undefined}
              >
                {spec.title}
              </Typography>
              {!kiosk && barLevel < 2 && spec.description && (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  noWrap
                  title={spec.description}
                  data-dashboard-description
                >
                  {spec.description}
                </Typography>
              )}
            </Box>
            {headerPart('left')}
            <ConnectionIndicator />
            {/* On a wide page bar the filters take the second row of the left part. */}
            <Box
              sx={{
                flex: '1 1 auto',
                minWidth: 0,
                ...(centred && !kiosk ? { flexBasis: '100%' } : {}),
              }}
            >
              {(!kiosk || spec.kioskShowFilters) && filterBar}
            </Box>
          </Box>
          {headerPart('centre')}
          <Box
            data-title-bar-tail
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'flex-end',
              columnGap: kiosk ? 3 : 2,
              rowGap: 1,
              minWidth: 0,
              maxWidth: '100%',
              // The wide bar puts the tail in its right part. A narrow bar pushes it to the end.
              ...(centred ? { justifySelf: 'end' } : { marginLeft: 'auto' }),
            }}
          >
            {!kiosk && !editing && (
              <Tooltip
                title={
                  writable ? 'Edit this dashboard' : 'You have read-only access to dashboards here'
                }
              >
                <span>
                  <Button
                    variant="outlined"
                    disabled={!writable}
                    startIcon={<Icon icon="mdi:pencil-outline" width={18} height={18} />}
                    onClick={() => setEdit(true)}
                  >
                    Edit
                  </Button>
                </span>
              </Tooltip>
            )}
            {headerPart('right')}
            <RefreshControls
              store={refresh}
              seconds={seconds}
              onSecondsChange={onSecondsChange}
              showText={barLevel < 2}
              showAuto={!kiosk}
              narrow={barLevel >= 2}
              iconSize={kiosk ? 28 : 24}
              touch={kiosk}
            />
            {kiosk ? (
              <KioskExitButton onExit={() => replaceQuery({ kiosk: false })} />
            ) : (
              <HeaderIconButton
                label="Full screen"
                icon="mdi:fullscreen"
                iconSize={24}
                onClick={() => {
                  enterBrowserFullscreen();
                  replaceQuery({ kiosk: true, edit: false });
                }}
              />
            )}
          </Box>
        </Box>
        {!kiosk && canWrite === false && (
          <Alert severity="info" sx={{ mb: 1 }}>
            You have read-only access to dashboards in the namespace "{storage.namespace}". You can
            view them but not change them.
          </Alert>
        )}
        {!kiosk && stored.migrated && !editing && (
          <Alert severity="info" sx={{ mb: 1 }}>
            This dashboard was saved with an older format. It is upgraded when you save it.
          </Alert>
        )}
        {editing && (
          <Box
            role="toolbar"
            aria-label="Edit tools"
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 1,
              mb: 1,
              p: 1,
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
            }}
          >
            <Button
              size="small"
              variant="contained"
              startIcon={<Icon icon="mdi:plus" width={18} height={18} />}
              onClick={() => setPaletteOpen(true)}
            >
              Add widget
            </Button>
            <Button
              size="small"
              startIcon={<Icon icon="mdi:view-agenda" width={18} height={18} />}
              onClick={() => edit(s => addSection(s, activeTabId, 'New section'))}
            >
              Add section
            </Button>
            <Button
              size="small"
              startIcon={<Icon icon="mdi:view-grid-outline" width={18} height={18} />}
              onClick={() => setTabsOpen(true)}
            >
              Tabs
            </Button>
            <Button
              size="small"
              startIcon={<Icon icon="mdi:cog-outline" width={18} height={18} />}
              onClick={() => setSettingsOpen(true)}
            >
              Dashboard settings
            </Button>
            <Box sx={{ flex: 1 }} />
            {dirty && (
              <Typography variant="caption" color="warning.main" role="status">
                Unsaved changes
              </Typography>
            )}
            <Button
              size="small"
              onClick={() =>
                dirty && !window.confirm('Discard your changes?') ? undefined : setEdit(false)
              }
            >
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
                // Stay in edit mode when the draft changed while the save ran.
                if (draft && (await saveDraft(draft)) && savedDraftRef.current) setEdit(false);
              }}
            >
              {save.saving ? 'Saving…' : 'Save'}
            </Button>
          </Box>
        )}
        {!kiosk && editing && specWatch.newer && (
          <Alert
            severity="info"
            role="status"
            data-spec-changed
            sx={{ mb: 1 }}
            action={
              <Button
                color="inherit"
                size="small"
                onClick={() => {
                  setDraft(null);
                  specWatch.applyNewer();
                }}
              >
                Discard my changes and load it
              </Button>
            }
          >
            The saved dashboard changed. Your changes stay on screen. Save them to see the conflict,
            or load the saved dashboard.
          </Alert>
        )}
        {!kiosk && save.conflict && (
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
        {!kiosk && save.error && !save.conflict && (
          <Alert
            severity="error"
            sx={{ mb: 1 }}
            onClose={() => setSave(s => ({ ...s, error: undefined }))}
          >
            {save.error}
          </Alert>
        )}
        <Box
          data-kiosk-scroll={kiosk ? '' : undefined}
          ref={setScrollEl}
          sx={
            kiosk
              ? {
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  scrollbarWidth: 'none',
                  '&::-webkit-scrollbar': { display: 'none' },
                }
              : undefined
          }
        >
          {content}
        </Box>
      </KioskFrame>
    </LinkContext.Provider>
  );
}

/** At this bar width (px) and above, the filter fields show in the row. Below it they fold into one button. */
const BAR_FULL_WIDTH = 1560;
/** At this bar width (px) and above, the bar has three equal parts and the clock is in its middle. */
const BAR_CENTRED_WIDTH = 1000;
/** Below this bar width (px), the "Refreshed" text goes too. */
const BAR_TIGHT_WIDTH = 1060;

/** The width of an element, in px, kept up to date with a ResizeObserver. 0 until it is known. */
function useElementWidth(el: HTMLElement | null): number {
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return width;
}

/** Width of the compact left tab rail, in px. */
const COMPACT_RAIL_WIDTH = 96;

/** The label under the icon of a compact tab: at most two lines, long words break. */
function RailLabel({ text }: { text: string }): JSX.Element {
  return (
    <Box
      component="span"
      sx={{
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical',
        WebkitLineClamp: 2,
        overflow: 'hidden',
        overflowWrap: 'anywhere',
        maxWidth: '100%',
      }}
    >
      {text}
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
  const widget = sectionsOf(spec, tabId)
    .find(s => s.id === target.sectionId)
    ?.widgets.find(w => w.id === target.widgetId);
  const def = useWidgetDefinition(widget?.type ?? '');
  if (!widget) return null;
  return (
    <WidgetSettingsDialog
      key={widget.id}
      widget={widget}
      def={def}
      onCancel={props.onCancel}
      onApply={props.onApply}
    />
  );
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
  const destinations = [
    ...spec.tabs.flatMap(t =>
      t.sections
        .filter(s => !(t.id === tabId && s.id === target.sectionId))
        .map(s => ({
          tabId: t.id,
          sectionId: s.id,
          label:
            spec.tabs.length > 1 ? `${t.label} / ${s.title || 'Untitled'}` : s.title || 'Untitled',
        }))
    ),
    ...(target.sectionId === HEADER_ID
      ? []
      : [{ tabId: HEADER_ID, sectionId: HEADER_ID, label: 'Header (every tab)' }]),
    ...(target.sectionId === FOOTER_ID
      ? []
      : [{ tabId: FOOTER_ID, sectionId: FOOTER_ID, label: 'Footer (every tab)' }]),
  ];
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
