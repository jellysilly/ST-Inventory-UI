// Builds the tracker prompt, sends it to the selected API and parses the answer.

import { SPRITE_KEYS } from './sprites.js';
import { parseSlot, sortItems } from './state.js';

export const DEFAULT_TRACKER_PROMPT = `You track the physical inventory of characters in an ongoing roleplay story. Your only task is to find changes to the items they carry, wear or hold, based on the NEW messages.

Tracked characters: {{owners}}

Current inventory (each item has a numeric id):
{{inventory}}

Rules:
1. Report only what actually happened in the NEW messages: an item was picked up, received, bought, found and taken, crafted, put on, taken off, drawn, used up, eaten, broken, dropped, lost, given away, sold or stolen.
2. Ignore items that are only mentioned, imagined, seen nearby or owned by someone else, unless a tracked character takes them.
3. Never duplicate an existing item. Change it with "update" (quantity, description, location) using its id.
4. Locations ("where"): head, chest, legs, feet = worn clothing or armor; main, off = held in hands; hotbar = at hand (pockets, belt); bag = everything else carried.
5. If an item passes from one tracked character to another, use "give". If it goes to someone untracked, use "remove".
6. Names are short (1-4 words) and in the same language as the story. "desc" is a short note (max 12 words) about the item's notable state, or "".
7. "icon" is one of: {{icons}}; or a single emoji if nothing fits. "rarity" is common, uncommon, rare, epic or legendary (everyday things are common).
8. If nothing changed, answer {"changes":[]}.

Answer with JSON only, no commentary:
{"changes":[
{"op":"add","owner":"Name","name":"Item","qty":1,"where":"bag","icon":"key","rarity":"common","desc":""},
{"op":"remove","id":3,"qty":1},
{"op":"update","id":2,"qty":5,"where":"main","desc":"..."},
{"op":"give","id":4,"to":"Name","qty":1}
]}`;

export const DEFAULT_INJECT_TEMPLATE = `[Inventory. This is what the characters actually have on them right now. They can only use, show or hand over these items; anything else must be obtained in the story first.]
{{inventory}}`;

const WHERE_LABEL = { head: 'head', chest: 'chest', legs: 'legs', feet: 'feet', main: 'main', off: 'off', hot: 'hotbar', bag: 'bag' };

function whereOf(item) {
    const p = parseSlot(item.slot);
    if (p.area === 'equip') return WHERE_LABEL[item.slot];
    return WHERE_LABEL[p.area] ?? 'bag';
}

/**
 * Inventory listing for the tracker (with numeric ids).
 */
export function formatForTracker(state, owners, byId) {
    const lines = [];
    for (const o of owners) {
        const owner = state.owners[o.key];
        lines.push(`${o.name}:`);
        const items = owner ? sortItems(owner.items) : [];
        if (!items.length) {
            lines.push('  (nothing)');
            continue;
        }
        for (const item of items) {
            const qty = item.qty > 1 ? ` x${item.qty}` : '';
            const desc = item.desc ? ` - ${item.desc}` : '';
            lines.push(`  #${byId.get(item.id)} ${item.name}${qty} [${whereOf(item)}]${desc}`);
        }
    }
    return lines.join('\n');
}

/**
 * Inventory listing for the main model (prompt injection / macro).
 */
export function formatForPrompt(state, owners, { descriptions = true, skipEmpty = false } = {}) {
    const blocks = [];
    const label = (item) => {
        const qty = item.qty > 1 ? ` x${item.qty}` : '';
        const desc = descriptions && item.desc ? ` (${item.desc})` : '';
        return `${item.name}${qty}${desc}`;
    };
    for (const o of owners) {
        const owner = state.owners[o.key];
        const items = owner ? sortItems(owner.items) : [];
        if (!items.length) {
            if (!skipEmpty) blocks.push(`${o.name}: carries nothing.`);
            continue;
        }
        const worn = [];
        const held = [];
        const hot = [];
        const bag = [];
        for (const item of items) {
            const p = parseSlot(item.slot);
            if (item.slot === 'main') held.push(`${label(item)} (main hand)`);
            else if (item.slot === 'off') held.push(`${label(item)} (off hand)`);
            else if (p.area === 'equip') worn.push(label(item));
            else if (p.area === 'hot') hot.push(label(item));
            else bag.push(label(item));
        }
        const lines = [`${o.name}:`];
        if (worn.length) lines.push(`- Wearing: ${worn.join(', ')}`);
        if (held.length) lines.push(`- Holding: ${held.join(', ')}`);
        if (hot.length) lines.push(`- At hand (pockets/belt): ${hot.join(', ')}`);
        if (bag.length) lines.push(`- In bag: ${bag.join(', ')}`);
        blocks.push(lines.join('\n'));
    }
    return blocks.join('\n');
}

export function cleanMessageText(text, maxChars) {
    let s = String(text ?? '');
    s = s.replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    s = s.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
    if (maxChars && s.length > maxChars) {
        s = s.slice(0, Math.floor(maxChars * 0.3)) + '\n[...]\n' + s.slice(-Math.floor(maxChars * 0.7));
    }
    return s;
}

/**
 * @param {object} p
 * @param {string} p.template tracker system prompt template
 * @param {string} p.inventory formatted inventory
 * @param {{name: string}[]} p.owners
 * @param {{name: string, text: string}[]} p.newMessages
 * @param {{name: string, text: string}[]} [p.contextMessages]
 * @param {string} [p.background] character / persona descriptions for full scans
 * @param {boolean} [p.fullScan]
 */
export function buildTrackerPrompt(p) {
    const owners = p.owners.map(o => o.name).join(', ');
    const system = p.template
        .replace(/\{\{owners\}\}/g, () => owners)
        .replace(/\{\{inventory\}\}/g, () => p.inventory)
        .replace(/\{\{icons\}\}/g, () => SPRITE_KEYS.join(', '));

    const parts = [];
    if (p.background) {
        parts.push(`CHARACTER INFO (may list starting belongings):\n${p.background}`);
    }
    if (p.contextMessages?.length) {
        parts.push('EARLIER MESSAGES (already processed, context only, do NOT report changes from them):\n'
            + p.contextMessages.map(m => `[${m.name}]: ${m.text}`).join('\n\n'));
    }
    const header = p.fullScan
        ? 'STORY SO FAR (build the inventory from it: report everything the tracked characters currently carry that is not listed yet):'
        : 'NEW MESSAGES (report changes from these):';
    parts.push(header + '\n' + p.newMessages.map(m => `[${m.name}]: ${m.text}`).join('\n\n'));
    parts.push('Return the JSON now.');
    return { system, user: parts.join('\n\n---\n\n') };
}

/**
 * Sends the tracker request through a Connection Manager profile or the main API.
 * @returns {Promise<string>}
 */
export async function sendTrackerRequest({ system, user }, { profileId, maxTokens, signal }) {
    const ctx = SillyTavern.getContext();
    if (profileId) {
        const service = ctx.ConnectionManagerRequestService;
        if (!service) throw new Error('Connection Manager is not available in this SillyTavern version');
        const profiles = ctx.extensionSettings.connectionManager?.profiles ?? [];
        if (!profiles.some(p => p.id === profileId)) throw new Error('the selected connection profile no longer exists');
        const messages = [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ];
        const result = await service.sendRequest(profileId, messages, maxTokens, {
            stream: false,
            signal,
            extractData: true,
            includePreset: true,
            includeInstruct: true,
        });
        if (typeof result === 'string') return result;
        return String(result?.content ?? '');
    }

    const { generateRaw } = ctx;
    if (typeof generateRaw !== 'function') throw new Error('generateRaw is not available');
    // Old SillyTavern versions take positional arguments.
    if (generateRaw.length >= 2) {
        return await generateRaw(user, null, false, false, system, maxTokens);
    }
    return await generateRaw({ prompt: user, systemPrompt: system, responseLength: maxTokens });
}

function tryParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        // Common model mistakes: trailing commas, smart quotes, comments.
        const repaired = text
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, '\'')
            .replace(/\/\/[^\n"]*$/gm, '')
            .replace(/,\s*([}\]])/g, '$1');
        try {
            return JSON.parse(repaired);
        } catch {
            return undefined;
        }
    }
}

/**
 * Extracts the list of changes from a model answer.
 * @param {string} text
 * @returns {any[]}
 */
export function parseChanges(text) {
    let s = String(text ?? '');
    s = s.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
    if (fence) s = fence[1];

    const start = s.search(/[[{]/);
    if (start < 0) {
        if (/no changes|nothing changed|ничего не изменилось/i.test(s)) return [];
        throw new Error('No JSON in the tracker answer');
    }
    let body = s.slice(start);
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    if (end >= 0) body = body.slice(0, end + 1);

    const parsed = tryParse(body);
    if (parsed !== undefined) {
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed?.changes)) return parsed.changes;
        if (Array.isArray(parsed?.inventory_changes)) return parsed.inventory_changes;
        if (parsed && typeof parsed === 'object' && parsed.op) return [parsed];
        return [];
    }

    // Truncated or broken JSON: salvage every flat object that looks like a change.
    const salvaged = [];
    for (const match of body.matchAll(/\{[^{}]*\}/g)) {
        const obj = tryParse(match[0]);
        if (obj && typeof obj === 'object' && (obj.op || obj.action)) salvaged.push(obj);
    }
    if (salvaged.length) return salvaged;
    throw new Error('Could not parse the tracker answer');
}
