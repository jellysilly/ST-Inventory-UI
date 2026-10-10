// Procedural block textures (dirt, grass, stone, parchment) rendered once into data URLs.

function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function paint(width, height, seed, pick) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const rand = rng(seed);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            ctx.fillStyle = pick(x, y, rand);
            ctx.fillRect(x, y, 1, 1);
        }
    }
    return canvas.toDataURL('image/png');
}

function weighted(colors, weights, r) {
    let acc = 0;
    for (let i = 0; i < colors.length; i++) {
        acc += weights[i];
        if (r < acc) return colors[i];
    }
    return colors[colors.length - 1];
}

export function generateTextures() {
    const dirt = ['#866043', '#79553a', '#966c4a', '#593d29', '#b9855c'];
    const dirtW = [0.32, 0.28, 0.18, 0.14, 0.08];
    const grass = ['#5b8731', '#6aa13a', '#4a7228', '#7cbd3b'];
    const grassW = [0.4, 0.3, 0.2, 0.1];

    // Grass block side: 4 rows of grass with uneven drips, dirt below.
    const drip = [];
    const dripRand = rng(7);
    for (let x = 0; x < 16; x++) drip.push(3 + Math.floor(dripRand() * 3));

    return {
        dirt: paint(16, 16, 11, (x, y, r) => weighted(dirt, dirtW, r())),
        grass: paint(16, 16, 23, (x, y, r) => {
            if (y < drip[x]) return weighted(grass, grassW, r());
            return weighted(dirt, dirtW, r());
        }),
        stone: paint(16, 16, 37, (x, y, r) => weighted(
            ['#7f7f7f', '#747474', '#8f8f8f', '#686868', '#9a9a9a'],
            [0.35, 0.25, 0.2, 0.12, 0.08], r())),
        parchment: paint(16, 16, 53, (x, y, r) => weighted(
            ['#f4ead2', '#efe2c4', '#f8f0dc', '#e6d6b4'],
            [0.4, 0.3, 0.2, 0.1], r())),
        planks: paint(16, 16, 71, (x, y, r) => {
            if (y % 4 === 3) return '#4f3a1f';
            const seam = (y < 4 && x === 3) || (y >= 4 && y < 8 && x === 11) || (y >= 8 && y < 12 && x === 6) || (y >= 12 && x === 14);
            if (seam) return '#5d4425';
            return weighted(['#9c7f4e', '#a88a56', '#8e7146', '#b4945c'], [0.4, 0.25, 0.25, 0.1], r());
        }),
        obsidian: paint(16, 16, 89, (x, y, r) => weighted(
            ['#14121d', '#1b1726', '#0f0d16', '#2a2238', '#3b2d52'],
            [0.4, 0.3, 0.15, 0.1, 0.05], r())),
    };
}

let applied = false;

/** Exposes the textures as CSS custom properties on :root. */
export function applyTextures() {
    if (applied) return;
    applied = true;
    try {
        const tex = generateTextures();
        const root = document.documentElement;
        for (const [name, url] of Object.entries(tex)) {
            root.style.setProperty(`--ivui-tex-${name}`, `url("${url}")`);
        }
    } catch (error) {
        console.warn('[Inventory UI] Could not generate textures', error);
    }
}
