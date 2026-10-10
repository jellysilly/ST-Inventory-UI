// Inventory window, hotbar HUD, tooltips, editor and toasts.

import { spriteUrl, resolveIcon, SPRITE_KEYS, SLOT_HINTS } from './sprites.js';
import {
    EQUIP_SLOTS, HOTBAR_SIZE, BAG_COLS, RARITIES,
    parseSlot, bagRowsFor, firstFreeSlot, findByName, normalizeItem, normName, uid, clone,
} from './state.js';
import { t } from './i18n.js';

const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const LONG_PRESS_MS = 450;
const DRAG_THRESHOLD = 6;

export function iconHtml(item, cls = 'ivui-icon') {
    const icon = resolveIcon(item);
    if (icon.type === 'emoji') return `<span class="${cls} ivui-emoji">${esc(icon.value)}</span>`;
    return `<img class="${cls}" src="${spriteUrl(icon.value)}" alt="" draggable="false">`;
}

function slotLabel(slot) {
    const p = parseSlot(slot);
    if (p.area === 'equip') return t(`slot_${slot}`);
    if (p.area === 'hot') return t('slot_hot');
    return t('slot_bag');
}

function itemHtml(item, ownerKey) {
    const count = item.qty > 1 ? `<span class="ivui-count">${item.qty > 9999 ? '∞' : item.qty}</span>` : '';
    const lock = item.locked ? '<span class="ivui-lock-badge"></span>' : '';
    // The enchantment glint of rare items is masked by the sprite shape.
    const icon = resolveIcon(item);
    const mask = icon.type === 'sprite' && item.rarity !== 'common' && item.rarity !== 'uncommon'
        ? ` style="--ivui-mask:url('${spriteUrl(icon.value)}')"`
        : '';
    return `<div class="ivui-item ivui-r-${item.rarity}" data-id="${esc(item.id)}" data-owner="${esc(ownerKey)}"${mask}>`
        + iconHtml(item) + count + lock + '</div>';
}

// ---------- Portrait pixelation ----------

const portraitCache = new Map();

function pixelate(url) {
    if (!url) return Promise.resolve('');
    if (portraitCache.has(url)) return portraitCache.get(url);
    const promise = new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const w = 30;
                const h = 45;
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                const ratio = w / h;
                let sw = img.naturalWidth;
                let sh = img.naturalHeight;
                let sx = 0;
                let sy = 0;
                if (sw / sh > ratio) {
                    sw = sh * ratio;
                    sx = (img.naturalWidth - sw) / 2;
                } else {
                    sh = sw / ratio;
                    sy = 0;
                }
                ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
                resolve(canvas.toDataURL('image/png'));
            } catch {
                resolve(url);
            }
        };
        img.onerror = () => resolve('');
        img.src = url;
    });
    portraitCache.set(url, promise);
    return promise;
}

// ---------- Toasts ----------

let toastHost = null;

export function showToast(entries) {
    if (!entries?.length) return;
    if (!toastHost) {
        toastHost = document.createElement('div');
        toastHost.className = 'ivui ivui-toasts';
        document.body.appendChild(toastHost);
    }
    const shown = entries.slice(0, 4);
    const rows = shown.map((e) => {
        let text;
        let cls;
        if (e.k === 'add') {
            text = `+${e.q}\u00a0${esc(e.n)}`;
            cls = 'ivui-plus';
        } else if (e.k === 'remove') {
            text = `−${e.q === Infinity ? '' : e.q + '\u00a0'}${esc(e.n)}`;
            cls = 'ivui-minus';
        } else if (e.k === 'give') {
            text = esc(t('given', e.n, e.to));
            cls = 'ivui-give';
        } else if (e.k === 'move') {
            text = esc(t('moved', e.n, slotLabel(e.w)));
            cls = 'ivui-move';
        } else {
            text = esc(e.n);
            cls = 'ivui-move';
        }
        return `<div class="ivui-toast-row ${cls}">${iconHtml({ icon: e.i, name: e.n }, 'ivui-toast-icon')}<span>${text}</span></div>`;
    }).join('');
    const more = entries.length > shown.length ? `<div class="ivui-toast-more">${esc(t('toast_more', entries.length - shown.length))}</div>` : '';
    const el = document.createElement('div');
    el.className = 'ivui-toast';
    el.innerHTML = `<div class="ivui-toast-title">${esc(t('toast_title'))}</div>${rows}${more}`;
    el.addEventListener('click', () => el.remove());
    toastHost.appendChild(el);
    const limit = window.innerWidth < 640 ? 2 : 3;
    while (toastHost.children.length > limit) toastHost.firstElementChild.remove();
    setTimeout(() => el.classList.add('ivui-toast-out'), 4200);
    setTimeout(() => el.remove(), 4700);
}

// ---------- Main window ----------

export class InventoryUI {
    /**
     * @param {object} api
     * @param {() => object|null} api.getState
     * @param {() => {key: string, name: string, avatar?: string, isUser?: boolean}[]} api.getOwners
     * @param {() => object} api.getSettings
     * @param {(fn: (state: object) => (boolean|void)) => boolean} api.mutate
     * @param {() => boolean} api.undo
     * @param {() => boolean} api.canUndo
     * @param {() => void} api.rescan
     * @param {() => void} api.scanHistory
     * @param {() => {busy: boolean, text: string, error: boolean}} api.getStatus
     * @param {() => void} api.savePanelState
     * @param {(state: object) => void} api.replaceState
     * @param {() => void} api.openSettings
     */
    constructor(api) {
        this.api = api;
        this.root = null;
        this.tooltip = null;
        this.activeOwner = null;
        this.selected = null;
        this.filter = '';
        this.view = 'inv';
        this.press = null;
        this.drag = null;
        this.move = null;
        this.onPointerMove = this.onPointerMove.bind(this);
        this.onPointerUp = this.onPointerUp.bind(this);
        this.onKeyDown = this.onKeyDown.bind(this);
    }

    get isOpen() {
        return !!this.root && !this.root.hidden;
    }

    mount() {
        if (this.root) return;
        const root = document.createElement('div');
        root.id = 'ivui-panel';
        root.className = 'ivui ivui-panel';
        root.hidden = true;
        root.innerHTML = `
            <div class="ivui-frame">
                <div class="ivui-header">
                    <div class="ivui-header-text">
                        <div class="ivui-kicker"></div>
                        <div class="ivui-title"></div>
                    </div>
                    <div class="ivui-header-buttons">
                        <button type="button" class="ivui-hbtn" data-act="undo"><i class="fa-solid fa-rotate-left"></i></button>
                        <button type="button" class="ivui-hbtn" data-act="rescan"><i class="fa-solid fa-rotate"></i></button>
                        <button type="button" class="ivui-hbtn" data-act="menu"><i class="fa-solid fa-ellipsis-vertical"></i></button>
                        <button type="button" class="ivui-hbtn" data-act="close"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>
                <div class="ivui-tabs"></div>
                <div class="ivui-content"></div>
                <div class="ivui-info"></div>
                <div class="ivui-status"></div>
            </div>
            <div class="ivui-menu" hidden></div>
            <input type="file" class="ivui-file" accept=".json,application/json" hidden>`;
        document.body.appendChild(root);
        this.root = root;

        // The editor lives outside the window so it is not limited by the window size.
        this.modal = document.createElement('div');
        this.modal.className = 'ivui ivui-modal';
        this.modal.hidden = true;
        document.body.appendChild(this.modal);

        this.tooltip = document.createElement('div');
        this.tooltip.className = 'ivui ivui-tooltip';
        this.tooltip.hidden = true;
        document.body.appendChild(this.tooltip);

        root.addEventListener('click', (e) => this.onClick(e));
        root.addEventListener('pointerdown', (e) => this.onPointerDown(e));
        root.addEventListener('dblclick', (e) => this.onDoubleClick(e));
        root.addEventListener('contextmenu', (e) => this.onContextMenu(e));
        root.addEventListener('pointerover', (e) => this.onHover(e));
        root.addEventListener('pointerout', (e) => this.onHoverOut(e));
        root.addEventListener('input', (e) => this.onInput(e));
        root.querySelector('.ivui-file').addEventListener('change', (e) => this.onImportFile(e));
        document.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('resize', () => this.clampPosition());
    }

    open() {
        this.mount();
        this.root.hidden = false;
        this.render();
        this.applyPosition();
        this.api.savePanelState(true);
    }

    close() {
        if (!this.root) return;
        this.root.hidden = true;
        this.closeModal();
        this.hideTooltip();
        this.cancelDrag();
        this.api.savePanelState(false);
    }

    toggle() {
        this.isOpen ? this.close() : this.open();
    }

    // ---------- Positioning ----------

    applyPosition() {
        const pos = this.api.getSettings().panelPos;
        const narrow = window.innerWidth < 640;
        this.root.classList.toggle('ivui-narrow', narrow);
        this.root.classList.remove('ivui-centered');
        if (narrow) {
            this.root.style.left = '';
            this.root.style.top = '';
            return;
        }
        if (pos) {
            this.root.style.left = `${pos.x}px`;
            this.root.style.top = `${pos.y}px`;
        } else {
            // Center once in pixels: later height changes then grow the window downward
            // instead of shifting the slots under the cursor (which breaks double-clicks).
            const rect = this.root.getBoundingClientRect();
            this.root.style.left = `${Math.max(0, Math.round((window.innerWidth - rect.width) / 2))}px`;
            this.root.style.top = `${Math.max(8, Math.round((window.innerHeight - rect.height) / 2))}px`;
        }
        this.clampPosition();
    }

    clampPosition() {
        if (!this.isOpen) return;
        const narrow = window.innerWidth < 640;
        this.root.classList.toggle('ivui-narrow', narrow);
        if (narrow) {
            this.root.style.maxHeight = '';
            return;
        }
        const rect = this.root.getBoundingClientRect();
        const x = Math.min(Math.max(0, rect.left), Math.max(0, window.innerWidth - rect.width));
        const y = Math.min(Math.max(0, rect.top), Math.max(0, window.innerHeight - 60));
        this.root.style.left = `${x}px`;
        this.root.style.top = `${y}px`;
        this.fitHeight();
    }

    /** Limits the window to the space below its top edge; moves it up when that space is too small. */
    fitHeight() {
        if (!this.isOpen || this.root.classList.contains('ivui-narrow')) return;
        const minUseful = Math.min(420, window.innerHeight - 16);
        let top = this.root.getBoundingClientRect().top;
        if (window.innerHeight - top - 8 < minUseful) {
            top = Math.max(8, window.innerHeight - 8 - minUseful);
            this.root.style.top = `${top}px`;
        }
        this.root.style.maxHeight = `${Math.floor(window.innerHeight - top - 8)}px`;
    }

    // ---------- Data helpers ----------

    owners() {
        return this.api.getOwners();
    }

    currentOwner() {
        const owners = this.owners();
        if (!owners.length) return null;
        if (!owners.some(o => o.key === this.activeOwner)) this.activeOwner = owners[0].key;
        return owners.find(o => o.key === this.activeOwner);
    }

    ownerData(key) {
        return this.api.getState()?.owners?.[key] ?? { name: key, items: [] };
    }

    findItem(ownerKey, id) {
        return this.ownerData(ownerKey).items.find(x => x.id === id) ?? null;
    }

    // ---------- Rendering ----------

    render() {
        if (!this.isOpen) return;
        this.hideTooltip();
        const state = this.api.getState();
        const owners = this.owners();
        const owner = this.currentOwner();
        const kicker = this.root.querySelector('.ivui-kicker');
        const title = this.root.querySelector('.ivui-title');
        kicker.textContent = this.view === 'log' ? t('log') : t('title_kicker');
        title.textContent = owner?.name ?? t('inventory');

        this.root.querySelector('[data-act="undo"]').disabled = !this.api.canUndo();
        this.root.querySelector('[data-act="undo"]').title = t('undo');
        this.root.querySelector('[data-act="rescan"]').title = t('rescan');
        this.root.querySelector('[data-act="menu"]').title = t('menu');
        this.root.querySelector('[data-act="close"]').title = t('close');

        const tabs = this.root.querySelector('.ivui-tabs');
        tabs.hidden = owners.length < 2;
        tabs.innerHTML = owners.map(o => `
            <button type="button" class="ivui-tab ${o.key === this.activeOwner ? 'ivui-tab-active' : ''}" data-act="tab" data-owner="${esc(o.key)}">
                <span class="ivui-tab-avatar" data-avatar="${esc(o.avatar ?? '')}"></span>
                <span class="ivui-tab-name">${esc(o.name)}</span>
                <span class="ivui-tab-count">${state?.owners?.[o.key]?.items.length ?? 0}</span>
            </button>`).join('');
        tabs.querySelectorAll('.ivui-tab-avatar').forEach(el => this.fillAvatar(el, el.dataset.avatar));

        const content = this.root.querySelector('.ivui-content');
        if (!state) {
            content.innerHTML = `<div class="ivui-empty">${esc(t('no_chat'))}</div>`;
        } else if (!owner) {
            content.innerHTML = `<div class="ivui-empty">${esc(t('no_owners'))}</div>`;
        } else if (this.view === 'log') {
            content.innerHTML = this.renderLog(state);
        } else {
            content.innerHTML = this.renderInventory(owner);
            this.fillAvatar(content.querySelector('.ivui-portrait-img'), owner.avatar, true);
            this.applyFilter();
        }
        this.renderInfo();
        this.renderStatus();
        this.fitHeight();
    }

    fillAvatar(el, url, large = false) {
        if (!el) return;
        if (!url) {
            el.classList.add('ivui-noavatar');
            return;
        }
        pixelate(url).then((src) => {
            if (!src) {
                el.classList.add('ivui-noavatar');
                return;
            }
            el.style.backgroundImage = `url("${src}")`;
            if (large) el.classList.add('ivui-has-avatar');
        });
    }

    slotHtml(slot, item, ownerKey, extraClass = '') {
        let inner = '';
        if (item) {
            inner = itemHtml(item, ownerKey);
        } else if (SLOT_HINTS[slot]) {
            inner = `<img class="ivui-hint" src="${spriteUrl(SLOT_HINTS[slot], true)}" alt="" draggable="false">`;
        }
        const sel = item && this.selected?.id === item.id ? ' ivui-selected' : '';
        return `<div class="ivui-slot ${extraClass}${sel}" data-slot="${slot}" title="${item ? '' : esc(slotLabel(slot))}">${inner}</div>`;
    }

    renderInventory(owner) {
        const data = this.ownerData(owner.key);
        const bySlot = new Map(data.items.map(x => [x.slot, x]));
        const settings = this.api.getSettings();
        const rows = bagRowsFor(data, settings.bagRows);
        // Always keep at least one empty slot visible in the bag.
        const bagUsed = data.items.filter(x => parseSlot(x.slot).area === 'bag').length;
        const bagRows = bagUsed >= rows * BAG_COLS ? rows + 1 : rows;

        const armor = ['head', 'chest', 'legs', 'feet'].map(s => this.slotHtml(s, bySlot.get(s), owner.key, 'ivui-slot-equip')).join('');
        const hands = ['main', 'off'].map(s => this.slotHtml(s, bySlot.get(s), owner.key, 'ivui-slot-equip')).join('');
        let bag = '';
        for (let i = 0; i < bagRows * BAG_COLS; i++) bag += this.slotHtml(`bag:${i}`, bySlot.get(`bag:${i}`), owner.key);
        let hot = '';
        for (let i = 0; i < HOTBAR_SIZE; i++) hot += this.slotHtml(`hot:${i}`, bySlot.get(`hot:${i}`), owner.key);
        const total = data.items.reduce((sum, x) => sum + x.qty, 0);

        return `
            <div class="ivui-top">
                <div class="ivui-col">${armor}</div>
                <div class="ivui-portrait"><div class="ivui-portrait-img"></div></div>
                <div class="ivui-col">
                    ${hands}
                    <div class="ivui-col-gap"></div>
                    <div class="ivui-slot ivui-trash" data-trash="1" title="${esc(t('trash'))}"><i class="fa-solid fa-trash-can"></i></div>
                </div>
                <div class="ivui-side">
                    <div class="ivui-stat"><span>${esc(t('items_count'))}</span><b>${total}</b></div>
                    <div class="ivui-stat"><span>${esc(t('slots_used'))}</span><b>${data.items.length}</b></div>
                    <input type="search" class="ivui-search" placeholder="${esc(t('search'))}" value="${esc(this.filter)}">
                    <button type="button" class="ivui-btn ivui-btn-wide" data-act="add" title="${esc(t('add_item'))}"><i class="fa-solid fa-plus"></i> ${esc(t('add'))}</button>
                </div>
            </div>
            <div class="ivui-label">${esc(t('bag'))}</div>
            <div class="ivui-grid">${bag}</div>
            <div class="ivui-label">${esc(t('hotbar'))}</div>
            <div class="ivui-grid ivui-grid-hot">${hot}</div>`;
    }

    renderLog(state) {
        const owners = this.owners();
        const multi = owners.length > 1;
        const entries = [...(state.log ?? [])].reverse();
        if (!entries.length) return `<div class="ivui-empty">${esc(t('log_empty'))}</div>`;
        const rows = entries.map((e) => {
            let text;
            let cls;
            if (e.k === 'add') {
                text = `+${e.q} ${esc(e.n)}`;
                cls = 'ivui-plus';
            } else if (e.k === 'remove') {
                text = `−${e.q} ${esc(e.n)}`;
                cls = 'ivui-minus';
            } else if (e.k === 'give') {
                text = esc(t('given', e.n, e.to));
                cls = 'ivui-give';
            } else if (e.k === 'move') {
                text = esc(t('moved', e.n, slotLabel(e.w)));
                cls = 'ivui-move';
            } else {
                text = `✎ ${esc(e.n)}`;
                cls = 'ivui-move';
            }
            const who = multi && e.o ? `<span class="ivui-log-owner">${esc(e.o)}</span>` : '';
            const mes = e.m !== null && e.m !== undefined ? `<span class="ivui-log-mes">#${e.m}</span>` : '';
            return `<div class="ivui-log-row ${cls}">${iconHtml({ icon: e.i, name: e.n }, 'ivui-log-icon')}<span class="ivui-log-text">${text}</span>${who}${mes}</div>`;
        }).join('');
        return `<div class="ivui-log">${rows}</div>`;
    }

    renderInfo() {
        const info = this.root.querySelector('.ivui-info');
        const owner = this.currentOwner();
        const item = this.selected && owner && this.selected.ownerKey === owner.key ? this.findItem(owner.key, this.selected.id) : null;
        if (this.view === 'log' || !owner) {
            info.hidden = true;
            return;
        }
        info.hidden = false;
        if (!item) {
            this.selected = null;
            info.innerHTML = `<div class="ivui-note"><div class="ivui-note-text ivui-note-hint ivui-muted">${esc(t('hint_empty'))}</div></div>`;
            return;
        }
        const others = this.owners().filter(o => o.key !== owner.key);
        const give = others.length
            ? `<div class="ivui-give-row"><span>${esc(t('give_to'))}:</span>${others.map(o => `<button type="button" class="ivui-btn ivui-btn-sm" data-act="give" data-to="${esc(o.key)}">${esc(o.name)}</button>`).join('')}</div>`
            : '';
        info.innerHTML = `
            <div class="ivui-note">
                <div class="ivui-note-head">
                    ${iconHtml(item, 'ivui-note-icon')}
                    <div class="ivui-note-title">
                        <div class="ivui-note-name ivui-rc-${item.rarity}">${esc(item.name)}${item.qty > 1 ? ` <span class="ivui-note-qty">×${item.qty}</span>` : ''}</div>
                        <div class="ivui-note-meta">${esc(slotLabel(item.slot))} · ${esc(t(`rarity_${item.rarity}`))}${item.locked ? ` · <i class="fa-solid fa-lock"></i>` : ''}</div>
                    </div>
                    <div class="ivui-note-actions">
                        <button type="button" class="ivui-btn ivui-btn-sm" data-act="lock" title="${esc(item.locked ? t('unlock') : t('lock'))}"><i class="fa-solid ${item.locked ? 'fa-lock' : 'fa-lock-open'}"></i></button>
                        <button type="button" class="ivui-btn ivui-btn-sm" data-act="edit" title="${esc(t('edit'))}"><i class="fa-solid fa-pen"></i></button>
                        <button type="button" class="ivui-btn ivui-btn-sm ivui-btn-danger" data-act="delete" title="${esc(t('delete'))}"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </div>
                ${item.desc ? `<div class="ivui-note-text">«${esc(item.desc)}»</div>` : ''}
                ${give}
                <div class="ivui-note-hint ivui-muted">${esc(t('hint_select'))}</div>
            </div>`;
    }

    renderStatus() {
        const status = this.api.getStatus();
        const el = this.root.querySelector('.ivui-status');
        el.innerHTML = `
            <span class="ivui-status-text ${status.error ? 'ivui-status-error' : ''}">
                ${status.busy ? '<span class="ivui-spinner"></span>' : ''}${esc(status.text)}
            </span>
            <button type="button" class="ivui-link" data-act="view">${esc(this.view === 'log' ? t('back') : t('log'))}</button>`;
    }

    updateStatus() {
        if (this.isOpen) this.renderStatus();
    }

    applyFilter() {
        const q = normName(this.filter);
        const owner = this.currentOwner();
        this.root.querySelectorAll('.ivui-content .ivui-item').forEach((el) => {
            if (!q) {
                el.classList.remove('ivui-dim');
                return;
            }
            const item = owner ? this.findItem(owner.key, el.dataset.id) : null;
            const hay = normName(`${item?.name ?? ''} ${item?.desc ?? ''}`);
            el.classList.toggle('ivui-dim', !hay.includes(q));
        });
    }

    // ---------- Tooltip ----------

    showTooltip(item, x, y) {
        const tip = this.tooltip;
        tip.innerHTML = `
            <div class="ivui-tip-name ivui-rc-${item.rarity}">${esc(item.name)}${item.qty > 1 ? ` ×${item.qty}` : ''}</div>
            ${item.desc ? `<div class="ivui-tip-desc">${esc(item.desc)}</div>` : ''}
            <div class="ivui-tip-meta">${esc(slotLabel(item.slot))}${item.locked ? ' · ' + esc(t('locked')) : ''}</div>`;
        tip.hidden = false;
        this.positionTooltip(x, y);
    }

    positionTooltip(x, y) {
        const tip = this.tooltip;
        const rect = tip.getBoundingClientRect();
        let left = x + 14;
        let top = y - rect.height - 10;
        if (left + rect.width > window.innerWidth - 4) left = x - rect.width - 14;
        if (top < 4) top = y + 18;
        tip.style.left = `${Math.max(4, left)}px`;
        tip.style.top = `${Math.max(4, top)}px`;
    }

    hideTooltip() {
        if (this.tooltip) this.tooltip.hidden = true;
    }

    onHover(e) {
        if (e.pointerType !== 'mouse' || this.drag) return;
        const el = e.target.closest?.('.ivui-item');
        if (!el) return;
        const item = this.findItem(el.dataset.owner, el.dataset.id);
        if (item) this.showTooltip(item, e.clientX, e.clientY);
        el.addEventListener('pointermove', this.tooltipFollow ??= (ev) => {
            if (!this.tooltip.hidden) this.positionTooltip(ev.clientX, ev.clientY);
        });
    }

    onHoverOut(e) {
        const el = e.target.closest?.('.ivui-item');
        if (el && !el.contains(e.relatedTarget)) this.hideTooltip();
    }

    // ---------- Input handlers ----------

    onInput(e) {
        if (e.target.classList.contains('ivui-search')) {
            this.filter = e.target.value;
            this.applyFilter();
        }
    }

    onKeyDown(e) {
        if (!this.isOpen) return;
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
        if (e.key === 'Escape') {
            if (!this.modal.hidden) {
                this.closeModal();
            } else if (this.drag) {
                this.cancelDrag();
            } else if (this.selected) {
                this.select(null);
            } else if (!this.root.querySelector('.ivui-menu').hidden) {
                this.closeMenu();
            } else if (!typing) {
                this.close();
            }
            return;
        }
        if (typing || !this.root.contains(document.activeElement) && document.activeElement !== document.body) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            this.api.undo();
        } else if (e.key === 'Delete' && this.selected) {
            e.preventDefault();
            this.deleteItem(this.selected.ownerKey, this.selected.id);
        }
    }

    async onClick(e) {
        const btn = e.target.closest('[data-act]');
        if (!btn || !this.root.contains(btn)) {
            if (!e.target.closest('.ivui-menu') && !e.target.closest('[data-act="menu"]')) this.closeMenu();
            return;
        }
        const act = btn.dataset.act;
        const owner = this.currentOwner();
        if (act !== 'menu') this.closeMenu();
        switch (act) {
            case 'close': this.close(); break;
            case 'undo': this.api.undo(); break;
            case 'rescan': this.api.rescan(); break;
            case 'menu': this.toggleMenu(); break;
            case 'tab':
                this.activeOwner = btn.dataset.owner;
                this.selected = null;
                this.render();
                break;
            case 'view':
                this.view = this.view === 'log' ? 'inv' : 'log';
                this.render();
                break;
            case 'add':
                if (owner) this.openEditor({ ownerKey: owner.key });
                break;
            case 'edit':
                if (this.selected) this.openEditor({ ownerKey: this.selected.ownerKey, id: this.selected.id });
                break;
            case 'delete':
                if (this.selected) this.deleteItem(this.selected.ownerKey, this.selected.id);
                break;
            case 'lock':
                if (this.selected) {
                    const { ownerKey, id } = this.selected;
                    this.api.mutate((state) => {
                        const item = state.owners[ownerKey]?.items.find(x => x.id === id);
                        if (!item) return false;
                        item.locked = !item.locked;
                    });
                }
                break;
            case 'give':
                if (this.selected) this.transferItem(this.selected.ownerKey, this.selected.id, btn.dataset.to);
                break;
            case 'menu-add': if (owner) this.openEditor({ ownerKey: owner.key }); break;
            case 'menu-scan': this.api.scanHistory(); break;
            case 'menu-export': this.exportJson(); break;
            case 'menu-import': this.root.querySelector('.ivui-file').click(); break;
            case 'menu-clear': await this.clearOwner(); break;
            case 'menu-settings': this.api.openSettings(); break;
        }
    }

    onDoubleClick(e) {
        const el = e.target.closest('.ivui-item');
        if (el && this.root.querySelector('.ivui-content').contains(el)) {
            this.openEditor({ ownerKey: el.dataset.owner, id: el.dataset.id });
        }
    }

    onContextMenu(e) {
        const slotEl = e.target.closest('.ivui-content .ivui-slot[data-slot]');
        if (!slotEl) return;
        e.preventDefault();
        const owner = this.currentOwner();
        if (!owner) return;
        const itemEl = slotEl.querySelector('.ivui-item');
        if (itemEl) {
            this.openEditor({ ownerKey: owner.key, id: itemEl.dataset.id });
        } else {
            this.openEditor({ ownerKey: owner.key, slot: slotEl.dataset.slot });
        }
    }

    // ---------- Pointer: selecting, dragging, moving the window ----------

    onPointerDown(e) {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        const header = e.target.closest('.ivui-header');
        if (header && !e.target.closest('button')) {
            this.startWindowMove(e);
            return;
        }
        const slotEl = e.target.closest('.ivui-content .ivui-slot');
        if (!slotEl) return;
        const itemEl = slotEl.querySelector('.ivui-item');
        this.press = {
            pointerId: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            slotEl,
            itemEl,
            id: itemEl?.dataset.id ?? null,
            ownerKey: itemEl?.dataset.owner ?? null,
            split: e.ctrlKey || e.altKey,
            shift: e.shiftKey,
            longTimer: null,
            longFired: false,
        };
        if (itemEl) {
            e.preventDefault();
            if (e.pointerType !== 'mouse') {
                this.press.longTimer = setTimeout(() => {
                    if (!this.press || this.drag) return;
                    this.press.longFired = true;
                    navigator.vibrate?.(20);
                    this.openEditor({ ownerKey: this.press.ownerKey, id: this.press.id });
                }, LONG_PRESS_MS);
            }
        }
        window.addEventListener('pointermove', this.onPointerMove);
        window.addEventListener('pointerup', this.onPointerUp);
        window.addEventListener('pointercancel', this.onPointerUp);
    }

    onPointerMove(e) {
        if (this.move) {
            const x = e.clientX - this.move.dx;
            const y = e.clientY - this.move.dy;
            this.root.style.left = `${Math.min(Math.max(0, x), window.innerWidth - 80)}px`;
            this.root.style.top = `${Math.min(Math.max(0, y), window.innerHeight - 40)}px`;
            return;
        }
        const press = this.press;
        if (!press || e.pointerId !== press.pointerId) return;
        if (!this.drag) {
            if (!press.id || press.longFired) return;
            if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD) return;
            clearTimeout(press.longTimer);
            this.startDrag(e);
        }
        this.updateDrag(e);
    }

    onPointerUp(e) {
        window.removeEventListener('pointermove', this.onPointerMove);
        window.removeEventListener('pointerup', this.onPointerUp);
        window.removeEventListener('pointercancel', this.onPointerUp);
        if (this.move) {
            this.endWindowMove();
            return;
        }
        const press = this.press;
        this.press = null;
        if (!press) return;
        clearTimeout(press.longTimer);
        if (this.drag) {
            if (e.type === 'pointercancel') {
                this.cancelDrag();
            } else {
                this.finishDrag(e, press);
            }
            return;
        }
        if (press.longFired || e.type === 'pointercancel') return;
        this.onTap(press);
    }

    onTap(press) {
        const owner = this.currentOwner();
        if (!owner) return;
        const slot = press.slotEl.dataset.slot;
        if (press.slotEl.dataset.trash) {
            if (this.selected) this.deleteItem(this.selected.ownerKey, this.selected.id);
            return;
        }
        if (press.id) {
            if (press.shift) {
                this.quickMove(owner.key, press.id);
            } else if (this.selected?.id === press.id) {
                this.select(null);
            } else {
                this.select({ ownerKey: owner.key, id: press.id });
            }
            return;
        }
        if (this.selected && this.selected.ownerKey === owner.key && slot) {
            const id = this.selected.id;
            this.moveItem(owner.key, id, slot, false);
        }
    }

    select(sel) {
        this.selected = sel;
        this.root.querySelectorAll('.ivui-content .ivui-slot').forEach((el) => {
            el.classList.toggle('ivui-selected', !!sel && el.querySelector('.ivui-item')?.dataset.id === sel.id);
        });
        this.renderInfo();
    }

    startDrag(e) {
        const press = this.press;
        this.hideTooltip();
        const ghost = press.itemEl.cloneNode(true);
        ghost.classList.add('ivui-ghost');
        ghost.classList.remove('ivui-dim');
        const rect = press.itemEl.getBoundingClientRect();
        ghost.style.width = `${rect.width}px`;
        ghost.style.height = `${rect.height}px`;
        const wrap = document.createElement('div');
        wrap.className = 'ivui ivui-ghost-wrap';
        wrap.appendChild(ghost);
        document.body.appendChild(wrap);
        press.itemEl.classList.add('ivui-dragging');
        this.root.classList.add('ivui-is-dragging');
        this.drag = { wrap, half: rect.width / 2, target: null };
    }

    dropTargetAt(x, y) {
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        const tab = el.closest('.ivui-tab[data-owner]');
        if (tab) return { type: 'tab', el: tab, ownerKey: tab.dataset.owner };
        const slot = el.closest('.ivui-content .ivui-slot');
        if (slot?.dataset.trash) return { type: 'trash', el: slot };
        if (slot?.dataset.slot) return { type: 'slot', el: slot, slot: slot.dataset.slot };
        return null;
    }

    updateDrag(e) {
        const drag = this.drag;
        drag.wrap.style.transform = `translate(${e.clientX - drag.half}px, ${e.clientY - drag.half}px)`;
        const target = this.dropTargetAt(e.clientX, e.clientY);
        if (drag.target?.el !== target?.el) {
            drag.target?.el.classList.remove('ivui-drop-hover');
            target?.el.classList.add('ivui-drop-hover');
            drag.target = target;
        }
    }

    finishDrag(e, press) {
        const target = this.dropTargetAt(e.clientX, e.clientY);
        this.cancelDrag();
        if (!target) return;
        if (target.type === 'slot') {
            this.moveItem(press.ownerKey, press.id, target.slot, press.split || e.ctrlKey || e.altKey);
        } else if (target.type === 'trash') {
            this.deleteItem(press.ownerKey, press.id);
        } else if (target.type === 'tab' && target.ownerKey !== press.ownerKey) {
            this.transferItem(press.ownerKey, press.id, target.ownerKey);
        }
    }

    cancelDrag() {
        if (!this.drag) return;
        this.drag.target?.el.classList.remove('ivui-drop-hover');
        this.drag.wrap.remove();
        this.root.querySelectorAll('.ivui-dragging').forEach(el => el.classList.remove('ivui-dragging'));
        this.root.classList.remove('ivui-is-dragging');
        this.drag = null;
    }

    startWindowMove(e) {
        if (this.root.classList.contains('ivui-narrow')) return;
        const rect = this.root.getBoundingClientRect();
        this.root.classList.remove('ivui-centered');
        this.root.style.left = `${rect.left}px`;
        this.root.style.top = `${rect.top}px`;
        this.move = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        this.root.classList.add('ivui-moving');
        window.addEventListener('pointermove', this.onPointerMove);
        window.addEventListener('pointerup', this.onPointerUp);
        window.addEventListener('pointercancel', this.onPointerUp);
    }

    endWindowMove() {
        this.move = null;
        this.root.classList.remove('ivui-moving');
        this.fitHeight();
        const rect = this.root.getBoundingClientRect();
        const settings = this.api.getSettings();
        settings.panelPos = { x: Math.round(rect.left), y: Math.round(rect.top) };
        this.api.savePanelState(true);
    }

    // ---------- Item operations ----------

    moveItem(ownerKey, id, targetSlot, split) {
        let moved = false;
        this.api.mutate((state) => {
            const owner = state.owners[ownerKey];
            const item = owner?.items.find(x => x.id === id);
            if (!item || item.slot === targetSlot) return false;
            const other = owner.items.find(x => x.slot === targetSlot);
            const same = other && normName(other.name) === normName(item.name);
            if (split && item.qty > 1) {
                const half = Math.floor(item.qty / 2);
                if (!other) {
                    item.qty -= half;
                    owner.items.push({ ...clone(item), id: uid(), qty: half, slot: targetSlot, locked: false });
                    moved = true;
                    return;
                }
                if (same) {
                    item.qty -= half;
                    other.qty += half;
                    moved = true;
                    return;
                }
            }
            if (same) {
                other.qty += item.qty;
                owner.items = owner.items.filter(x => x.id !== item.id);
                this.selected = { ownerKey, id: other.id };
                moved = true;
                return;
            }
            if (other) other.slot = item.slot;
            item.slot = targetSlot;
            moved = true;
        });
        return moved;
    }

    quickMove(ownerKey, id) {
        this.api.mutate((state) => {
            const owner = state.owners[ownerKey];
            const item = owner?.items.find(x => x.id === id);
            if (!item) return false;
            const area = parseSlot(item.slot).area;
            const target = area === 'bag' ? firstFreeSlot(owner, 'hot') : firstFreeSlot(owner, 'bag');
            if (!target) return false;
            item.slot = target;
        });
    }

    transferItem(fromKey, id, toKey) {
        if (!toKey || fromKey === toKey) return;
        this.api.mutate((state) => {
            const from = state.owners[fromKey];
            const to = state.owners[toKey];
            const item = from?.items.find(x => x.id === id);
            if (!item || !to) return false;
            from.items = from.items.filter(x => x.id !== id);
            const existing = findByName(to, item.name);
            if (existing) {
                existing.qty += item.qty;
            } else {
                to.items.push({ ...item, slot: firstFreeSlot(to, 'bag') });
            }
            this.selected = null;
        });
        const tab = this.root.querySelector(`.ivui-tab[data-owner="${CSS.escape(toKey)}"]`);
        tab?.classList.add('ivui-tab-pulse');
        setTimeout(() => tab?.classList.remove('ivui-tab-pulse'), 600);
    }

    async deleteItem(ownerKey, id) {
        const item = this.findItem(ownerKey, id);
        if (!item) return;
        const settings = this.api.getSettings();
        if (settings.confirmDelete && !(await this.confirm(t('confirm_delete', item.name)))) return;
        this.api.mutate((state) => {
            const owner = state.owners[ownerKey];
            if (!owner) return false;
            owner.items = owner.items.filter(x => x.id !== id);
        });
        if (this.selected?.id === id) this.selected = null;
        this.render();
    }

    async clearOwner() {
        const owner = this.currentOwner();
        if (!owner) return;
        if (!(await this.confirm(t('confirm_clear', owner.name)))) return;
        this.selected = null;
        this.api.mutate((state) => {
            const data = state.owners[owner.key];
            if (!data?.items.length) return false;
            data.items = [];
        });
    }

    async confirm(text) {
        try {
            const ctx = SillyTavern.getContext();
            if (ctx.Popup?.show?.confirm) {
                return !!(await ctx.Popup.show.confirm(text, ''));
            }
            if (ctx.callGenericPopup && ctx.POPUP_TYPE) {
                return !!(await ctx.callGenericPopup(text, ctx.POPUP_TYPE.CONFIRM));
            }
        } catch (error) {
            console.warn('[Inventory UI] popup failed', error);
        }
        return window.confirm(text);
    }

    exportJson() {
        const state = this.api.getState();
        if (!state) return;
        const data = { format: 'st-inventory-ui', version: 1, owners: state.owners };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `inventory-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            URL.revokeObjectURL(a.href);
            a.remove();
        }, 1000);
    }

    async onImportFile(e) {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (!data?.owners || typeof data.owners !== 'object') throw new Error('no "owners" field');
            this.api.replaceState(data);
            toastr.success(t('imported'));
        } catch (error) {
            toastr.error(t('import_failed', error.message));
        }
    }

    // ---------- Menu ----------

    toggleMenu() {
        const menu = this.root.querySelector('.ivui-menu');
        if (!menu.hidden) {
            this.closeMenu();
            return;
        }
        menu.innerHTML = [
            ['menu-add', 'fa-plus', t('add_item')],
            ['menu-scan', 'fa-book-open', t('menu_scan_history')],
            ['menu-export', 'fa-file-export', t('menu_export')],
            ['menu-import', 'fa-file-import', t('menu_import')],
            ['menu-clear', 'fa-broom', t('menu_clear')],
            ['menu-settings', 'fa-gear', t('menu_settings')],
        ].map(([act, icon, label]) => `<button type="button" class="ivui-menu-item" data-act="${act}"><i class="fa-solid ${icon}"></i>${esc(label)}</button>`).join('');
        menu.hidden = false;
    }

    closeMenu() {
        const menu = this.root?.querySelector('.ivui-menu');
        if (menu) menu.hidden = true;
    }

    // ---------- Editor ----------

    openEditor({ ownerKey, id = null, slot = null }) {
        this.hideTooltip();
        const existing = id ? this.findItem(ownerKey, id) : null;
        const item = existing ? clone(existing) : normalizeItem({ name: '', qty: 1, icon: '', rarity: 'common', desc: '' });
        if (!existing) item.name = '';
        const owners = this.owners();
        const modal = this.modal;
        const icons = ['', ...SPRITE_KEYS].map((key) => {
            const active = (item.icon || '') === key ? ' ivui-icon-active' : '';
            const content = key ? `<img src="${spriteUrl(key)}" alt="" draggable="false">` : `<span>${esc(t('icon_auto'))}</span>`;
            return `<button type="button" class="ivui-icon-pick${active}" data-icon="${key}" title="${key || t('icon_auto')}">${content}</button>`;
        }).join('');
        const isEmoji = item.icon && !SPRITE_KEYS.includes(item.icon);
        const rarities = RARITIES.map(r => `<button type="button" class="ivui-rarity-pick ivui-rc-${r} ${item.rarity === r ? 'ivui-rarity-active' : ''}" data-rarity="${r}">${esc(t(`rarity_${r}`))}</button>`).join('');
        const ownerSelect = !existing && owners.length > 1
            ? `<label class="ivui-field"><span>${esc(t('owner'))}</span><select class="ivui-input" data-field="owner">${owners.map(o => `<option value="${esc(o.key)}" ${o.key === ownerKey ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>`
            : '';
        modal.innerHTML = `
            <div class="ivui-dialog">
                <div class="ivui-dialog-title">${esc(existing ? t('edit_item') : t('new_item'))}</div>
                <div class="ivui-dialog-body">
                    <div class="ivui-edit-preview">
                        <div class="ivui-slot ivui-slot-big"><div class="ivui-item ivui-r-${item.rarity}">${iconHtml(item)}</div></div>
                        <div class="ivui-edit-main">
                            <label class="ivui-field"><span>${esc(t('name'))}</span><input class="ivui-input" data-field="name" maxlength="80" value="${esc(item.name)}"></label>
                            <label class="ivui-field ivui-field-qty"><span>${esc(t('quantity'))}</span>
                                <span class="ivui-qty">
                                    <button type="button" class="ivui-btn ivui-btn-sm" data-qty="-1">−</button>
                                    <input class="ivui-input" data-field="qty" type="number" min="1" max="999999" value="${item.qty}">
                                    <button type="button" class="ivui-btn ivui-btn-sm" data-qty="1">+</button>
                                </span>
                            </label>
                        </div>
                    </div>
                    ${ownerSelect}
                    <div class="ivui-field"><span>${esc(t('rarity'))}</span><div class="ivui-rarities">${rarities}</div></div>
                    <div class="ivui-field"><span>${esc(t('icon'))}</span>
                        <div class="ivui-icon-grid">${icons}</div>
                        <input class="ivui-input ivui-emoji-input" data-field="emoji" maxlength="8" placeholder="${esc(t('emoji_placeholder'))}" value="${isEmoji ? esc(item.icon) : ''}">
                    </div>
                    <label class="ivui-field"><span>${esc(t('description'))}</span><textarea class="ivui-input" data-field="desc" rows="3" maxlength="400">${esc(item.desc)}</textarea></label>
                    <label class="ivui-check"><input type="checkbox" data-field="locked" ${item.locked ? 'checked' : ''}><span>${esc(t('lock'))}</span></label>
                </div>
                <div class="ivui-dialog-buttons">
                    ${existing ? `<button type="button" class="ivui-btn ivui-btn-danger" data-edit="delete"><i class="fa-solid fa-trash-can"></i></button>` : ''}
                    ${existing && existing.qty > 1 ? `<button type="button" class="ivui-btn" data-edit="split" title="${esc(t('split'))}"><i class="fa-solid fa-scissors"></i></button>` : ''}
                    <span class="ivui-flex"></span>
                    <button type="button" class="ivui-btn" data-edit="cancel">${esc(t('cancel'))}</button>
                    <button type="button" class="ivui-btn ivui-btn-primary" data-edit="save">${esc(t('save'))}</button>
                </div>
            </div>`;
        modal.hidden = false;

        const draft = { ...item };
        const preview = modal.querySelector('.ivui-edit-preview .ivui-item');
        const refreshPreview = () => {
            preview.className = `ivui-item ivui-r-${draft.rarity}`;
            preview.innerHTML = iconHtml(draft);
        };
        const nameInput = modal.querySelector('[data-field="name"]');
        const qtyInput = modal.querySelector('[data-field="qty"]');
        const emojiInput = modal.querySelector('[data-field="emoji"]');
        nameInput.addEventListener('input', () => {
            draft.name = nameInput.value;
            refreshPreview();
        });
        emojiInput.addEventListener('input', () => {
            draft.icon = emojiInput.value.trim();
            modal.querySelectorAll('.ivui-icon-pick').forEach(b => b.classList.remove('ivui-icon-active'));
            refreshPreview();
        });
        setTimeout(() => nameInput.focus(), 30);

        modal.onclick = async (ev) => {
            const target = ev.target;
            const iconBtn = target.closest('.ivui-icon-pick');
            if (iconBtn) {
                draft.icon = iconBtn.dataset.icon;
                emojiInput.value = '';
                modal.querySelectorAll('.ivui-icon-pick').forEach(b => b.classList.toggle('ivui-icon-active', b === iconBtn));
                refreshPreview();
                return;
            }
            const rarityBtn = target.closest('.ivui-rarity-pick');
            if (rarityBtn) {
                draft.rarity = rarityBtn.dataset.rarity;
                modal.querySelectorAll('.ivui-rarity-pick').forEach(b => b.classList.toggle('ivui-rarity-active', b === rarityBtn));
                refreshPreview();
                return;
            }
            const qtyBtn = target.closest('[data-qty]');
            if (qtyBtn) {
                qtyInput.value = String(Math.max(1, (Number(qtyInput.value) || 1) + Number(qtyBtn.dataset.qty)));
                return;
            }
            const action = target.closest('[data-edit]')?.dataset.edit;
            if (!action) {
                if (target === modal) this.closeModal();
                return;
            }
            if (action === 'cancel') {
                this.closeModal();
            } else if (action === 'delete') {
                this.closeModal();
                await this.deleteItem(ownerKey, id);
            } else if (action === 'split') {
                this.closeModal();
                const owner = this.ownerData(ownerKey);
                const free = firstFreeSlot(owner, 'bag');
                if (free) this.moveItem(ownerKey, id, free, true);
            } else if (action === 'save') {
                const name = nameInput.value.trim();
                if (!name) {
                    nameInput.classList.add('ivui-invalid');
                    nameInput.focus();
                    return;
                }
                const values = {
                    name: name.slice(0, 80),
                    qty: Math.max(1, Math.min(999999, Math.floor(Number(qtyInput.value) || 1))),
                    icon: draft.icon || '',
                    rarity: draft.rarity,
                    desc: modal.querySelector('[data-field="desc"]').value.trim().slice(0, 400),
                    locked: modal.querySelector('[data-field="locked"]').checked,
                };
                const targetOwner = modal.querySelector('[data-field="owner"]')?.value || ownerKey;
                this.closeModal();
                this.saveItem(targetOwner, id, slot, values);
            }
        };
    }

    saveItem(ownerKey, id, slot, values) {
        let newId = id;
        this.api.mutate((state) => {
            const owner = state.owners[ownerKey];
            if (!owner) return false;
            if (id) {
                const item = owner.items.find(x => x.id === id);
                if (!item) return false;
                Object.assign(item, values);
                return;
            }
            const free = slot && !owner.items.some(x => x.slot === slot) ? slot : firstFreeSlot(owner, 'bag');
            const item = normalizeItem({ ...values, slot: free });
            newId = item.id;
            owner.items.push(item);
        });
        if (newId) {
            this.activeOwner = ownerKey;
            this.selected = { ownerKey, id: newId };
            this.render();
        }
    }

    closeModal() {
        const modal = this.modal;
        if (!modal) return;
        modal.hidden = true;
        modal.innerHTML = '';
        modal.onclick = null;
    }
}

// ---------- Hotbar HUD above the chat input ----------

export class HotbarHud {
    /**
     * @param {object} api
     * @param {() => object|null} api.getState
     * @param {() => {key: string, name: string}[]} api.getOwners
     * @param {() => {busy: boolean}} api.getStatus
     * @param {(sel?: {ownerKey: string, id: string}) => void} api.open
     */
    constructor(api) {
        this.api = api;
        this.el = null;
        this.ownerKey = null;
    }

    mount() {
        if (this.el) return;
        const anchor = document.getElementById('send_form');
        if (!anchor) return;
        const el = document.createElement('div');
        el.id = 'ivui-hud';
        el.className = 'ivui ivui-hud';
        anchor.parentElement.insertBefore(el, anchor);
        el.addEventListener('click', (e) => {
            const slot = e.target.closest('[data-hud-slot]');
            const id = slot?.querySelector('.ivui-item')?.dataset.id;
            if (e.target.closest('[data-hud-owner]')) {
                this.cycleOwner();
                return;
            }
            this.api.open(id ? { ownerKey: this.ownerKey, id } : undefined);
        });
        this.el = el;
    }

    unmount() {
        this.el?.remove();
        this.el = null;
    }

    cycleOwner() {
        const owners = this.api.getOwners();
        if (owners.length < 2) return;
        const index = owners.findIndex(o => o.key === this.ownerKey);
        this.ownerKey = owners[(index + 1) % owners.length].key;
        this.render();
    }

    render() {
        if (!this.el) return;
        const state = this.api.getState();
        const owners = this.api.getOwners();
        if (!state || !owners.length) {
            this.el.hidden = true;
            return;
        }
        this.el.hidden = false;
        if (!owners.some(o => o.key === this.ownerKey)) this.ownerKey = owners[0].key;
        const owner = owners.find(o => o.key === this.ownerKey);
        const data = state.owners[owner.key] ?? { items: [] };
        const bySlot = new Map(data.items.map(x => [x.slot, x]));
        let slots = '';
        for (let i = 0; i < HOTBAR_SIZE; i++) {
            const item = bySlot.get(`hot:${i}`);
            slots += `<div class="ivui-slot ivui-hud-slot" data-hud-slot="${i}" title="${esc(item ? `${item.name}${item.qty > 1 ? ` ×${item.qty}` : ''}` : '')}">${item ? itemHtml(item, owner.key) : ''}</div>`;
        }
        const hands = ['main', 'off'].map((s) => {
            const item = bySlot.get(s);
            return `<div class="ivui-slot ivui-hud-slot ivui-hud-hand" data-hud-slot="${s}" title="${esc(item ? item.name : t(`slot_${s}`))}">${item ? itemHtml(item, owner.key) : `<img class="ivui-hint" src="${spriteUrl(SLOT_HINTS[s], true)}" alt="" draggable="false">`}</div>`;
        }).join('');
        const busy = this.api.getStatus().busy ? '<span class="ivui-spinner"></span>' : '';
        const ownerBtn = owners.length > 1
            ? `<button type="button" class="ivui-hud-owner" data-hud-owner="1" title="${esc(owner.name)}">${esc(owner.name.slice(0, 1).toUpperCase())}</button>`
            : '';
        this.el.innerHTML = `
            ${ownerBtn}
            <div class="ivui-hud-bar">${hands}<span class="ivui-hud-sep"></span>${slots}</div>
            <button type="button" class="ivui-hud-open" title="${esc(t('inventory'))}">${busy || `<img src="${spriteUrl('chest')}" alt="" draggable="false">`}</button>`;
    }
}
