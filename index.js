// Inventory UI — a Minecraft-style inventory for SillyTavern.
// Tracks what the characters carry with a separate (cheap) model and
// injects the result into the prompt so the main model remembers it.

import { t, setLanguage } from './src/i18n.js';
import { applyTextures } from './src/textures.js';
import {
    sanitizeState, ensureOwner, applyChanges, buildRefs, pushLog, pruneCheckpoints,
    revertRecords, replayRecords, repairSlots, clone, findByName, firstFreeSlot, resolveWhere,
    normalizeItem, clampQty,
} from './src/state.js';
import {
    DEFAULT_TRACKER_PROMPT, DEFAULT_INJECT_TEMPLATE,
    formatForTracker, formatForPrompt, buildTrackerPrompt, sendTrackerRequest, parseChanges, cleanMessageText,
} from './src/tracker.js';
import { InventoryUI, HotbarHud, showToast } from './src/ui.js';

const MODULE = 'inventoryUI';
const META_KEY = 'inventoryUI';
const PROMPT_KEY = 'INVENTORY_UI';
const EXTENSION_URL = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

const DEFAULTS = Object.freeze({
    enabled: true,
    language: 'auto',
    owners: 'char',
    profileId: '',
    maxTokens: 700,
    autoUpdate: true,
    updateEvery: 1,
    scanGreeting: true,
    rescanOnEdit: false,
    maxNewMessages: 4,
    contextMessages: 1,
    maxMessageChars: 6000,
    historyMessages: 30,
    waitBeforeGenerate: true,
    waitTimeout: 60,
    trackerPrompt: DEFAULT_TRACKER_PROMPT,
    injectEnabled: true,
    injectPosition: 1,
    injectDepth: 2,
    injectRole: 0,
    injectDescriptions: true,
    injectTemplate: DEFAULT_INJECT_TEMPLATE,
    showHotbar: true,
    showToasts: true,
    showErrors: true,
    pixelFont: true,
    slotSize: 36,
    bagRows: 3,
    confirmDelete: false,
    panelOpen: false,
    panelPos: null,
});

/** @type {typeof DEFAULTS & Record<string, any>} */
let settings;
let ui;
let hud;
let personaModule = null;
let undoStack = [];
let status = { busy: false, text: '', error: false };
let queue = Promise.resolve();
let pendingJobs = 0;
/** @type {{mesId: number, chatId: string, controller: AbortController, cancelled: boolean}[]} */
let jobs = [];

const ctx = () => SillyTavern.getContext();

// ---------- Settings ----------

function loadSettings() {
    const ext = ctx().extensionSettings;
    ext[MODULE] = Object.assign({}, structuredClone(DEFAULTS), ext[MODULE] ?? {});
    settings = ext[MODULE];
    if (!settings.trackerPrompt?.trim()) settings.trackerPrompt = DEFAULT_TRACKER_PROMPT;
    if (!settings.injectTemplate?.trim()) settings.injectTemplate = DEFAULT_INJECT_TEMPLATE;
}

function saveSettings() {
    ctx().saveSettingsDebounced();
}

function applyAppearance() {
    document.body.classList.toggle('ivui-font-pixel', !!settings.pixelFont);
    document.documentElement.style.setProperty('--ivui-slot-size', `${Number(settings.slotSize) || 36}px`);
}

// ---------- Chat state ----------

let cached = { meta: null, state: null };

function getState() {
    const c = ctx();
    if (!c.chatId || !c.chatMetadata) return null;
    const meta = c.chatMetadata;
    if (cached.meta === meta && meta[META_KEY] === cached.state && cached.state) return cached.state;
    const state = sanitizeState(meta[META_KEY]);
    meta[META_KEY] = state;
    cached = { meta, state };
    return state;
}

function saveState() {
    const c = ctx();
    if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
    else c.saveMetadata?.();
}

function userAvatarUrl() {
    const file = personaModule?.user_avatar;
    return file ? ctx().getThumbnailUrl('persona', file) : '';
}

/** Characters whose inventories are tracked in the current chat. */
function getOwners() {
    const c = ctx();
    if (!c.chatId) return [];
    const chars = [];
    if (c.groupId) {
        const group = c.groups?.find(g => g.id === c.groupId);
        for (const avatar of group?.members ?? []) {
            if (group.disabled_members?.includes(avatar)) continue;
            const ch = c.characters.find(x => x.avatar === avatar);
            if (ch) chars.push({ key: `char:${ch.name}`, name: ch.name, avatar: c.getThumbnailUrl('avatar', ch.avatar) });
        }
    } else if (c.characterId !== undefined && c.characters[c.characterId]) {
        const ch = c.characters[c.characterId];
        chars.push({ key: `char:${ch.name}`, name: ch.name, avatar: c.getThumbnailUrl('avatar', ch.avatar) });
    }
    const user = { key: 'user', name: c.name1 || 'User', avatar: userAvatarUrl(), isUser: true };
    if (settings.owners === 'user') return [user];
    if (settings.owners === 'both') return [...chars, user];
    return chars;
}

/** Saves, re-injects and redraws after any state change. */
function commit() {
    const state = getState();
    if (state) {
        for (const o of getOwners()) ensureOwner(state, o.key, o.name);
    }
    saveState();
    updateInjection();
    ui?.render();
    hud?.render();
}

function mutate(fn) {
    const state = getState();
    if (!state) return false;
    const before = clone(state.owners);
    const result = fn(state);
    if (result === false) return false;
    for (const owner of Object.values(state.owners)) repairSlots(owner);
    undoStack.push(before);
    if (undoStack.length > 30) undoStack.shift();
    commit();
    return true;
}

function undo() {
    const state = getState();
    const snapshot = undoStack.pop();
    if (!state || !snapshot) return false;
    state.owners = snapshot;
    commit();
    return true;
}

function replaceState(data) {
    mutate((state) => {
        const imported = sanitizeState({ owners: data.owners });
        state.owners = imported.owners;
    });
}

// ---------- Prompt injection ----------

function inventoryText(state = getState(), owners = getOwners()) {
    if (!state || !owners.length) return '';
    return formatForPrompt(state, owners, { descriptions: !!settings.injectDescriptions });
}

function updateInjection() {
    const c = ctx();
    const state = getState();
    const owners = getOwners();
    const position = Number(settings.injectPosition);
    const depth = Number(settings.injectDepth);
    const role = Number(settings.injectRole);
    if (!settings.enabled || !settings.injectEnabled || !state || !owners.length) {
        c.setExtensionPrompt(PROMPT_KEY, '', position, depth, false, role);
        return;
    }
    const list = inventoryText(state, owners);
    const text = settings.injectTemplate.replace(/\{\{inventory\}\}/gi, () => list);
    c.setExtensionPrompt(PROMPT_KEY, text, position, depth, false, role);
}

// ---------- Status ----------

function setStatus(text, error = false) {
    status.text = text;
    status.error = error;
    ui?.updateStatus();
}

function setBusy(busy) {
    status.busy = busy;
    if (busy) {
        status.text = t('status_busy');
        status.error = false;
    }
    ui?.updateStatus();
    hud?.render();
}

function idleStatusText() {
    return settings.autoUpdate ? t('status_idle') : t('status_disabled');
}

// ---------- Tracker queue ----------

function isTrackable(msg) {
    return !!msg && !msg.is_user && !msg.is_system && typeof msg.mes === 'string';
}

function fingerprint(msg) {
    const date = msg?.swipe_info?.[0]?.send_date;
    return date ? `${msg.name}|${date}` : '';
}

function cancelJobs(predicate) {
    for (const job of jobs) {
        if (predicate(job)) {
            job.cancelled = true;
            job.controller.abort();
        }
    }
}

/**
 * Queues an analysis of the messages up to mesId.
 * @param {number} mesId
 * @param {{ fullScan?: boolean, manual?: boolean }} [options]
 */
function enqueue(mesId, options = {}) {
    const c = ctx();
    if (!c.chatId) return Promise.resolve();
    cancelJobs(job => job.mesId === mesId && !job.fullScan);
    const job = { mesId, chatId: c.chatId, controller: new AbortController(), cancelled: false, ...options };
    jobs.push(job);
    pendingJobs++;
    setBusy(true);
    const run = queue
        .then(() => runJob(job))
        .catch(error => console.error('[Inventory UI]', error))
        .finally(() => {
            jobs = jobs.filter(x => x !== job);
            pendingJobs--;
            if (pendingJobs <= 0) {
                pendingJobs = 0;
                setBusy(false);
                if (!status.error && status.text === t('status_busy')) setStatus(idleStatusText());
            }
        });
    queue = run;
    return run;
}

/** Undoes what the tracker applied for this message (before a swipe / regeneration). */
function revertCheckpoint(state, mesId) {
    const cp = state.checkpoints[mesId];
    if (!cp) return false;
    const active = cp.active;
    if (active !== null && active !== undefined && cp.swipes?.[active]) {
        revertRecords(state, cp.swipes[active].records ?? []);
        state.log = state.log.filter(e => e.m !== mesId);
    }
    cp.active = null;
    state.last = cp.prevLast ?? null;
    return true;
}

function messageForTracker(msg, c) {
    return {
        name: msg.is_user ? (msg.name || c.name1) : (msg.name || c.name2),
        text: cleanMessageText(msg.mes, Number(settings.maxMessageChars) || 6000),
    };
}

function backgroundInfo(c, owners) {
    const parts = [];
    for (const o of owners) {
        if (o.isUser) {
            const desc = c.powerUserSettings?.persona_description;
            if (desc) parts.push(`${o.name}: ${cleanMessageText(c.substituteParams(desc), 2500)}`);
        } else {
            const ch = c.characters.find(x => x.name === o.name);
            const desc = ch?.description || ch?.data?.description;
            if (desc) parts.push(`${o.name}: ${cleanMessageText(c.substituteParams(desc), 2500)}`);
        }
    }
    return parts.join('\n\n');
}

async function runJob(job) {
    if (job.cancelled) return;
    const c = ctx();
    if (c.chatId !== job.chatId) return;
    const state = getState();
    const owners = getOwners();
    if (!state || !owners.length) return;
    const chat = c.chat;
    const msg = chat[job.mesId];
    if (!msg || (!job.fullScan && !isTrackable(msg))) return;

    setBusy(true);
    try {
        // Build the prompt from a copy: the real inventory changes only once a valid answer arrives,
        // so a failed or cancelled request leaves it untouched.
        const cp = state.checkpoints[job.mesId];
        const staleCheckpoint = !!(cp?.fp && cp.fp !== fingerprint(msg));
        const draft = clone(state);
        let start;
        if (job.fullScan) {
            start = Math.max(0, job.mesId - (Number(settings.historyMessages) || 30) + 1);
        } else {
            // Re-analysis of a message (continue, regenerate): undo its previous result first.
            if (!staleCheckpoint) revertCheckpoint(draft, job.mesId);
            const maxNew = Math.max(1, Number(settings.maxNewMessages) || 4);
            start = Math.max(draft.last === null || draft.last === undefined ? 0 : draft.last + 1, job.mesId - maxNew + 1);
            if (start > job.mesId) start = job.mesId;
        }

        const newMessages = chat.slice(start, job.mesId + 1).filter(m => m && !m.is_system).map(m => messageForTracker(m, c));
        const ctxCount = job.fullScan ? 0 : Math.max(0, Number(settings.contextMessages) || 0);
        const contextMessages = ctxCount
            ? chat.slice(Math.max(0, start - ctxCount), start).filter(m => m && !m.is_system)
                .map(m => ({ ...messageForTracker(m, c), text: cleanMessageText(m.mes, 1500) }))
            : [];

        for (const o of owners) ensureOwner(draft, o.key, o.name);
        const { refs, byId } = buildRefs(draft, owners.map(o => o.key));
        const prompt = buildTrackerPrompt({
            template: settings.trackerPrompt || DEFAULT_TRACKER_PROMPT,
            inventory: formatForTracker(draft, owners, byId),
            owners,
            newMessages,
            contextMessages,
            background: job.fullScan ? backgroundInfo(c, owners) : '',
            fullScan: !!job.fullScan,
        });

        const answer = await sendTrackerRequest(prompt, {
            profileId: settings.profileId,
            maxTokens: Number(settings.maxTokens) || 700,
            signal: job.controller.signal,
        });
        if (job.cancelled || ctx().chatId !== job.chatId || getState() !== state) return;
        const changes = parseChanges(answer);

        // Valid answer: now update the real state.
        if (!job.fullScan) {
            if (staleCheckpoint) delete state.checkpoints[job.mesId];
            else revertCheckpoint(state, job.mesId);
        }
        const prevLast = state.last;
        for (const o of owners) ensureOwner(state, o.key, o.name);
        const { records, log } = applyChanges(state, changes, { owners, refs });

        if (job.fullScan) {
            pushLog(state, log, null);
            state.last = Math.max(state.last ?? -1, job.mesId);
        } else {
            const swipeId = Number(msg.swipe_id ?? 0);
            const entry = state.checkpoints[job.mesId] ?? { swipes: {} };
            entry.prevLast = prevLast ?? null;
            entry.fp = fingerprint(msg);
            entry.swipes = entry.swipes ?? {};
            entry.swipes[swipeId] = { records, log };
            entry.active = swipeId;
            state.checkpoints[job.mesId] = entry;
            state.last = job.mesId;
            pruneCheckpoints(state);
            pushLog(state, log, job.mesId);
        }
        if (records.length) undoStack = [];
        commit();
        const panelCoversScreen = ui?.isOpen && window.innerWidth < 640;
        if (settings.showToasts && log.length && !panelCoversScreen) showToast(log);
        setStatus(log.length ? t('status_updated', job.mesId) : t('status_nochange', job.mesId));
    } catch (error) {
        if (job.cancelled || error?.name === 'AbortError') return;
        const message = error?.cause?.message || error?.message || String(error);
        console.error('[Inventory UI] Tracker failed', error);
        setStatus(t('status_error', message), true);
        if (settings.showErrors) toastr.warning(t('tracker_failed', message), '', { timeOut: 6000 });
    }
}

// ---------- ST events ----------

function onMessageReceived(mesId, type) {
    if (!settings.enabled || !settings.autoUpdate) return;
    const c = ctx();
    const id = Number(mesId);
    const msg = c.chat[id];
    if (!isTrackable(msg)) return;
    if (type === 'first_message' && !settings.scanGreeting) return;
    const state = getState();
    if (!state) return;

    const every = Math.max(1, Number(settings.updateEvery) || 1);
    if (every > 1 && !state.checkpoints[id]) {
        let count = 0;
        const from = state.last === null || state.last === undefined ? 0 : state.last + 1;
        for (let i = from; i <= id; i++) if (isTrackable(c.chat[i])) count++;
        if (count < every) return;
    }
    enqueue(id);
}

function onMessageSwiped(mesId) {
    const id = Number(mesId);
    cancelJobs(job => job.mesId === id);
    const state = getState();
    const cp = state?.checkpoints[id];
    if (!cp) return;
    const msg = ctx().chat[id];
    if (cp.fp && cp.fp !== fingerprint(msg)) {
        delete state.checkpoints[id];
        return;
    }
    revertCheckpoint(state, id);
    const swipeId = Number(msg?.swipe_id ?? 0);
    const cachedSwipe = cp.swipes?.[swipeId];
    // An existing swipe that was analyzed before: re-apply its changes without a new request.
    if (cachedSwipe && typeof msg?.swipes?.[swipeId] === 'string' && msg.mes === msg.swipes[swipeId]) {
        replayRecords(state, cachedSwipe.records ?? []);
        cp.active = swipeId;
        state.last = id;
        pushLog(state, cachedSwipe.log ?? [], id);
    }
    commit();
}

function onSwipeDeleted(data) {
    const id = Number(data?.messageId);
    const removed = Number(data?.swipeId);
    const state = getState();
    const cp = state?.checkpoints[id];
    if (!cp?.swipes) return;
    if (cp.active === removed) revertCheckpoint(state, id);
    const shifted = {};
    for (const [key, value] of Object.entries(cp.swipes)) {
        const k = Number(key);
        if (k === removed) continue;
        shifted[k > removed ? k - 1 : k] = value;
    }
    cp.swipes = shifted;
    if (cp.active !== null && cp.active !== undefined && cp.active > removed) cp.active--;
    commit();
    if (cp.active === null) onMessageSwiped(id);
}

function onMessageDeleted(chatLength) {
    const length = Number(chatLength);
    cancelJobs(job => job.mesId >= length);
    const state = getState();
    if (!state) return;
    const chat = ctx().chat;
    let changed = false;
    const ids = Object.keys(state.checkpoints).map(Number).sort((a, b) => b - a);
    for (const id of ids) {
        const cp = state.checkpoints[id];
        if (id >= length) {
            revertCheckpoint(state, id);
            delete state.checkpoints[id];
            changed = true;
        } else if (cp.fp && cp.fp !== fingerprint(chat[id])) {
            // Message indices shifted (a message in the middle was deleted).
            delete state.checkpoints[id];
            changed = true;
        }
    }
    if (state.last !== null && state.last >= length) {
        state.last = length > 0 ? length - 1 : null;
        changed = true;
    }
    if (changed) commit();
}

function onMessageEdited(mesId) {
    if (!settings.enabled || !settings.autoUpdate || !settings.rescanOnEdit) return;
    const id = Number(mesId);
    const state = getState();
    if (!state || id !== state.last || !isTrackable(ctx().chat[id])) return;
    enqueue(id);
}

function onChatChanged() {
    cancelJobs(() => true);
    undoStack = [];
    cached = { meta: null, state: null };
    setStatus(idleStatusText());
    const state = getState();
    if (state) {
        for (const o of getOwners()) ensureOwner(state, o.key, o.name);
        // A branch copies the metadata of the whole chat: roll back to the branch point.
        const length = ctx().chat.length;
        if (state.last !== null && state.last >= length) onMessageDeleted(length);
    }
    updateInjection();
    if (ui) {
        ui.selected = null;
        ui.activeOwner = null;
        ui.view = 'inv';
        ui.render();
    }
    if (settings.showHotbar && settings.enabled) hud?.mount();
    hud?.render();
}

/** Called by SillyTavern before every generation (see manifest.json). */
globalThis.inventoryUIInterceptor = async function (_chat, _contextSize, _abort, type) {
    if (!settings?.enabled) return;
    if (type === 'quiet') return;
    if (settings.waitBeforeGenerate && pendingJobs > 0) {
        const timeout = Math.max(5, Number(settings.waitTimeout) || 60) * 1000;
        const note = toastr.info(t('busy_wait'), '', { timeOut: 0, extendedTimeOut: 0 });
        try {
            await Promise.race([queue, new Promise(resolve => setTimeout(resolve, timeout))]);
        } finally {
            toastr.clear(note);
        }
    }
    updateInjection();
};

// ---------- Manual actions ----------

function lastTrackableId() {
    const chat = ctx().chat;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (isTrackable(chat[i])) return i;
    }
    return -1;
}

function rescanLast() {
    const id = lastTrackableId();
    if (id < 0) return;
    if (!settings.profileId) toastr.info(t('no_profile_warning'));
    enqueue(id, { manual: true });
}

async function scanHistory() {
    const chat = ctx().chat;
    if (!chat.length) return;
    const count = Number(settings.historyMessages) || 30;
    if (ui && !(await ui.confirm(t('confirm_scan', Math.min(count, chat.length))))) return;
    enqueue(chat.length - 1, { fullScan: true, manual: true });
}

function openSettingsDrawer() {
    const button = document.querySelector('#extensions-settings-button .drawer-toggle');
    const drawer = document.getElementById('ivui_settings');
    const panel = document.getElementById('rm_extensions_block');
    if (button && panel && !panel.classList.contains('openDrawer')) button.click();
    const content = drawer?.querySelector('.inline-drawer-content');
    if (content && getComputedStyle(content).display === 'none') {
        drawer.querySelector('.inline-drawer-toggle')?.click();
    }
    setTimeout(() => drawer?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
}

function openPanel(selection) {
    ui.open();
    if (selection) {
        ui.activeOwner = selection.ownerKey;
        ui.view = 'inv';
        ui.render();
        ui.select(selection);
    }
}

// ---------- Settings UI ----------

function translateSettings(root) {
    root.querySelectorAll('[data-ivui-t]').forEach((el) => {
        el.textContent = t(el.getAttribute('data-ivui-t'));
    });
}

async function renderSettings() {
    const response = await fetch(`${EXTENSION_URL}/settings.html`);
    const html = await response.text();
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    host.insertAdjacentHTML('beforeend', html);
    const root = document.getElementById('ivui_settings');

    translateSettings(root);

    // jQuery handlers also fire for programmatic .trigger('change') calls used around SillyTavern.
    const bindCheckbox = (id, key, after) => {
        const el = root.querySelector(`#${id}`);
        el.checked = !!settings[key];
        $(el).on('change', () => {
            settings[key] = el.checked;
            saveSettings();
            after?.();
        });
    };
    const bindValue = (id, key, { number = false, after } = {}) => {
        const el = root.querySelector(`#${id}`);
        el.value = settings[key];
        $(el).on(el.tagName === 'SELECT' ? 'change' : 'input', () => {
            settings[key] = number ? Number(el.value) : el.value;
            saveSettings();
            after?.();
        });
    };

    bindCheckbox('ivui_enabled', 'enabled', () => {
        updateInjection();
        settings.enabled && settings.showHotbar ? hud.mount() : hud.unmount();
        hud.render();
    });
    bindValue('ivui_language', 'language', {
        after: () => {
            setLanguage(settings.language);
            translateSettings(root);
            populateProfiles();
            const label = document.querySelector('#ivui_menu_button span');
            if (label) label.textContent = t('open_inventory');
            setStatus(idleStatusText());
            ui.render();
            hud.render();
        },
    });
    bindValue('ivui_owners', 'owners', { after: () => commit() });
    bindValue('ivui_max_tokens', 'maxTokens', { number: true });
    bindCheckbox('ivui_auto', 'autoUpdate', () => setStatus(idleStatusText()));
    bindValue('ivui_every', 'updateEvery', { number: true });
    bindCheckbox('ivui_greeting', 'scanGreeting');
    bindCheckbox('ivui_on_edit', 'rescanOnEdit');
    bindValue('ivui_max_new', 'maxNewMessages', { number: true });
    bindValue('ivui_context', 'contextMessages', { number: true });
    bindValue('ivui_history', 'historyMessages', { number: true });
    bindCheckbox('ivui_wait', 'waitBeforeGenerate');
    bindValue('ivui_wait_timeout', 'waitTimeout', { number: true });
    bindValue('ivui_tracker_prompt', 'trackerPrompt');
    bindCheckbox('ivui_inject', 'injectEnabled', updateInjection);
    bindValue('ivui_inject_position', 'injectPosition', { number: true, after: updateInjection });
    bindValue('ivui_inject_depth', 'injectDepth', { number: true, after: updateInjection });
    bindValue('ivui_inject_role', 'injectRole', { number: true, after: updateInjection });
    bindCheckbox('ivui_inject_desc', 'injectDescriptions', updateInjection);
    bindValue('ivui_inject_template', 'injectTemplate', { after: updateInjection });
    bindCheckbox('ivui_hotbar', 'showHotbar', () => {
        settings.showHotbar && settings.enabled ? hud.mount() : hud.unmount();
        hud.render();
    });
    bindCheckbox('ivui_toasts', 'showToasts');
    bindCheckbox('ivui_errors', 'showErrors');
    bindCheckbox('ivui_pixel_font', 'pixelFont', applyAppearance);
    bindCheckbox('ivui_confirm_delete', 'confirmDelete');
    bindValue('ivui_slot_size', 'slotSize', { number: true, after: applyAppearance });
    bindValue('ivui_bag_rows', 'bagRows', { number: true, after: () => ui.render() });

    root.querySelector('#ivui_tracker_prompt_reset').addEventListener('click', () => {
        settings.trackerPrompt = DEFAULT_TRACKER_PROMPT;
        root.querySelector('#ivui_tracker_prompt').value = settings.trackerPrompt;
        saveSettings();
    });
    root.querySelector('#ivui_inject_template_reset').addEventListener('click', () => {
        settings.injectTemplate = DEFAULT_INJECT_TEMPLATE;
        root.querySelector('#ivui_inject_template').value = settings.injectTemplate;
        saveSettings();
        updateInjection();
    });
    root.querySelector('#ivui_open').addEventListener('click', () => ui.open());
    root.querySelector('#ivui_rescan').addEventListener('click', () => rescanLast());
    root.querySelector('#ivui_scan_history').addEventListener('click', () => scanHistory());
    root.querySelector('#ivui_preview').addEventListener('click', () => {
        const list = inventoryText();
        const text = settings.injectTemplate.replace(/\{\{inventory\}\}/gi, () => list);
        const c = ctx();
        const html = `<pre style="white-space:pre-wrap;text-align:left">${$('<div>').text(c.substituteParams(text)).html()}</pre>`;
        c.callGenericPopup ? c.callGenericPopup(html, c.POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true }) : alert(text);
    });

    // Connection profile dropdown. Built here instead of ConnectionManagerRequestService.handleDropdown,
    // which does not show profiles created after page load when the list started empty.
    const select = root.querySelector('#ivui_profile');
    $(select).on('change', () => {
        settings.profileId = select.value;
        saveSettings();
    });
    $(select).on('focus', populateProfiles);
    populateProfiles();
    const { eventSource, eventTypes } = ctx();
    for (const name of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED']) {
        if (eventTypes[name]) eventSource.on(eventTypes[name], () => populateProfiles());
    }
}

function supportedProfiles() {
    const c = ctx();
    const service = c.ConnectionManagerRequestService;
    if (!service || c.extensionSettings.disabledExtensions?.includes('connection-manager')) return null;
    const profiles = c.extensionSettings.connectionManager?.profiles ?? [];
    return profiles.filter((p) => {
        try {
            return service.isProfileSupported ? service.isProfileSupported(p) : true;
        } catch {
            return false;
        }
    });
}

function populateProfiles() {
    const select = document.getElementById('ivui_profile');
    const note = document.getElementById('ivui_profile_missing');
    if (!select) return;
    const profiles = supportedProfiles();
    note.hidden = profiles !== null;
    select.disabled = profiles === null;
    select.innerHTML = '';
    const main = document.createElement('option');
    main.value = '';
    main.textContent = t('profile_main_api');
    select.appendChild(main);
    for (const profile of [...(profiles ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name;
        select.appendChild(option);
    }
    if (settings.profileId && !profiles?.some(p => p.id === settings.profileId)) {
        settings.profileId = '';
        saveSettings();
    }
    select.value = settings.profileId;
}

function addMenuButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('ivui_menu_button')) return;
    const item = document.createElement('div');
    item.id = 'ivui_menu_button';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-box-open extensionsMenuExtensionButton"></div><span></span>';
    item.querySelector('span').textContent = t('open_inventory');
    item.addEventListener('click', () => ui.toggle());
    menu.appendChild(item);
}

// ---------- Slash commands & macros ----------

function registerCommands() {
    const c = ctx();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = c;
    if (!SlashCommandParser || !SlashCommand) return;

    const ownerKeyByName = (name) => {
        const owners = getOwners();
        if (!name) return owners[0]?.key;
        const n = String(name).toLowerCase();
        return owners.find(o => o.name.toLowerCase() === n || o.key === name)?.key ?? null;
    };

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'inventory',
        aliases: ['inv'],
        helpString: 'Opens or closes the Inventory UI window. Use <code>/inventory open</code>, <code>close</code> or <code>toggle</code>.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'open | close | toggle', typeList: [ARGUMENT_TYPE.STRING], isRequired: false, enumList: ['open', 'close', 'toggle'] }),
        ],
        callback: (_args, value) => {
            const v = String(value ?? '').trim();
            if (v === 'open') ui.open();
            else if (v === 'close') ui.close();
            else ui.toggle();
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'inventory-scan',
        helpString: 'Re-analyzes the last message with the inventory tracker. <code>/inventory-scan history</code> builds the inventory from recent chat history.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'history', typeList: [ARGUMENT_TYPE.STRING], isRequired: false }),
        ],
        callback: async (_args, value) => {
            const chat = ctx().chat;
            if (String(value ?? '').trim() === 'history') {
                await enqueue(chat.length - 1, { fullScan: true, manual: true });
            } else {
                const id = lastTrackableId();
                if (id >= 0) await enqueue(id, { manual: true });
            }
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'inventory-add',
        helpString: 'Adds an item. Example: <code>/inventory-add qty=3 owner=Alex where=bag icon=apple Apple</code>',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'qty', description: 'quantity', typeList: [ARGUMENT_TYPE.NUMBER], defaultValue: '1' }),
            SlashCommandNamedArgument.fromProps({ name: 'owner', description: 'character name', typeList: [ARGUMENT_TYPE.STRING] }),
            SlashCommandNamedArgument.fromProps({ name: 'where', description: 'head, chest, legs, feet, main, off, hotbar, bag', typeList: [ARGUMENT_TYPE.STRING] }),
            SlashCommandNamedArgument.fromProps({ name: 'icon', description: 'icon key or emoji', typeList: [ARGUMENT_TYPE.STRING] }),
            SlashCommandNamedArgument.fromProps({ name: 'rarity', description: 'common, uncommon, rare, epic, legendary', typeList: [ARGUMENT_TYPE.STRING] }),
            SlashCommandNamedArgument.fromProps({ name: 'desc', description: 'description', typeList: [ARGUMENT_TYPE.STRING] }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'item name', typeList: [ARGUMENT_TYPE.STRING], isRequired: true }),
        ],
        callback: (args, value) => {
            const name = String(value ?? '').trim();
            const key = ownerKeyByName(args.owner);
            if (!name || !key) return '';
            mutate((state) => {
                const owner = state.owners[key];
                if (!owner) return false;
                const qty = Math.max(1, clampQty(args.qty, 1));
                const existing = findByName(owner, name);
                if (existing) {
                    existing.qty += qty;
                    return;
                }
                const slot = resolveWhere(owner, args.where) ?? firstFreeSlot(owner, 'bag');
                owner.items.push(normalizeItem({ name, qty, slot, icon: args.icon, rarity: args.rarity, desc: args.desc }));
            });
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'inventory-remove',
        helpString: 'Removes an item (or some of it). Example: <code>/inventory-remove qty=1 Apple</code>',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'qty', description: 'quantity (all by default)', typeList: [ARGUMENT_TYPE.NUMBER] }),
            SlashCommandNamedArgument.fromProps({ name: 'owner', description: 'character name', typeList: [ARGUMENT_TYPE.STRING] }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'item name', typeList: [ARGUMENT_TYPE.STRING], isRequired: true }),
        ],
        callback: (args, value) => {
            const name = String(value ?? '').trim();
            const key = ownerKeyByName(args.owner);
            if (!name || !key) return '';
            mutate((state) => {
                const owner = state.owners[key];
                const item = findByName(owner, name);
                if (!item) return false;
                const qty = args.qty ? Math.max(1, clampQty(args.qty, 1)) : Infinity;
                if (qty >= item.qty) owner.items = owner.items.filter(x => x !== item);
                else item.qty -= qty;
            });
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'inventory-get',
        helpString: 'Returns the current inventory as text (or JSON with <code>format=json</code>).',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'format', description: 'text | json', typeList: [ARGUMENT_TYPE.STRING], defaultValue: 'text', enumList: ['text', 'json'] }),
        ],
        returns: 'inventory',
        callback: (args) => {
            const state = getState();
            if (!state) return '';
            if (args.format === 'json') return JSON.stringify(state.owners);
            return inventoryText(state);
        },
    }));
}

function registerMacro() {
    const c = ctx();
    const handler = () => inventoryText();
    try {
        if (c.macros?.register && c.powerUserSettings?.experimental_macro_engine) {
            c.macros.register('inventory', {
                handler,
                category: c.macros.category?.MISC,
                description: 'Current inventory tracked by Inventory UI.',
                returns: 'Inventory text',
                exampleUsage: '{{inventory}}',
            });
        } else {
            c.registerMacro('inventory', handler, 'Current inventory tracked by Inventory UI.');
        }
    } catch (error) {
        console.warn('[Inventory UI] Could not register the {{inventory}} macro', error);
    }
}

// ---------- Init ----------

async function init() {
    loadSettings();
    setLanguage(settings.language);
    applyTextures();
    applyAppearance();

    try {
        personaModule = await import('../../../personas.js');
    } catch {
        personaModule = null;
    }

    ui = new InventoryUI({
        getState,
        getOwners,
        getSettings: () => settings,
        mutate,
        undo,
        canUndo: () => undoStack.length > 0,
        rescan: rescanLast,
        scanHistory,
        getStatus: () => status,
        savePanelState: (open) => {
            settings.panelOpen = open;
            saveSettings();
        },
        replaceState,
        openSettings: openSettingsDrawer,
    });
    ui.mount();

    hud = new HotbarHud({
        getState,
        getOwners,
        getStatus: () => status,
        open: (sel) => openPanel(sel),
    });
    if (settings.enabled && settings.showHotbar) hud.mount();

    try {
        await renderSettings();
    } catch (error) {
        console.error('[Inventory UI] Failed to render settings', error);
    }
    addMenuButton();
    registerCommands();
    registerMacro();

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(eventTypes.MESSAGE_SWIPED, onMessageSwiped);
    eventSource.on(eventTypes.MESSAGE_DELETED, onMessageDeleted);
    eventSource.on(eventTypes.MESSAGE_EDITED, onMessageEdited);
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    if (eventTypes.MESSAGE_SWIPE_DELETED) eventSource.on(eventTypes.MESSAGE_SWIPE_DELETED, onSwipeDeleted);
    if (eventTypes.GROUP_UPDATED) eventSource.on(eventTypes.GROUP_UPDATED, () => commit());
    if (eventTypes.PERSONA_CHANGED) eventSource.on(eventTypes.PERSONA_CHANGED, () => commit());

    setStatus(idleStatusText());
    onChatChanged();
    if (settings.panelOpen) ui.open();
}

jQuery(async () => {
    try {
        await init();
    } catch (error) {
        console.error('[Inventory UI] Initialization failed', error);
    }
});
