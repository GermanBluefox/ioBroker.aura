/**
 * Runtime side of ioBroker web components: which components the installed
 * adapters offer (their manifests only - no code of a component runs for that),
 * and the one socket bridge every webcomponent widget hands to its element.
 *
 * Adapters list their components in `common.webComponents`; the files lie in the
 * adapter's admin folder, served as `<base>/adapter/<adapter>/`. Aura's own server
 * answers `/adapter/…` from the file storage and `/lib/esm/react-*.js` itself, and
 * behind the web adapter extension (`/aura/`) web serves both, so
 * `getWebComponentSources(…, document.baseURI)` finds them either way.
 *
 * While anything shows the catalog, it follows the instance objects: an adapter
 * with components installed, updated or removed shows up without a reload. The
 * URLs carry the adapter version, so the next page load fetches updated files
 * instead of cached ones.
 */
import { useCallback, useEffect, useState } from 'react';
import {
    getWebComponentSources,
    loadWebComponents,
    type LoadedWebComponent,
    type WebComponentSocket,
} from '@iobroker/web-components';
import {
    getDisconnectedSince,
    getObjectDirect,
    getObjectViewDirect,
    getSocket,
    getStateDirect,
    onDisconnectedSinceChange,
    sendToDirect,
    setStateDirectAsync,
    subscribeObjectDirect,
    subscribeStateDirect,
    whenStateReadsIdle,
} from '../hooks/useIoBroker';
import {
    createCatalogWatch,
    createWebComponentSocket,
    mergeCatalog,
    objectIdOfRow,
    versionedModule,
    versionedSources,
    type HostState,
} from './webComponentHost';

let catalog: Promise<LoadedWebComponent[]> | null = null;
const catalogListeners = new Set<() => void>();
// What the last read gave - a read again is merged into it (mergeCatalog).
let catalogLoaded: LoadedWebComponent[] = [];
const catalogWatch = createCatalogWatch();

type InstanceObject = { _id: string; common?: { version?: string; webComponents?: unknown } };

async function readInstances(): Promise<InstanceObject[]> {
    const view = await getObjectViewDirect('instance', 'system.adapter.', 'system.adapter.\u9999');
    return (view.rows ?? [])
        .map((row) => row.value as unknown as InstanceObject)
        .filter((obj) => obj && typeof obj._id === 'string');
}

async function readCatalog(): Promise<LoadedWebComponent[]> {
    const all = await readInstances();
    catalogWatch.reset(all);
    const instances = all
        .filter((obj) => Array.isArray(obj.common?.webComponents) && obj.common.webComponents.length)
        .map((obj) => ({ _id: obj._id, common: obj.common ?? {} }));
    const loaded = instances.length
        ? await loadWebComponents(versionedSources(getWebComponentSources(instances, document.baseURI)), {
              log: console,
          })
        : [];
    catalogLoaded = mergeCatalog(loaded.map(versionedModule), catalogLoaded, (tag) => !!customElements.get(tag));
    return catalogLoaded;
}

// ── keeping the catalog current ──────────────────────────────────────────────
// Installing, updating or removing an adapter rewrites its instance objects. While
// anything uses the catalog (a widget, the add dialog, the settings), their changes
// are watched; a burst of them (an update rewrites every instance) is read once,
// when it is over - and only if the set of (adapter, version, components) changed.
const RELOAD_DELAY_MS = 2000;
// Switching tabs unmounts and mounts the widgets: no unsubscribe/subscribe for that.
const UNWATCH_DELAY_MS = 10000;
let catalogUsers = 0;
let stopWatching: (() => void) | null = null;
let unwatchTimer: ReturnType<typeof setTimeout> | undefined;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleCatalogReload(): void {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
        reloadTimer = undefined;
        void loadWebComponentCatalog(true);
    }, RELOAD_DELAY_MS);
}

/** For a time no change could arrive in (unwatched, offline): read the instance
 *  objects once, and the catalog only if they changed it. */
function recheckCatalog(): void {
    if (!catalog) return; // not read yet - the first read is current anyway
    void whenStateReadsIdle()
        .then(readInstances)
        .then((all) => {
            if (catalogWatch.differs(all)) scheduleCatalogReload();
        })
        .catch(() => undefined);
}

/**
 * Keep the catalog current while it is in use; returns the function that ends this
 * use. Called by useWebComponentCatalog - exported for the tests.
 */
export function watchCatalog(): () => void {
    catalogUsers++;
    clearTimeout(unwatchTimer);
    if (!stopWatching) {
        const offObjects = subscribeObjectDirect('system.adapter.*', (obj, id) => {
            if (catalogWatch.change(id, obj)) scheduleCatalogReload();
        });
        // A pattern's changes during an outage are lost - look once it is over.
        const offConnection = onDisconnectedSinceChange(() => {
            if (getDisconnectedSince() === null) recheckCatalog();
        });
        stopWatching = () => {
            offObjects();
            offConnection();
        };
        recheckCatalog();
    }
    return () => {
        if (--catalogUsers > 0) return;
        unwatchTimer = setTimeout(() => {
            stopWatching?.();
            stopWatching = null;
        }, UNWATCH_DELAY_MS);
    };
}

/**
 * The components of all installed adapters, read once per page and shared, and
 * read again when an adapter with components is installed, updated or removed
 * (while `useWebComponentCatalog` is mounted).
 *
 * @param force read again
 */
export function loadWebComponentCatalog(force = false): Promise<LoadedWebComponent[]> {
    if (!catalog || force) {
        catalog = readCatalog().catch((e: unknown) => {
            console.warn('[webcomponent] reading the components failed:', e);
            catalog = null; // the next widget may try again
            return [];
        });
        if (force) void catalog.then(() => catalogListeners.forEach((fn) => fn()));
    }
    return catalog;
}

/** The component of a widget: by tag, the adapter only as a tie-breaker */
export function findWebComponent(
    components: LoadedWebComponent[],
    tag: unknown,
    adapter?: unknown,
): LoadedWebComponent | undefined {
    if (typeof tag !== 'string' || !tag) return undefined;
    const withTag = components.filter((c) => c.manifest.tag === tag);
    return withTag.find((c) => c.adapter === adapter) ?? withTag[0];
}

/** React access to the catalog: `components` stays empty until it is read, and
 *  keeps the components it has while the catalog is read again. */
export function useWebComponentCatalog(): {
    components: LoadedWebComponent[];
    loading: boolean;
    reload: () => void;
} {
    const [components, setComponents] = useState<LoadedWebComponent[]>([]);
    const [loading, setLoading] = useState(true);
    const [epoch, setEpoch] = useState(0);

    useEffect(() => {
        const bump = (): void => setEpoch((n) => n + 1);
        catalogListeners.add(bump);
        const unwatch = watchCatalog();
        return () => {
            catalogListeners.delete(bump);
            unwatch();
        };
    }, []);

    useEffect(() => {
        let alive = true;
        void loadWebComponentCatalog().then((list) => {
            if (!alive) return;
            setComponents(list);
            setLoading(false);
        });
        return () => {
            alive = false;
        };
    }, [epoch]);

    const reload = useCallback(() => {
        void loadWebComponentCatalog(true);
    }, []);

    return { components, loading, reload };
}

let socketBridge: Promise<WebComponentSocket> | null = null;

/** The `socket` property for every element: Aura's socket in the shape of a socket-client `Connection` */
export function getWebComponentSocket(): Promise<WebComponentSocket> {
    if (!socketBridge) {
        socketBridge = (async () => {
            const sys = (await getObjectDirect('system.config').catch(() => null)) as {
                common?: { language?: string };
            } | null;
            const lang = sys?.common?.language || 'en';
            return createWebComponentSocket(
                {
                    subscribeState: (id, cb) => subscribeStateDirect(id, (state) => cb(state as unknown as HostState)),
                    getState: async (id) => (await getStateDirect(id)) as unknown as HostState | null,
                    setState: (id, val, ack) =>
                        setStateDirectAsync(
                            id,
                            (val !== null && typeof val === 'object' ? JSON.stringify(val) : val) as
                                | boolean
                                | number
                                | string,
                            ack,
                        ),
                    getObject: (id) => getObjectDirect(id),
                    subscribeObject: (id, cb) => subscribeObjectDirect(id, cb),
                    getHistory: (id, options) =>
                        new Promise((resolve, reject) => {
                            getSocket().emit('getHistory', id, options, (err: unknown, result: unknown) =>
                                err
                                    ? reject(err instanceof Error ? err : new Error(String(err)))
                                    : resolve(result ?? []),
                            );
                        }),
                    getObjectView: async (type, start, end) => {
                        const view = await getObjectViewDirect(
                            type as Parameters<typeof getObjectViewDirect>[0],
                            start,
                            end,
                        );
                        const out: Record<string, unknown> = {};
                        // by the object's own ID: the `config` view keys its rows by name
                        for (const row of view.rows ?? []) out[objectIdOfRow(row)] = row.value;
                        return out;
                    },
                    sendTo: async (instance, command, data) => {
                        const result = await sendToDirect(instance, command, data);
                        if (result && typeof result === 'object' && '__timeout' in result) {
                            throw new Error(`sendTo ${instance} "${command}": no answer`);
                        }
                        return result;
                    },
                },
                lang,
            );
        })();
    }
    return socketBridge;
}
