'use strict';

/**
 * The commands of the family "screen" of the shared catalog of ioBroker.assistant (its HELP.md): `getScreens`,
 * `show` and `hide`, mapped onto the dashboards (clients) and the messages of Aura (`notify`, `notifyDismiss`).
 * Pure functions; main.js reads the clients and delivers the message.
 */

/** What `show` can put on a dashboard: a message with text, a picture or a popup view */
const SCREEN_KINDS = ['text', 'image', 'view'];

/** Every kind of the catalog; the ones Aura cannot show are answered with NOT_SUPPORTED */
const CATALOG_KINDS = ['image', 'url', 'camera', 'chart', 'text', 'view', 'place', 'qr'];

/**
 * The longest picture a message keeps (`image` in _normalizeMessage of main.js): an address, or the picture itself as
 * a data URL in a message that is not kept in the history (persist false, the default of show)
 */
const IMAGE_MAX = 2000;
const IMAGE_DATA_MAX = 2000000;

/** Catalog severity → severity of an Aura message */
const SEVERITIES = { info: 'info', warning: 'warning', alert: 'error' };

/** Fields of the catalog that are not passed on to `notify` as they are */
const CATALOG_FIELDS = ['kind', 'screen', 'room', 'seconds', 'severity', 'target', 'contentType'];

/**
 * A failure in the form of the catalog.
 *
 * @param {string} error text for a human
 * @param {string} reason code
 * @param {object} [extra] further fields (candidates)
 * @returns {{error: string, reason: string}} the answer
 */
function fail(error, reason, extra) {
    return { error, reason, ...extra };
}

/**
 * The clients (open dashboards) from the states `clients.<id>.info.name` and `clients.<id>.info.lastSeen`.
 *
 * @param {Record<string, {val: unknown} | null>} states states below `<namespace>.clients.`
 * @param {string} namespace e.g. `aura.0`
 * @param {number} now ms
 * @param {number} onlineMs a heartbeat younger than this = switched on
 * @returns {{id: string, name: string, online: boolean}[]} the clients
 */
function clientsOf(states, namespace, now, onlineMs) {
    const prefix = `${namespace}.clients.`;
    const clients = new Map();
    for (const [fullId, state] of Object.entries(states || {})) {
        if (!fullId.startsWith(prefix)) {
            continue;
        }
        const [id, channel, leaf] = fullId.slice(prefix.length).split('.');
        if (!id || channel !== 'info') {
            continue;
        }
        const client = clients.get(id) || { id, name: id, online: false };
        if (leaf === 'name' && state && typeof state.val === 'string' && state.val.trim()) {
            client.name = state.val.trim();
        }
        if (leaf === 'lastSeen' && state) {
            client.online = now - Number(state.val) < onlineMs;
        }
        clients.set(id, client);
    }
    return [...clients.values()];
}

/**
 * The client a `screen` means: its id or its name, without case; an exact name wins over a partial one.
 *
 * @param {{id: string, name: string}[]} clients the clients
 * @param {string} screen id or name
 * @returns {{client?: {id: string, name: string}, error?: object}} the client or a failure
 */
function findClient(clients, screen) {
    const wanted = screen.trim().toLowerCase();
    const exact = clients.filter((c) => c.id.toLowerCase() === wanted || c.name.toLowerCase() === wanted);
    const hits = exact.length ? exact : clients.filter((c) => c.name.toLowerCase().includes(wanted));
    if (hits.length === 1) {
        return { client: hits[0] };
    }
    const candidates = (hits.length ? hits : clients).map((c) => c.name);
    return hits.length
        ? { error: fail(`"${screen}" fits several dashboards`, 'AMBIGUOUS', { candidates }) }
        : { error: fail(`no dashboard "${screen}"`, 'NOT_FOUND', { candidates }) };
}

/**
 * A picture as a message takes it: an http(s) URL or a path of Aura's server as it is, `iobfile://<instance>/<path>`
 * as `/webfs/<instance>/<path>` (the files of the web adapter), base64 with `contentType` as a data URL.
 *
 * @param {unknown} image the picture
 * @param {unknown} contentType of base64 data
 * @param {number} max the longest picture the message keeps
 * @returns {{image?: string, error?: object}} the picture or a failure
 */
function imageOf(image, contentType, max) {
    const value = typeof image === 'string' ? image.trim() : '';
    if (!value) {
        return { error: fail('image missing', 'BAD_REQUEST') };
    }
    let src;
    if (/^https?:\/\//i.test(value) || value.startsWith('/')) {
        src = value;
    } else if (/^iobfile:\/\//i.test(value)) {
        src = `/webfs/${value.replace(/^iobfile:\/\/\/?/i, '')}`;
    } else if (/^data:image\//i.test(value)) {
        src = value;
    } else if (typeof contentType === 'string' && /^image\//i.test(contentType) && /^[A-Za-z0-9+/=\s]+$/.test(value)) {
        src = `data:${contentType};base64,${value.replace(/\s/g, '')}`;
    } else {
        return {
            error: fail(
                'image must be an http(s) URL, iobfile://, a data URL or base64 with contentType',
                'BAD_REQUEST',
            ),
        };
    }
    if (src.length > max) {
        return {
            error: fail(
                `the picture is too large for a message (${max} characters): store it as a file and give its ` +
                    'iobfile:// path or a URL',
                'BAD_REQUEST',
            ),
        };
    }
    return { image: src };
}

/**
 * The `notify` payload of a catalog `show {screen?, room?, kind, ..., seconds?, title?}`.
 *
 * @param {Record<string, unknown>} m the message of `show`
 * @param {{id: string, name: string, online: boolean}[]} clients the clients
 * @returns {{payload?: Record<string, unknown>, screens?: string[], error?: object}} payload and the names of the
 *   dashboards it goes to, or a failure
 */
function showPayload(m, clients) {
    const kind = typeof m.kind === 'string' ? m.kind.trim() : '';
    if (!kind) {
        return { error: fail(`kind missing, one of ${SCREEN_KINDS.join(', ')}`, 'BAD_REQUEST') };
    }
    if (!SCREEN_KINDS.includes(kind)) {
        return {
            error: fail(
                CATALOG_KINDS.includes(kind)
                    ? `Aura cannot show the kind "${kind}", only ${SCREEN_KINDS.join(', ')}`
                    : `unknown kind "${kind}", one of ${SCREEN_KINDS.join(', ')}`,
                'NOT_SUPPORTED',
            ),
        };
    }
    // Fields of notify (position, priority, actions, look ...) pass through
    const payload = { ...m };
    for (const key of CATALOG_FIELDS) {
        delete payload[key];
    }
    if (kind === 'text' && !(typeof m.text === 'string' && m.text.trim())) {
        return { error: fail('text missing', 'BAD_REQUEST') };
    }
    if (kind === 'view' && !(typeof m.view === 'string' && m.view.trim())) {
        return { error: fail('view missing', 'BAD_REQUEST') };
    }
    // A look for a while: not kept in the history of the messages, unless asked for
    if (payload.persist === undefined) {
        payload.persist = false;
    }
    if (kind === 'image' || m.image !== undefined) {
        const { image, error } = imageOf(
            m.image,
            m.contentType,
            payload.persist === false ? IMAGE_DATA_MAX : IMAGE_MAX,
        );
        if (error) {
            return { error };
        }
        payload.image = image;
    }
    if (m.severity !== undefined) {
        const severity = SEVERITIES[String(m.severity)] || String(m.severity);
        if (!['info', 'success', 'warning', 'error'].includes(severity)) {
            return { error: fail(`unknown severity "${m.severity}", one of info, warning, alert`, 'BAD_REQUEST') };
        }
        payload.severity = severity;
    }
    if (m.seconds !== undefined && m.seconds !== null && m.seconds !== '') {
        const seconds = Number(m.seconds);
        if (!Number.isFinite(seconds) || seconds < 0) {
            return { error: fail('seconds must be 0 or more', 'BAD_REQUEST') };
        }
        payload.durationSec = seconds;
    }

    const screen = typeof m.screen === 'string' ? m.screen.trim() : '';
    if (screen) {
        const { client, error } = findClient(clients, screen);
        if (error) {
            return { error };
        }
        payload.target = { clients: [client.id] };
        return { payload, screens: [client.name] };
    }
    if (typeof m.room === 'string' && m.room.trim()) {
        return {
            error: fail('the dashboards of Aura have no rooms: give screen (see getScreens)', 'NOT_SUPPORTED', {
                candidates: clients.map((c) => c.name),
            }),
        };
    }
    return { payload, screens: clients.filter((c) => c.online).map((c) => c.name) };
}

module.exports = { SCREEN_KINDS, IMAGE_MAX, IMAGE_DATA_MAX, clientsOf, findClient, imageOf, showPayload };
