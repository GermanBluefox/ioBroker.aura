/**
 * Host side of ioBroker web components (`@iobroker/web-components`): what the
 * webcomponent widget hands to a custom element, kept free of React and of the
 * live socket so it can be tested on its own.
 *
 * - `createWebComponentSocket` - the `socket` property: the subset of a socket-client
 *   `Connection` a component may use, built on Aura's own socket helpers.
 * - `themeFromVars` - the `theme` property from Aura's theme variables.
 * - `typedSettings` - the `settings` property from what the widget stored.
 * - `evalSettingExpr` - `hidden` / `disabled` of a settings field (JSON-Config style).
 * - `findTabForView` - where the `iob-navigate` event of a component leads.
 * - `webComponentPickerEntries` / `parseWebComponentKey` / `webComponentGridSize` -
 *   every installed component as an entry of its own in the "add widget" dialog.
 * - `versionedSources` / `versionedModule` / `mergeCatalog` / `createCatalogWatch` -
 *   a catalog that follows installs and updates, with versioned URLs.
 */
import {
    getDefaultSettings,
    getSettingTypes,
    getText,
    resolveManifestUrl,
    toSettings,
    toWebComponentTheme,
    type LoadedWebComponent,
    type WebComponentManifest,
    type WebComponentSettings,
    type WebComponentSocket,
    type WebComponentTheme,
} from '@iobroker/web-components';

/** A state as the socket delivers it */
export interface HostState {
    val: unknown;
    ack?: boolean;
    ts?: number;
    lc?: number;
    from?: string;
    q?: number;
    [key: string]: unknown;
}

type StateHandler = (id: string, state: HostState | null | undefined) => void;
type ObjectHandler = (id: string, obj: unknown) => void;

/** What the bridge needs from Aura's socket layer (hooks/useIoBroker), injected for tests */
export interface HostSocketApi {
    /** Subscribe one state; returns the unsubscribe function */
    subscribeState(id: string, cb: (state: HostState) => void): () => void;
    getState(id: string): Promise<HostState | null>;
    setState(id: string, val: unknown, ack: boolean): Promise<void>;
    getObject(id: string): Promise<unknown>;
    /**
     * Subscribe one object or a pattern of them; returns the unsubscribe function. `cb` gets the new
     * object (null when deleted) and its ID. Optional: without it, objects are read once
     */
    subscribeObject?(id: string, cb: (obj: unknown, id?: string) => void): () => void;
    getHistory(id: string, options: Record<string, unknown>): Promise<unknown>;
    getObjectView(type: string, start: string, end: string): Promise<Record<string, unknown>>;
    sendTo(instance: string, command: string, data: unknown): Promise<unknown>;
}

const ids = (id: string | string[]): string[] => (Array.isArray(id) ? id : [id]).filter(Boolean);

/**
 * The `socket` property. One bridge serves every element: subscriptions are kept
 * per id and callback, so an element that unsubscribes one callback leaves the
 * others alone, and `unsubscribeState(id)` without a callback drops them all.
 *
 * @param api Aura's socket helpers
 * @param systemLang the language of the ioBroker system (`system.config`)
 */
export function createWebComponentSocket(api: HostSocketApi, systemLang: string): WebComponentSocket {
    const stateSubs = new Map<string, Map<StateHandler, () => void>>();
    const objectSubs = new Map<string, Map<ObjectHandler, () => void>>();

    const drop = <H>(subs: Map<string, Map<H, () => void>>, id: string, cb?: H): void => {
        const forId = subs.get(id);
        if (!forId) return;
        for (const [handler, off] of [...forId]) {
            if (cb && handler !== cb) continue;
            off();
            forId.delete(handler);
        }
        if (!forId.size) subs.delete(id);
    };

    const socket = {
        systemLang,
        subscribeState(id: string | string[], cb: StateHandler): Promise<void> {
            for (const one of ids(id)) {
                const forId = stateSubs.get(one) ?? new Map<StateHandler, () => void>();
                if (forId.has(cb)) continue;
                forId.set(
                    cb,
                    api.subscribeState(one, (state) => cb(one, state)),
                );
                stateSubs.set(one, forId);
            }
            return Promise.resolve();
        },
        unsubscribeState(id: string | string[], cb?: StateHandler): void {
            for (const one of ids(id)) drop(stateSubs, one, cb);
        },
        getState(id: string) {
            return api.getState(id);
        },
        async setState(id: string, val: unknown, ack?: boolean): Promise<void> {
            // A SettableState object ({ val, ack }) or the bare value, as in socket-client
            if (val !== null && typeof val === 'object' && 'val' in (val as Record<string, unknown>)) {
                const s = val as { val: unknown; ack?: boolean };
                await api.setState(id, s.val, ack ?? !!s.ack);
                return;
            }
            await api.setState(id, val, !!ack);
        },
        getObject(id: string) {
            return api.getObject(id);
        },
        async subscribeObject(id: string | string[], cb: ObjectHandler): Promise<void> {
            for (const one of ids(id)) {
                const forId = objectSubs.get(one) ?? new Map<ObjectHandler, () => void>();
                if (forId.has(cb)) continue;
                if (api.subscribeObject) {
                    // a pattern calls back with the ID of the object that changed
                    forId.set(
                        cb,
                        api.subscribeObject(one, (obj, objId) => cb(objId || one, obj ?? null)),
                    );
                } else {
                    // No object events on this socket: the current object once, so the
                    // component is not left waiting for a first change.
                    forId.set(cb, () => undefined);
                    void api.getObject(one).then((obj) => {
                        if (objectSubs.get(one)?.has(cb)) cb(one, obj);
                    });
                }
                objectSubs.set(one, forId);
            }
        },
        unsubscribeObject(id: string | string[], cb?: ObjectHandler): Promise<void> {
            for (const one of ids(id)) drop(objectSubs, one, cb);
            return Promise.resolve();
        },
        getHistory(id: string, options: Record<string, unknown>) {
            return api.getHistory(id, options);
        },
        getObjectViewSystem(type: string, start?: string, end?: string) {
            return api.getObjectView(type, start ?? '', end ?? '\u9999');
        },
        sendTo(instance: string, command: string, data?: unknown) {
            return api.sendTo(instance, command, data);
        },
    };
    return socket as unknown as WebComponentSocket;
}

/**
 * The `theme` property from Aura's theme variables. A component gets the accent
 * as primary color, the page and widget backgrounds, the text colors and the
 * colors of a state; the base class completes the rest.
 *
 * @param readVar value of a CSS custom property, e.g. `--accent` (empty when unset)
 * @param dark whether the active theme is a dark one
 * @param fontFamily the font of the page
 * @param remPx the size of 1rem in px - Aura gives its radii in rem
 */
export function themeFromVars(
    readVar: (name: string) => string,
    dark: boolean,
    fontFamily?: string,
    remPx = 16,
): WebComponentTheme {
    const v = (name: string): string | undefined => readVar(name).trim() || undefined;
    return toWebComponentTheme({
        type: dark ? 'dark' : 'light',
        primary: v('--accent'),
        secondary: v('--accent-yellow'),
        background: v('--app-bg'),
        paper: v('--widget-bg'),
        text: v('--text-primary'),
        textSecondary: v('--text-secondary'),
        divider: v('--widget-border'),
        error: v('--accent-red'),
        warning: v('--accent-yellow'),
        success: v('--accent-green'),
        info: v('--accent'),
        fontFamily: fontFamily?.trim() || undefined,
        borderRadius: lengthToPx(v('--widget-radius'), remPx),
    });
}

/**
 * A CSS length in px: `12px` -> 12, `0.75rem` -> 12. Anything else (calc(), %, var())
 * is left to the default - a component gets its radius as a number of px.
 *
 * @param value the length
 * @param remPx the size of 1rem in px
 */
function lengthToPx(value: string | undefined, remPx: number): number | undefined {
    const m = /^(-?\d*\.?\d+)(px|r?em)?$/.exec(value ?? '');
    if (!m) return undefined;
    const n = Number(m[1]);
    return m[2] === 'rem' || m[2] === 'em' ? Math.round(n * remPx * 100) / 100 : n;
}

/**
 * The `settings` property: the declared defaults, overwritten by what the widget
 * stored, each converted to the type its field declares. Unknown keys are dropped.
 *
 * @param manifest the manifest of the component
 * @param stored `options.wcSettings` of the widget
 */
export function typedSettings(manifest: WebComponentManifest, stored: unknown): WebComponentSettings {
    const values = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
    return toSettings(getSettingTypes(manifest), { ...getDefaultSettings(manifest), ...values });
}

/**
 * `hidden` / `disabled` of a settings field: a JS expression over `data` (the
 * values of all settings), as JSON-Config evaluates it. A broken expression
 * counts as false - the field stays visible and usable.
 *
 * @param expr the expression from the manifest
 * @param data the current values
 */
export function evalSettingExpr(expr: string | undefined, data: Record<string, unknown>): boolean {
    if (!expr) return false;
    try {
        return !!new Function('data', `return (${expr});`)(data);
    } catch {
        return false;
    }
}

interface NavTab {
    id: string;
    name: string;
    slug: string;
}
interface NavSection {
    id: string;
    slug: string;
    tabs: NavTab[];
}
interface NavLayout {
    id: string;
    slug: string;
    sections: NavSection[];
}

/**
 * Where `iob-navigate` leads: a tab of the active layout named by its slug, id or
 * name (case-insensitive), first in the active section, then in the others.
 *
 * @param view `detail.view` of the event
 * @param layouts all layouts
 * @param activeLayoutId the layout on screen
 * @param activeSectionId the section on screen, searched first
 */
export function findTabForView(
    view: unknown,
    layouts: NavLayout[],
    activeLayoutId: string,
    activeSectionId?: string,
): { layoutId: string; sectionId: string; tabId: string } | null {
    const wanted = typeof view === 'string' ? view.trim().toLowerCase() : '';
    if (!wanted) return null;
    const layout = layouts.find((l) => l.id === activeLayoutId) ?? layouts[0];
    if (!layout) return null;
    const sections = [...layout.sections].sort(
        (a, b) => Number(b.id === activeSectionId) - Number(a.id === activeSectionId),
    );
    for (const section of sections) {
        const tab = section.tabs.find((t) =>
            [t.slug, t.id, t.name].some((key) => typeof key === 'string' && key.toLowerCase() === wanted),
        );
        if (tab) return { layoutId: layout.id, sectionId: section.id, tabId: tab.id };
    }
    return null;
}

// ── the "add widget" dialog ─────────────────────────────────────────────────

/** One installed web component as an entry of its own in the "add widget" dialog */
export interface WebComponentPickerEntry {
    /** `wc:<adapter>|<tag>` - cannot clash with a widget type or a template id */
    key: string;
    adapter: string;
    tag: string;
    /** Name of the component in the language of the frontend */
    label: string;
    /** Its description and the adapter that brings it */
    hint: string;
    /** Absolute URL of its picture, if the manifest names one */
    iconUrl?: string;
    /** The size it looks best in (px), if the manifest names one */
    size?: { width: number; height: number };
}

const KEY_PREFIX = 'wc:';

/** The key of a component in the dialog (and in "recently used") */
export function webComponentKey(adapter: string, tag: string): string {
    return `${KEY_PREFIX}${adapter}|${tag}`;
}

/** Adapter and tag of a key made by `webComponentKey`, or null for anything else */
export function parseWebComponentKey(key: unknown): { adapter: string; tag: string } | null {
    if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX)) return null;
    const rest = key.slice(KEY_PREFIX.length);
    const bar = rest.indexOf('|');
    if (bar < 0 || bar === rest.length - 1) return null;
    return { adapter: rest.slice(0, bar), tag: rest.slice(bar + 1) };
}

/**
 * The installed components as entries of the dialog: once per adapter and tag,
 * named in the frontend's language (English, then the tag, as fallback).
 *
 * @param components the catalog (`loadWebComponentCatalog`)
 * @param lang language of the frontend
 */
export function webComponentPickerEntries(components: LoadedWebComponent[], lang: string): WebComponentPickerEntry[] {
    const entries: WebComponentPickerEntry[] = [];
    for (const c of components) {
        const tag = c?.manifest?.tag;
        if (typeof tag !== 'string' || !tag) continue;
        const key = webComponentKey(c.adapter, tag);
        if (entries.some((e) => e.key === key)) continue;
        const language = lang as Parameters<typeof getText>[1];
        const description = getText(c.manifest.description, language);
        const from = c.adapter ? `Adapter ${c.adapter}` : '';
        const size = c.manifest.size;
        entries.push({
            key,
            adapter: c.adapter,
            tag,
            label: getText(c.manifest.name, language) || tag,
            hint: [description, from].filter(Boolean).join(' – '),
            iconUrl: resolveManifestUrl(c.manifest.icon, c.url),
            size:
                size && Number(size.width) > 0 && Number(size.height) > 0
                    ? { width: Number(size.width), height: Number(size.height) }
                    : undefined,
        });
    }
    return entries;
}

/**
 * Grid size of a new widget for a component's preferred size: the element area
 * plus the widget's inner padding, in cells of the dashboard grid
 * (cells of `snapX` × `rowHeight` px with `gap` px between them).
 *
 * @param size the size the manifest names, in px
 * @param grid the grid and the widget padding (px)
 * @param grid.rowHeight height of a grid row
 * @param grid.snapX width of a grid column
 * @param grid.gap space between two cells
 * @param grid.padding inner padding of a widget
 */
export function webComponentGridSize(
    size: { width: number; height: number } | undefined,
    grid: { rowHeight: number; snapX: number; gap: number; padding: number },
): { w: number; h: number } | null {
    if (!size || !(size.width > 0) || !(size.height > 0)) return null;
    const cells = (px: number, cell: number): number =>
        Math.max(2, Math.round((px + 2 * grid.padding + grid.gap) / (Math.max(1, cell) + grid.gap)));
    return { w: cells(size.width, grid.snapX), h: cells(size.height, grid.rowHeight) };
}

/**
 * The ID of an object in a row of an object view. Most views of js-controller key
 * their rows by the ID, but `config` keys them by `common.name` - flow's diagram
 * `flow.0.diagrams.12v` comes back as `12V`. The object itself knows its ID.
 *
 * @param row a row of `getObjectView`
 * @param row.id the key the view emitted
 * @param row.value the object (or what the view emits for it)
 */
export function objectIdOfRow(row: { id: string; value?: unknown }): string {
    const own = (row.value as { _id?: unknown } | null | undefined)?._id;
    return typeof own === 'string' && own ? own : row.id;
}

// ── a catalog that stays current ────────────────────────────────────────────

/**
 * A URL with the adapter version as query `v`. Manifests and modules lie under
 * URLs without a version, so a browser could keep using cached files of an
 * adapter after its update; with the version the next page load fetches the new
 * ones. The servers (Aura's own, web) ignore the query.
 *
 * @param url absolute URL of a manifest or a module
 * @param version version of the adapter that brings it
 */
export function versionedUrl(url: string, version: string): string {
    if (!version) return url;
    try {
        const u = new URL(url);
        u.searchParams.set('v', version);
        return u.href;
    } catch {
        return url;
    }
}

/**
 * The sources of the catalog (`getWebComponentSources`) with versioned manifest URLs
 *
 * @param sources where the components are described
 */
export function versionedSources<T extends { url: string; version: string }>(sources: T[]): T[] {
    return sources.map((s) => ({ ...s, url: versionedUrl(s.url, s.version) }));
}

/**
 * A loaded component whose module URL is versioned as well: the manifest names its
 * module relative to itself, and resolving that drops the query of the manifest
 * URL. `importWebComponent` still imports every URL once and checks the tag.
 *
 * @param component as `loadWebComponents` gave it
 */
export function versionedModule(component: LoadedWebComponent): LoadedWebComponent {
    return { ...component, moduleUrl: versionedUrl(component.moduleUrl, component.version) };
}

/**
 * The catalog read again, merged with the one before:
 * - a component whose element is defined already keeps the module URL it was
 *   imported from. A browser cannot define a tag twice, so the module of an update
 *   would be loaded and run for nothing - it takes effect with the next page load;
 * - a component that did not change stays the same object, so the widgets showing
 *   it are left alone.
 *
 * @param next the components just read
 * @param previous the components read before
 * @param isDefined whether the element of a tag is defined in this page
 */
export function mergeCatalog(
    next: LoadedWebComponent[],
    previous: LoadedWebComponent[],
    isDefined: (tag: string) => boolean,
): LoadedWebComponent[] {
    return next.map((c) => {
        const before = previous.find((p) => p.adapter === c.adapter && p.manifest.tag === c.manifest.tag);
        if (!before) return c;
        const kept =
            before.moduleUrl !== c.moduleUrl && isDefined(c.manifest.tag) ? { ...c, moduleUrl: before.moduleUrl } : c;
        const same =
            kept.url === before.url &&
            kept.moduleUrl === before.moduleUrl &&
            JSON.stringify(kept.manifest) === JSON.stringify(before.manifest);
        return same ? before : kept;
    });
}

const INSTANCE_ID = /^system\.adapter\.([^.]+)\.\d+$/;

/** The part of an instance object the catalog depends on */
interface CatalogInstance {
    _id?: unknown;
    common?: { version?: unknown; webComponents?: unknown };
}

/**
 * What of an instance object decides the catalog: its adapter, version and list
 * of components. null for an instance without components and for every other ID.
 *
 * @param id the object ID, e.g. `system.adapter.flow.0`
 * @param obj the object, null when it was deleted
 */
export function catalogEntryOf(id: unknown, obj: unknown): string | null {
    const m = typeof id === 'string' ? INSTANCE_ID.exec(id) : null;
    const common = (obj as CatalogInstance | null | undefined)?.common;
    const list = common?.webComponents;
    if (!m || !Array.isArray(list) || !list.length) return null;
    return JSON.stringify([m[1], String(common?.version ?? ''), list]);
}

/** Tells from the instance objects whether the catalog has to be read again */
export interface CatalogWatch {
    /** The catalog was just read from these instance objects */
    reset(instances: unknown[]): void;
    /** An `objectChange` below `system.adapter.`: true when the catalog has to be read again */
    change(id: string, obj: unknown): boolean;
    /** The instance objects read anew after a time without changes (an outage): true when they differ */
    differs(instances: unknown[]): boolean;
}

/**
 * Read the catalog again only when the set of (adapter, version, components)
 * changes - installed, updated or removed - and not when an instance starts,
 * stops, gets new settings or an adapter gets a second instance.
 */
export function createCatalogWatch(): CatalogWatch {
    let entries = new Map<string, string>();
    let signature = '';
    const collect = (instances: unknown[]): Map<string, string> => {
        const map = new Map<string, string>();
        for (const obj of instances) {
            const id = (obj as CatalogInstance | null)?._id;
            const entry = catalogEntryOf(id, obj);
            if (entry) map.set(id as string, entry);
        }
        return map;
    };
    const sign = (map: Map<string, string>): string => [...new Set(map.values())].sort().join('\n');
    return {
        reset(instances) {
            entries = collect(instances);
            signature = sign(entries);
        },
        change(id, obj) {
            if (!INSTANCE_ID.test(id)) return false;
            const entry = catalogEntryOf(id, obj);
            if (entry) entries.set(id, entry);
            else entries.delete(id);
            const next = sign(entries);
            if (next === signature) return false;
            signature = next;
            return true;
        },
        differs(instances) {
            return sign(collect(instances)) !== signature;
        },
    };
}
