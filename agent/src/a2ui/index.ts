/**
 * A2UI v1.0 messages built from the basic catalog only, so any A2UI v1.0
 * renderer can show them (https://a2ui.org/specification/v1.0-a2ui/).
 *
 * Two shapes are produced:
 * - Self-contained surfaces (`createSurface` with components and data model),
 *   used for diagnosis reports that travel through ACP, the HTTP API and
 *   Headlamp.
 * - Templates plus data, the A2UI-over-MCP pattern: a tool descriptor points at
 *   an `a2ui://` resource holding `createSurface` and `updateComponents` with
 *   data bindings, and each tool result carries an `updateDataModel`.
 */

export const A2UI_VERSION = '1.0';
export const A2UI_MIME = 'application/a2ui+json';
export const BASIC_CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

export type DynamicString = string | { '@path': string };

export interface Component {
  id: string;
  component: string;
  [property: string]: unknown;
}

export interface CreateSurface {
  surfaceId: string;
  catalogId?: string;
  components?: Component[];
  dataModel?: unknown;
  sendDataModel?: boolean;
  metadata?: Record<string, unknown>;
}

export type A2uiMessage =
  | { version: '1.0'; createSurface: CreateSurface }
  | { version: '1.0'; updateComponents: { surfaceId: string; components: Component[] } }
  | { version: '1.0'; updateDataModel: { surfaceId: string; path?: string; value: unknown } }
  | { version: '1.0'; deleteSurface: { surfaceId: string } };

export type IconName = 'warning' | 'error' | 'info' | 'check' | 'help' | 'search' | 'settings' | 'notifications' | 'event' | 'refresh';

/** Builds a component tree with generated ids. The first component added with `root()` becomes `root`. */
export class SurfaceBuilder {
  private readonly components: Component[] = [];
  private counter = 0;

  private add(component: string, props: Record<string, unknown>, id?: string): string {
    const cid = id ?? `c${++this.counter}`;
    this.components.push({ id: cid, component, ...props });
    return cid;
  }

  text(text: DynamicString, variant: 'body' | 'caption' = 'body', id?: string): string {
    return this.add('Text', variant === 'body' ? { text } : { text, variant }, id);
  }

  icon(name: IconName, id?: string): string {
    return this.add('Icon', { name }, id);
  }

  column(children: string[] | { path: string; componentId: string }, id?: string, align?: 'start' | 'stretch'): string {
    return this.add('Column', align ? { children, align } : { children }, id);
  }

  row(children: string[], id?: string, justify?: 'start' | 'spaceBetween', align?: 'center' | 'start'): string {
    const props: Record<string, unknown> = { children };
    if (justify) props.justify = justify;
    if (align) props.align = align;
    return this.add('Row', props, id);
  }

  list(children: string[] | { path: string; componentId: string }, id?: string): string {
    return this.add('List', { children }, id);
  }

  card(child: string, id?: string): string {
    return this.add('Card', { child }, id);
  }

  divider(id?: string): string {
    return this.add('Divider', {}, id);
  }

  tabs(tabs: Array<{ title: DynamicString; child: string }>, id?: string): string {
    return this.add('Tabs', { tabs }, id);
  }

  /** A borderless button whose action opens a URL in the renderer (basic catalog `openUrl`). */
  link(label: string, url: string, id?: string): string {
    const child = this.text(label);
    return this.add('Button', { child, variant: 'borderless', action: { functionCall: { call: 'openUrl', args: { url } } } }, id);
  }

  /** Marks `child` as the root by wrapping it, when it was not created with id `root`. */
  root(child: string): void {
    if (child === 'root') return;
    const existing = this.components.find(c => c.id === child);
    if (existing) {
      existing.id = 'root';
      for (const c of this.components) relink(c, child, 'root');
    }
  }

  build(surfaceId: string, dataModel?: unknown, metadata?: Record<string, unknown>): A2uiMessage[] {
    if (!this.components.some(c => c.id === 'root')) throw new Error('A2UI surface has no root component');
    const createSurface: CreateSurface = { surfaceId, catalogId: BASIC_CATALOG, components: this.components };
    if (dataModel !== undefined) createSurface.dataModel = dataModel;
    if (metadata) createSurface.metadata = metadata;
    return [{ version: A2UI_VERSION, createSurface }];
  }

  /** The template form: createSurface without data, then updateComponents. */
  template(surfaceId: string): A2uiMessage[] {
    if (!this.components.some(c => c.id === 'root')) throw new Error('A2UI template has no root component');
    return [
      { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: BASIC_CATALOG } },
      { version: A2UI_VERSION, updateComponents: { surfaceId, components: this.components } },
    ];
  }
}

function relink(component: Component, from: string, to: string): void {
  if (component.child === from) component.child = to;
  if (Array.isArray(component.children)) component.children = component.children.map(c => (c === from ? to : c));
}

export function updateDataModel(surfaceId: string, value: unknown, path = '/'): A2uiMessage {
  return { version: A2UI_VERSION, updateDataModel: { surfaceId, path, value } };
}

/** Surface ids must be UAX #31 identifiers and unique per renderer. */
export function surfaceId(prefix: string, unique: string): string {
  const clean = `${prefix}_${unique}`.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(clean) ? clean : `s_${clean}`;
}

/**
 * The shared view every tool result can fill: a title, a one-line summary and
 * a list of rows, each with a label, a detail line and a status word. Bound by
 * JSON Pointer, so it is sent once as a resource and reused for every call.
 */
export const SUMMARY_VIEW_URI = 'a2ui://headlamp-agent/views/summary-list';
export const SUMMARY_VIEW_SURFACE = 'headlamp_agent_summary_list';

export interface SummaryView {
  title: string;
  summary: string;
  rows: Array<{ label: string; detail: string; status?: string }>;
}

export function summaryViewTemplate(): A2uiMessage[] {
  const b = new SurfaceBuilder();
  const title = b.text({ '@path': '/title' });
  const summary = b.text({ '@path': '/summary' }, 'caption');
  const rowLabel = b.text({ '@path': 'label' }, 'body', 'row_label');
  const rowStatus = b.text({ '@path': 'status' }, 'caption', 'row_status');
  const rowHead = b.row([rowLabel, rowStatus], 'row_head', 'spaceBetween');
  const rowDetail = b.text({ '@path': 'detail' }, 'caption', 'row_detail');
  b.column([rowHead, rowDetail], 'row_item');
  const rows = b.list({ path: '/rows', componentId: 'row_item' });
  const body = b.column([title, summary, b.divider(), rows]);
  b.card(body, 'root');
  return b.template(SUMMARY_VIEW_SURFACE);
}

/** Wraps a SummaryView as the per-call data update for the summary template, with the title as Markdown heading. */
export function summaryViewData(view: SummaryView): A2uiMessage {
  return updateDataModel(SUMMARY_VIEW_SURFACE, {
    title: `### ${view.title}`,
    summary: view.summary,
    rows: view.rows.slice(0, 100).map(r => ({ label: r.label, detail: r.detail, status: r.status ?? '' })),
  });
}
