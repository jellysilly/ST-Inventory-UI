// Run with: node --test tests/logic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createEmptyState, ensureOwner, applyChanges, buildRefs, revertRecords, replayRecords, sanitizeState,
} from '../src/state.js';
import { parseChanges, formatForPrompt, formatForTracker, buildTrackerPrompt, cleanMessageText } from '../src/tracker.js';
import { resolveIcon } from '../src/sprites.js';

const OWNERS = [{ key: 'char:Yume', name: 'Yume' }, { key: 'user', name: 'Alex' }];

function setup() {
    const state = createEmptyState();
    for (const o of OWNERS) ensureOwner(state, o.key, o.name);
    return state;
}

function run(state, changes) {
    const { refs } = buildRefs(state, OWNERS.map(o => o.key));
    return applyChanges(state, changes, { owners: OWNERS, refs });
}

const names = (state, key) => state.owners[key].items.map(i => `${i.name}x${i.qty}@${i.slot}`).sort();

test('add, merge, remove and update', () => {
    const state = setup();
    run(state, [
        { op: 'add', owner: 'Yume', name: 'Apple', qty: 2 },
        { op: 'add', owner: 'Yume', name: 'Sword', where: 'main' },
        { op: 'add', owner: 'Alex', name: 'Coin', qty: 5, where: 'hotbar' },
    ]);
    assert.deepEqual(names(state, 'char:Yume'), ['Applex2@bag:0', 'Swordx1@main']);
    assert.deepEqual(names(state, 'user'), ['Coinx5@hot:0']);

    run(state, [{ op: 'add', owner: 'Yume', name: 'apple', qty: 1 }]);
    assert.deepEqual(names(state, 'char:Yume'), ['Applex3@bag:0', 'Swordx1@main']);

    run(state, [{ op: 'remove', name: 'Apple', qty: 1 }, { op: 'update', name: 'Coin', qty: 2 }]);
    assert.deepEqual(names(state, 'char:Yume'), ['Applex2@bag:0', 'Swordx1@main']);
    assert.deepEqual(names(state, 'user'), ['Coinx2@hot:0']);

    run(state, [{ op: 'remove', name: 'Sword' }]);
    assert.deepEqual(names(state, 'char:Yume'), ['Applex2@bag:0']);
});

test('items are referenced by numeric id', () => {
    const state = setup();
    run(state, [{ op: 'add', owner: 'Yume', name: 'Key' }, { op: 'add', owner: 'Yume', name: 'Rope' }]);
    const { refs, byId } = buildRefs(state, OWNERS.map(o => o.key));
    const rope = state.owners['char:Yume'].items.find(i => i.name === 'Rope');
    applyChanges(state, [{ op: 'remove', id: `#${byId.get(rope.id)}` }], { owners: OWNERS, refs });
    assert.deepEqual(names(state, 'char:Yume'), ['Keyx1@bag:0']);
});

test('give moves items between tracked owners', () => {
    const state = setup();
    run(state, [{ op: 'add', owner: 'Yume', name: 'Letter', qty: 3 }]);
    const { log } = run(state, [{ op: 'give', name: 'Letter', to: 'Alex', qty: 2 }]);
    assert.deepEqual(names(state, 'char:Yume'), ['Letterx1@bag:0']);
    assert.deepEqual(names(state, 'user'), ['Letterx2@bag:0']);
    assert.equal(log[0].k, 'give');
});

test('equipping into an occupied hand moves the old item to the bag', () => {
    const state = setup();
    run(state, [{ op: 'add', owner: 'Yume', name: 'Old sword', where: 'main' }]);
    run(state, [{ op: 'add', owner: 'Yume', name: 'New sword', where: 'main' }]);
    assert.deepEqual(names(state, 'char:Yume'), ['New swordx1@main', 'Old swordx1@bag:0']);
});

test('locked items are not touched by the tracker', () => {
    const state = setup();
    run(state, [{ op: 'add', owner: 'Yume', name: 'Ring' }]);
    state.owners['char:Yume'].items[0].locked = true;
    run(state, [{ op: 'remove', name: 'Ring' }, { op: 'update', name: 'Ring', desc: 'broken' }]);
    assert.equal(state.owners['char:Yume'].items[0].desc, '');
    assert.equal(state.owners['char:Yume'].items.length, 1);
});

test('records revert and replay exactly, keeping manual edits', () => {
    const state = setup();
    run(state, [{ op: 'add', owner: 'Yume', name: 'Apple', qty: 3 }, { op: 'add', owner: 'Yume', name: 'Map' }]);
    const before = JSON.stringify(state.owners);

    const { records } = run(state, [
        { op: 'remove', name: 'Apple', qty: 1 },
        { op: 'remove', name: 'Map' },
        { op: 'add', owner: 'Yume', name: 'Torch' },
        { op: 'give', name: 'Apple', to: 'Alex', qty: 1 },
    ]);
    const after = JSON.stringify(state.owners);

    revertRecords(state, records);
    assert.equal(JSON.stringify(state.owners), before);
    replayRecords(state, records);
    assert.equal(JSON.stringify(state.owners), after);

    // A manual item added by the user survives a revert.
    state.owners.user.items.push({ id: 'manual', name: 'Hat', qty: 1, icon: '', rarity: 'common', desc: '', slot: 'head', locked: false });
    revertRecords(state, records);
    assert.ok(state.owners.user.items.some(i => i.id === 'manual'));
});

test('parseChanges handles fences, think blocks and truncated JSON', () => {
    assert.deepEqual(parseChanges('```json\n{"changes":[]}\n```'), []);
    assert.equal(parseChanges('<think>{"no": 1}</think> Sure! {"changes":[{"op":"add","name":"A"}]}').length, 1);
    assert.equal(parseChanges('[{"op":"remove","id":1}]')[0].op, 'remove');
    assert.equal(parseChanges('{"changes":[{"op":"add","name":"A",},]}').length, 1);
    const salvaged = parseChanges('{"changes":[{"op":"add","name":"A"},{"op":"add","name":"B"},{"op":"ad');
    assert.deepEqual(salvaged.map(c => c.name), ['A', 'B']);
    assert.throws(() => parseChanges('I refuse.'));
});

test('prompt formatting survives special characters', () => {
    const state = setup();
    run(state, [{ op: 'add', owner: 'Yume', name: 'Cash $1 & $&', qty: 2, where: 'off', desc: 'wet' }]);
    const text = formatForPrompt(state, OWNERS);
    assert.match(text, /Holding: Cash \$1 & \$& x2 \(wet\) \(off hand\)/);
    assert.match(text, /Alex: carries nothing\./);

    const { byId } = buildRefs(state, OWNERS.map(o => o.key));
    const inventory = formatForTracker(state, OWNERS, byId);
    const prompt = buildTrackerPrompt({
        template: 'Chars: {{owners}}\n{{inventory}}',
        inventory,
        owners: OWNERS,
        newMessages: [{ name: 'Yume', text: 'hi' }],
    });
    assert.ok(prompt.system.includes('#1 Cash $1 & $& x2 [off] - wet'));
    assert.ok(prompt.system.startsWith('Chars: Yume, Alex'));
});

test('message cleaning strips markup', () => {
    const text = cleanMessageText('<style>.x{}</style><div class="status">HP <b>55</b></div><br>Hello&nbsp;there');
    assert.equal(text, 'HP 55 \nHello there');
});

test('icons resolve from keys, emoji and names', () => {
    assert.deepEqual(resolveIcon({ icon: 'sword' }), { type: 'sprite', value: 'sword' });
    assert.deepEqual(resolveIcon({ icon: '🧸' }), { type: 'emoji', value: '🧸' });
    assert.deepEqual(resolveIcon({ name: 'Старый ключ' }), { type: 'sprite', value: 'key' });
    assert.deepEqual(resolveIcon({ name: 'Healing potion' }), { type: 'sprite', value: 'potion' });
    assert.deepEqual(resolveIcon({ name: 'Something odd' }), { type: 'sprite', value: 'chest' });
});

test('sanitizeState repairs broken data', () => {
    const state = sanitizeState({
        owners: { a: { name: 'A', items: [{ name: 'X', slot: 'bag:0' }, { name: 'Y', slot: 'bag:0' }, { name: 'Z', slot: 'hot:99' }] } },
        last: 'nope',
    });
    const slots = state.owners.a.items.map(i => i.slot);
    assert.equal(new Set(slots).size, 3);
    assert.equal(state.last, null);
});
