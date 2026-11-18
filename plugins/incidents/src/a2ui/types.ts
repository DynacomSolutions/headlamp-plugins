/** Types for the A2UI v1.0 messages this renderer understands (basic catalog). */

export const A2UI_VERSION = '1.0';
export const BASIC_CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

export interface A2uiComponent {
  id: string;
  component: string;
  [property: string]: unknown;
}

export type A2uiMessage = { version?: string } & Partial<{
  createSurface: {
    surfaceId: string;
    catalogId?: string;
    components?: A2uiComponent[];
    dataModel?: unknown;
  };
  updateComponents: { surfaceId: string; components: A2uiComponent[] };
  updateDataModel: { surfaceId: string; path?: string; value?: unknown };
  deleteSurface: { surfaceId: string };
}>;

export interface Surface {
  id: string;
  catalogId?: string;
  components: Record<string, A2uiComponent>;
  dataModel: unknown;
}

export interface SurfaceState {
  surfaces: Record<string, Surface>;
  /** Human-readable problems, for example messages with an unsupported version. */
  warnings: string[];
}
