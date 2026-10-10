// Inventory data model.
//
// Chat state (stored in chat metadata):
// {
//   version: 1,
//   owners: { [ownerKey]: { name, items: Item[] } },
//   last: number|null,          // last message id the tracker has analyzed
//   checkpoints: { [mesId]: { prevLast, active, swipes: { [swipeId]: { records, log } } } },
//   log: LogEntry[],
// }
//
// Item: { id, name, qty, icon, rarity, desc, slot, locked }
// Slot: 'head' | 'chest' | 'legs' | 'feet' | 'main' | 'off' | 'hot:N' | 'bag:N'

export const EQUIP_SLOTS = ['head', 'chest', 'legs', 'feet', 'main', 'off'];
export const HOTBAR_SIZE = 9;
export const BAG_COLS = 9;
export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
export const MAX_LOG = 60;
export const MAX_CHECKPOINTS = 40;

export function createEmptyState() {
    return { version: 1, owners: {}, last: null, checkpoints: {}, log: [] };
}

export function uid() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID().slice(0, 8);
    return Math.random().toString(36).slice(2, 10);
}

export function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function normName(name) {
    return String(name ?? '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[«»"'`.,!?:;()[\]{}]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function clampQty(qty, fallback = 1) {
    const n = Math.floor(Number(qty));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(n, 999999));
}

export function normalizeItem(raw) {
    const rarity = String(raw?.rarity ?? 'common').toLowerCase();
    return {
        id: String(raw?.id || uid()),
        name: String(raw?.name ?? '???').trim().slice(0, 80) || '???',
        qty: Math.max(1, clampQty(raw?.qty ?? raw?.quantity, 1)),
        icon: String(raw?.icon ?? '').trim().slice(0, 32),
        rarity: RARITIES.includes(rarity) ? rarity : 'common',
        desc: String(raw?.desc ?? raw?.description ?? '').trim().slice(0, 400),
        slot: typeof raw?.slot === 'string' ? raw.slot : '',
        locked: !!raw?.locked,
    };
}

export function ensureOwner(state, key, name) {
    if (!state.owners[key]) {
        state.owners[key] = { name: name || key, items: [] };
    } else if (name) {
        state.owners[key].name = name;
    }
    return state.owners[key];
}

export function getItem(state, ownerKey, id) {
    return state.owners[ownerKey]?.items.find(x => x.id === id) ?? null;
}

/** Finds an item by id across all owners. */
export function locateItem(state, id) {
    for (const [key, owner] of Object.entries(state.owners)) {
        const item = owner.items.find(x => x.id === id);
        if (item) return { ownerKey: key, owner, item };
    }
    return null;
}

export function findByName(owner, name) {
    const n = normName(name);
    if (!n || !owner) return null;
    return owner.items.find(x => normName(x.name) === n) ?? null;
}

// ---------- Slots ----------

export function parseSlot(slot) {
    if (EQUIP_SLOTS.includes(slot)) return { area: 'equip', index: EQUIP_SLOTS.indexOf(slot), slot };
    const m = /^(hot|bag):(\d+)$/.exec(String(slot));
    if (m) return { area: m[1], index: Number(m[2]), slot };
    return { area: 'none', index: -1, slot };
}

export function isSlotFree(owner, slot, exceptId = null) {
    return !owner.items.some(x => x.slot === slot && x.id !== exceptId);
}

export function bagRowsFor(owner, minRows) {
    let maxIndex = -1;
    for (const item of owner.items) {
        const p = parseSlot(item.slot);
        if (p.area === 'bag') maxIndex = Math.max(maxIndex, p.index);
    }
    return Math.max(minRows, Math.ceil((maxIndex + 1) / BAG_COLS));
}

export function firstFreeSlot(owner, area) {
    if (area === 'hot') {
        for (let i = 0; i < HOTBAR_SIZE; i++) {
            if (isSlotFree(owner, `hot:${i}`)) return `hot:${i}`;
        }
        return null;
    }
    for (let i = 0; i < 10000; i++) {
        if (isSlotFree(owner, `bag:${i}`)) return `bag:${i}`;
    }
    return null;
}

const WHERE_ALIASES = {
    hand: 'main', hands: 'main', mainhand: 'main', main_hand: 'main', right_hand: 'main',
    offhand: 'off', off_hand: 'off', left_hand: 'off',
    body: 'chest', torso: 'chest', armor: 'chest',
    pants: 'legs', shoes: 'feet', boots: 'feet', hat: 'head',
    hotbar: 'hot', pocket: 'hot', pockets: 'hot', belt: 'hot', quick: 'hot',
    backpack: 'bag', inventory: 'bag',
};

/** Normalizes a "where" hint to an equipment slot name, 'hot' or 'bag'. */
export function whereTarget(where) {
    const w = String(where ?? '').toLowerCase().trim();
    const target = WHERE_ALIASES[w] ?? w;
    if (EQUIP_SLOTS.includes(target) || target === 'hot') return target;
    return 'bag';
}

/** Converts the tracker's "where" hint to a concrete free slot. */
export function resolveWhere(owner, where, exceptId = null) {
    const target = whereTarget(where);
    if (EQUIP_SLOTS.includes(target)) {
        return isSlotFree(owner, target, exceptId) ? target : null;
    }
    if (target === 'hot') return firstFreeSlot(owner, 'hot') ?? firstFreeSlot(owner, 'bag');
    return firstFreeSlot(owner, 'bag');
}

/** Ensures every item has a valid unique slot. */
export function repairSlots(owner) {
    const used = new Set();
    for (const item of owner.items) {
        const p = parseSlot(item.slot);
        if (p.area === 'none' || (p.area === 'hot' && p.index >= HOTBAR_SIZE) || used.has(item.slot)) {
            item.slot = '';
        } else {
            used.add(item.slot);
        }
    }
    for (const item of owner.items) {
        if (!item.slot) {
            item.slot = firstFreeSlot(owner, 'bag');
        }
    }
}

// ---------- Journal ----------
// Every automatic change is recorded as a list of primitive, reversible records.
// They let a swipe / regeneration / deletion undo exactly what the tracker did,
// without discarding manual edits made by the user in the meantime.

function insertItem(state, ownerKey, item) {
    const owner = state.owners[ownerKey] ?? ensureOwner(state, ownerKey, ownerKey);
    if (owner.items.some(x => x.id === item.id)) return;
    const copy = clone(item);
    if (!copy.slot || !isSlotFree(owner, copy.slot)) {
        copy.slot = firstFreeSlot(owner, 'bag');
    }
    owner.items.push(copy);
}

function dropItem(state, ownerKey, id) {
    const owner = state.owners[ownerKey];
    if (!owner) return;
    owner.items = owner.items.filter(x => x.id !== id);
}

function applyRecord(state, r, forward) {
    switch (r.t) {
        case 'create':
            forward ? insertItem(state, r.o, r.item) : dropItem(state, r.o, r.item.id);
            break;
        case 'delete':
            forward ? dropItem(state, r.o, r.item.id) : insertItem(state, r.o, r.item);
            break;
        case 'qty': {
            const item = getItem(state, r.o, r.id);
            if (!item) break;
            item.qty += forward ? r.d : -r.d;
            if (item.qty <= 0) dropItem(state, r.o, r.id);
            break;
        }
        case 'set': {
            const item = getItem(state, r.o, r.id);
            if (!item) break;
            const from = forward ? r.a : r.b;
            const to = forward ? r.b : r.a;
            if (item[r.f] !== from && r.f !== 'slot') break;
            if (r.f === 'slot') {
                const owner = state.owners[r.o];
                item.slot = isSlotFree(owner, to, item.id) ? to : (item.slot || firstFreeSlot(owner, 'bag'));
            } else {
                item[r.f] = to;
            }
            break;
        }
    }
}

export function revertRecords(state, records) {
    for (let i = records.length - 1; i >= 0; i--) applyRecord(state, records[i], false);
}

export function replayRecords(state, records) {
    for (const r of records) applyRecord(state, r, true);
}

/**
 * Applies primitive mutations while recording them.
 */
export class Mutator {
    constructor(state) {
        this.state = state;
        this.records = [];
        this.log = [];
    }

    create(ownerKey, raw) {
        const owner = this.state.owners[ownerKey];
        const item = normalizeItem(raw);
        item.slot = (raw.slot && isSlotFree(owner, raw.slot)) ? raw.slot : firstFreeSlot(owner, 'bag');
        owner.items.push(item);
        this.records.push({ t: 'create', o: ownerKey, item: clone(item) });
        return item;
    }

    remove(ownerKey, item, qty = Infinity) {
        if (qty >= item.qty) {
            this.records.push({ t: 'delete', o: ownerKey, item: clone(item) });
            dropItem(this.state, ownerKey, item.id);
            return item.qty;
        }
        item.qty -= qty;
        this.records.push({ t: 'qty', o: ownerKey, id: item.id, d: -qty });
        return qty;
    }

    addQty(ownerKey, item, qty) {
        if (!qty) return;
        item.qty += qty;
        this.records.push({ t: 'qty', o: ownerKey, id: item.id, d: qty });
    }

    set(ownerKey, item, field, value) {
        if (item[field] === value) return false;
        this.records.push({ t: 'set', o: ownerKey, id: item.id, f: field, a: item[field], b: value });
        item[field] = value;
        return true;
    }

    note(entry) {
        this.log.push(entry);
    }
}

// ---------- Tracker ops ----------

const ADD_OPS = ['add', 'gain', 'get', 'obtain', 'pick', 'pickup', 'receive', 'take', 'buy', 'craft', 'create', 'found'];
const REMOVE_OPS = ['remove', 'use', 'consume', 'eat', 'drink', 'lose', 'lost', 'drop', 'delete', 'sell', 'destroy', 'break', 'spend'];
const UPDATE_OPS = ['update', 'set', 'modify', 'change', 'edit', 'move', 'equip', 'unequip', 'wear', 'hold', 'rename'];
const GIVE_OPS = ['give', 'transfer', 'hand', 'pass'];

const EQUIP_GUESS = {
    helmet: 'head', hat: 'head', glasses: 'head',
    chestplate: 'chest', shirt: 'chest', necklace: 'chest',
    leggings: 'legs', boots: 'feet', shield: 'off',
};

/**
 * Applies tracker changes to the state.
 * @param {object} state chat state
 * @param {any[]} changes raw changes from the model
 * @param {{ owners: {key: string, name: string}[], refs: Map<number, {ownerKey: string, id: string}>, mesId?: number }} ctx
 * @returns {{ records: any[], log: any[] }}
 */
export function applyChanges(state, changes, ctx) {
    const m = new Mutator(state);
    const owners = ctx.owners;
    for (const o of owners) ensureOwner(state, o.key, o.name);

    const resolveOwner = (name, fallback) => {
        if (name === undefined || name === null || name === '') return fallback;
        const n = normName(name);
        const exact = owners.find(o => normName(o.name) === n || o.key === name);
        if (exact) return exact.key;
        const partial = owners.find(o => {
            const on = normName(o.name);
            return on && n && (on.includes(n) || n.includes(on) || on.split(' ')[0] === n.split(' ')[0]);
        });
        if (partial) return partial.key;
        if (/^(user|\{\{user\}\}|player|you)$/i.test(String(name).trim())) {
            return owners.find(o => o.key === 'user')?.key ?? null;
        }
        if (/^(char|\{\{char\}\})$/i.test(String(name).trim())) {
            return owners.find(o => o.key !== 'user')?.key ?? null;
        }
        return null;
    };

    const resolveItem = (change, ownerKey) => {
        const ref = change.id ?? change.ref ?? change.item_id;
        if (ref !== undefined && ref !== null && ref !== '') {
            const num = Number(String(ref).replace(/[^\d]/g, ''));
            const hit = ctx.refs.get(num);
            if (hit) {
                const item = getItem(state, hit.ownerKey, hit.id);
                if (item) return { ownerKey: hit.ownerKey, item };
            }
        }
        const name = change.name ?? change.item;
        if (!name) return null;
        const keys = ownerKey ? [ownerKey, ...owners.map(o => o.key).filter(k => k !== ownerKey)] : owners.map(o => o.key);
        for (const key of keys) {
            const item = findByName(state.owners[key], name);
            if (item) return { ownerKey: key, item };
        }
        return null;
    };

    const defaultOwner = owners.find(o => o.key !== 'user')?.key ?? owners[0]?.key;

    // Finds a slot for "where"; an occupied equipment slot is freed by moving its item to the bag.
    const placeAt = (ownerKey, where, exceptId = null) => {
        const owner = state.owners[ownerKey];
        const slot = resolveWhere(owner, where, exceptId);
        if (slot) return slot;
        const target = whereTarget(where);
        const occupant = owner.items.find(x => x.slot === target && x.id !== exceptId);
        if (occupant && !occupant.locked) {
            m.set(ownerKey, occupant, 'slot', firstFreeSlot(owner, 'bag'));
            return target;
        }
        return firstFreeSlot(owner, 'bag');
    };

    for (const change of Array.isArray(changes) ? changes : []) {
        if (!change || typeof change !== 'object') continue;
        const op = String(change.op ?? change.action ?? change.type ?? '').toLowerCase().trim();
        const ownerName = change.owner ?? change.character ?? change.who;
        const ownerKey = resolveOwner(ownerName, defaultOwner);
        try {
            if (ADD_OPS.includes(op)) {
                if (!ownerKey) continue;
                const owner = state.owners[ownerKey];
                const qty = Math.max(1, clampQty(change.qty ?? change.quantity ?? change.count, 1));
                const name = String(change.name ?? change.item ?? '').trim();
                if (!name) continue;
                const existing = findByName(owner, name);
                if (existing) {
                    if (existing.locked) continue;
                    m.addQty(ownerKey, existing, qty);
                    if (change.desc) m.set(ownerKey, existing, 'desc', String(change.desc).slice(0, 400));
                    m.note({ k: 'add', o: owner.name, n: existing.name, q: qty, i: existing.icon });
                    continue;
                }
                const where = change.where ?? change.slot ?? change.location;
                const slot = placeAt(ownerKey, where);
                const item = m.create(ownerKey, { ...change, id: undefined, locked: false, name, qty, slot });
                m.note({ k: 'add', o: owner.name, n: item.name, q: qty, i: item.icon });
            } else if (REMOVE_OPS.includes(op)) {
                const hit = resolveItem(change, ownerKey);
                if (!hit || hit.item.locked) continue;
                const owner = state.owners[hit.ownerKey];
                const raw = change.qty ?? change.quantity ?? change.count;
                const qty = raw === undefined || raw === null || raw === 'all' ? Infinity : Math.max(1, clampQty(raw, 1));
                const name = hit.item.name;
                const icon = hit.item.icon;
                const removed = m.remove(hit.ownerKey, hit.item, qty);
                m.note({ k: 'remove', o: owner.name, n: name, q: removed, i: icon });
            } else if (UPDATE_OPS.includes(op)) {
                const hit = resolveItem(change, ownerKey);
                if (!hit || hit.item.locked) continue;
                const { item } = hit;
                const owner = state.owners[hit.ownerKey];
                let changed = false;
                const newName = change.new_name ?? change.rename ?? change.newName;
                if (newName) changed = m.set(hit.ownerKey, item, 'name', String(newName).trim().slice(0, 80)) || changed;
                if (change.desc !== undefined) changed = m.set(hit.ownerKey, item, 'desc', String(change.desc).trim().slice(0, 400)) || changed;
                if (change.icon) changed = m.set(hit.ownerKey, item, 'icon', String(change.icon).trim().slice(0, 32)) || changed;
                if (change.rarity && RARITIES.includes(String(change.rarity).toLowerCase())) {
                    changed = m.set(hit.ownerKey, item, 'rarity', String(change.rarity).toLowerCase()) || changed;
                }
                const qtyRaw = change.qty ?? change.quantity ?? change.count;
                if (qtyRaw !== undefined && qtyRaw !== null) {
                    const qty = clampQty(qtyRaw, item.qty);
                    if (qty <= 0) {
                        const name = item.name;
                        m.remove(hit.ownerKey, item);
                        m.note({ k: 'remove', o: owner.name, n: name, q: item.qty, i: item.icon });
                        continue;
                    }
                    if (qty !== item.qty) {
                        const delta = qty - item.qty;
                        m.addQty(hit.ownerKey, item, delta);
                        m.note({ k: delta > 0 ? 'add' : 'remove', o: owner.name, n: item.name, q: Math.abs(delta), i: item.icon });
                    }
                }
                let where = change.where ?? change.slot ?? change.location;
                if (!where && (op === 'equip' || op === 'wear' || op === 'hold')) {
                    where = EQUIP_GUESS[item.icon] ?? 'main';
                }
                if (!where && op === 'unequip') where = 'bag';
                if (where) {
                    const current = parseSlot(item.slot);
                    const target = whereTarget(where);
                    const sameArea = target === current.area || target === item.slot;
                    if (!sameArea) {
                        const slot = placeAt(hit.ownerKey, where, item.id);
                        if (slot && slot !== item.slot) {
                            m.set(hit.ownerKey, item, 'slot', slot);
                            m.note({ k: 'move', o: owner.name, n: item.name, q: item.qty, i: item.icon, w: slot });
                            continue;
                        }
                    }
                }
                if (changed) m.note({ k: 'update', o: owner.name, n: item.name, q: item.qty, i: item.icon });
            } else if (GIVE_OPS.includes(op)) {
                const hit = resolveItem(change, ownerKey);
                if (!hit || hit.item.locked) continue;
                const toKey = resolveOwner(change.to ?? change.target ?? change.recipient, null);
                const fromOwner = state.owners[hit.ownerKey];
                const raw = change.qty ?? change.quantity ?? change.count;
                const qty = raw === undefined || raw === null || raw === 'all' ? Infinity : Math.max(1, clampQty(raw, 1));
                const snapshot = clone(hit.item);
                const moved = m.remove(hit.ownerKey, hit.item, qty);
                if (toKey && toKey !== hit.ownerKey) {
                    const toOwner = state.owners[toKey];
                    const existing = findByName(toOwner, snapshot.name);
                    if (existing) {
                        m.addQty(toKey, existing, moved);
                    } else {
                        m.create(toKey, { ...snapshot, id: uid(), qty: moved, slot: firstFreeSlot(toOwner, 'bag') });
                    }
                    m.note({ k: 'give', o: fromOwner.name, n: snapshot.name, q: moved, i: snapshot.icon, to: toOwner.name });
                } else {
                    m.note({ k: 'remove', o: fromOwner.name, n: snapshot.name, q: moved, i: snapshot.icon, to: change.to ? String(change.to) : undefined });
                }
            }
        } catch (error) {
            console.warn('[Inventory UI] Failed to apply change', change, error);
        }
    }

    return { records: m.records, log: m.log };
}

/**
 * Builds numeric references (#1, #2...) for items so the tracker can point at them.
 * @returns {{ refs: Map<number, {ownerKey: string, id: string}>, byId: Map<string, number> }}
 */
export function buildRefs(state, ownerKeys) {
    const refs = new Map();
    const byId = new Map();
    let n = 1;
    for (const key of ownerKeys) {
        const owner = state.owners[key];
        if (!owner) continue;
        for (const item of sortItems(owner.items)) {
            refs.set(n, { ownerKey: key, id: item.id });
            byId.set(item.id, n);
            n++;
        }
    }
    return { refs, byId };
}

const AREA_ORDER = { equip: 0, hot: 1, bag: 2, none: 3 };

export function sortItems(items) {
    return [...items].sort((a, b) => {
        const pa = parseSlot(a.slot);
        const pb = parseSlot(b.slot);
        return (AREA_ORDER[pa.area] - AREA_ORDER[pb.area]) || (pa.index - pb.index);
    });
}

export function pushLog(state, entries, mesId) {
    if (!entries?.length) return;
    const time = Date.now();
    for (const e of entries) state.log.push({ ...e, m: mesId ?? null, at: time });
    if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

export function pruneCheckpoints(state) {
    const ids = Object.keys(state.checkpoints).map(Number).sort((a, b) => a - b);
    while (ids.length > MAX_CHECKPOINTS) {
        delete state.checkpoints[ids.shift()];
    }
}

/**
 * Validates and repairs a state loaded from metadata or an import.
 */
export function sanitizeState(raw) {
    const state = createEmptyState();
    if (!raw || typeof raw !== 'object') return state;
    if (raw.owners && typeof raw.owners === 'object') {
        for (const [key, owner] of Object.entries(raw.owners)) {
            if (!owner || typeof owner !== 'object') continue;
            const items = Array.isArray(owner.items) ? owner.items.map(normalizeItem) : [];
            state.owners[key] = { name: String(owner.name ?? key), items };
            repairSlots(state.owners[key]);
        }
    }
    state.last = Number.isInteger(raw.last) ? raw.last : null;
    state.checkpoints = raw.checkpoints && typeof raw.checkpoints === 'object' ? raw.checkpoints : {};
    state.log = Array.isArray(raw.log) ? raw.log.slice(-MAX_LOG) : [];
    return state;
}
