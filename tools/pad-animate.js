// Plays a one-shot LED animation on the STARRYPAD, then restores the previous colours.
//
//   node tools/pad-animate.js <name> [--banks A|A,C|all] [--keep] [--dry-run]
//   node tools/pad-animate.js --list
//
//   --banks    banks to animate (default: all, so it shows on whichever bank is active)
//   --keep     leave the last frame on the pad instead of restoring the previous colours
//   --dry-run  print the frames, write nothing
//
// Each frame is a full config write (~0.65 s) that the pad stores in flash (STARRYPAD-PROTOCOL.md
// §5.3), so animations are short (<= 24 frames) and play once. Only idle colours are animated.
import { StarrypadDevice, StarrypadConfig, BANKS } from '../lib/starrypad.js';

const MAX_FRAMES = 24;
const RAINBOW = ['red', 'yellow', 'green', 'cyan', 'blue', 'purple'];

// Pad 1 = bottom-left; row 0 = bottom row, col 0 = left column.
const PADS = Array.from({ length: 16 }, (_, i) => ({ pad: i + 1, row: Math.floor(i / 4), col: i % 4 }));
const frame = (colorAt) => PADS.map(colorAt);
const SPIRAL = [[3, 0], [3, 1], [3, 2], [3, 3], [2, 3], [1, 3], [0, 3], [0, 2], [0, 1], [0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [1, 1]]
    .map(([row, col]) => row * 4 + col);

const cellIndex = ([row, col]) => row * 4 + col;
// Frame from { padIndex: colour }, everything else off.
const litFrame = (lit) => frame((_, i) => lit[i] ?? 'off');

// Scripted snake: eats five apples (grows 2 -> 7), gets trapped in the bottom-left corner,
// bites itself and blinks red.
function snakeFrames() {
    let body = [[0, 1], [0, 0]]; // head first
    const apples = [[0, 3], [3, 3], [3, 0], [1, 2], [0, 0], [2, 2]];
    const path = [[0, 2], [0, 3], [1, 3], [2, 3], [3, 3], [3, 2], [3, 1], [3, 0],
        [2, 0], [1, 0], [1, 1], [1, 2], [0, 2], [0, 1], [0, 0], [1, 0]];
    const draw = () => {
        const lit = { [cellIndex(apples[0])]: 'red' };
        body.forEach((cell, i) => { lit[cellIndex(cell)] = i === 0 ? 'yellow' : 'green'; });
        return litFrame(lit);
    };
    const frames = [draw()];
    for (const head of path) {
        const eats = cellIndex(head) === cellIndex(apples[0]);
        const blocking = eats ? body : body.slice(0, -1); // the tail moves away unless the snake grows
        if (blocking.some((cell) => cellIndex(cell) === cellIndex(head))) {
            const dead = litFrame(Object.fromEntries(body.map((cell) => [cellIndex(cell), 'red'])));
            frames.push(dead, frame(() => 'off'), dead); // game over: blink red
            break;
        }
        body = eats ? [head, ...body] : [head, ...body.slice(0, -1)];
        if (eats) apples.shift();
        frames.push(draw());
    }
    return frames;
}

// Pong: 2-pad paddles in the left (blue) and right (red) columns, white ball in between.
// Both paddles track the ball until red stops reacting; the ball gets past it and blue scores.
function pongFrames() {
    const ball = { row: 0, col: 1, dr: 1, dc: 1 };
    const paddle = { blue: 2, red: 0 }; // lower row of each paddle (covers row and row + 1)
    const draw = () => {
        const lit = {};
        for (const d of [0, 1]) {
            lit[cellIndex([paddle.blue + d, 0])] = 'blue';
            lit[cellIndex([paddle.red + d, 3])] = 'red';
        }
        lit[cellIndex([ball.row, ball.col])] = 'white';
        return litFrame(lit);
    };
    const follow = (p, row) => Math.max(0, Math.min(2, row < p ? p - 1 : row > p + 1 ? p + 1 : p));
    const frames = [draw()];
    for (let t = 1; frames.length < MAX_FRAMES - 1; t++) {
        let row = ball.row + ball.dr;
        if (row < 0 || row > 3) { ball.dr = -ball.dr; row = ball.row + ball.dr; }
        let col = ball.col + ball.dc;
        paddle.blue = follow(paddle.blue, row);
        if (t < 6) paddle.red = follow(paddle.red, row); // red falls asleep
        const side = col === 0 ? 'blue' : col === 3 ? 'red' : null;
        if (side && row >= paddle[side] && row <= paddle[side] + 1) { ball.dc = -ball.dc; col = ball.col + ball.dc; }
        Object.assign(ball, { row, col });
        frames.push(draw());
        if (side && ball.col === (side === 'blue' ? 0 : 3)) break; // ball got past a paddle
    }
    frames.push(frame(() => 'blue')); // point for blue
    return frames;
}

const ANIMATIONS = {
    rainbow: {
        description: 'whole pad cycles through the rainbow, ends on white',
        frames: () => [...RAINBOW, 'white'].map((color) => frame(() => color)),
    },
    wave: {
        description: 'diagonal colour wave rolling from bottom-left to top-right',
        frames: () => Array.from({ length: 8 }, (_, f) =>
            frame(({ row, col }) => RAINBOW[(f - row - col + 60) % RAINBOW.length])),
    },
    rise: {
        description: 'rows light up from the bottom like a level meter, then flash white',
        frames: () => [
            ...[1, 2, 3, 4].map((lit) => frame(({ row }) => (row < lit ? ['green', 'green', 'yellow', 'red'][row] : 'off'))),
            frame(() => 'white'),
        ],
    },
    ripple: {
        description: 'colour rings travel from the centre outwards',
        frames: () => {
            const seq = ['blue', 'cyan', 'white', 'purple', 'off'];
            const inner = ({ row, col }) => row >= 1 && row <= 2 && col >= 1 && col <= 2;
            return Array.from({ length: 6 }, (_, t) =>
                frame((p) => (inner(p) ? seq[t] : seq[t - 1]) ?? 'off'));
        },
    },
    spiral: {
        description: 'pads fill in a clockwise spiral from the top-left corner inwards',
        frames: () => [3, 6, 9, 12, 15, 16].map((count) => frame((_, i) => {
            const order = SPIRAL.indexOf(i);
            return order < count ? RAINBOW[Math.floor(order / 3) % RAINBOW.length] : 'off';
        })),
    },
    sparkle: {
        description: 'random pads twinkle in random colours',
        frames: () => Array.from({ length: 8 }, () =>
            frame(() => (Math.random() < 0.5 ? 'off' : [...RAINBOW, 'white'][Math.floor(Math.random() * 7)]))),
    },
    snake: {
        description: 'snake eats five apples, gets trapped in a corner, bites itself and blinks red',
        frames: snakeFrames,
    },
    pong: {
        description: 'blue and red paddles rally a white ball until red misses, blue scores',
        frames: pongFrames,
    },
    checker: {
        description: 'checkerboard that swaps colours back and forth',
        frames: () => [['red', 'blue'], ['blue', 'red'], ['green', 'purple'], ['purple', 'green'], ['yellow', 'cyan'], ['cyan', 'yellow']]
            .map(([a, b]) => frame(({ row, col }) => ((row + col) % 2 ? a : b))),
    },
};

function printFrame(colors) {
    for (let row = 3; row >= 0; row--) {
        console.log('  ' + [0, 1, 2, 3].map((col) => colors[row * 4 + col].padEnd(7)).join(''));
    }
}

function printUsage() {
    console.log('Usage: node tools/pad-animate.js <name> [--banks A|A,C|all] [--keep] [--dry-run]\n\nAnimations:');
    for (const [name, { description, frames }] of Object.entries(ANIMATIONS)) {
        console.log(`  ${name.padEnd(8)} ${String(frames().length).padStart(2)} frames  ${description}`);
    }
}

async function main() {
    const args = process.argv.slice(2);
    const name = args[0];
    if (!name || name === '--list' || name === 'help' || name === '--help') return printUsage();
    const animation = ANIMATIONS[name];
    if (!animation) throw new Error(`Unknown animation "${name}". Try --list.`);

    const banksArg = args.includes('--banks') ? args[args.indexOf('--banks') + 1] : 'all';
    const banks = banksArg === 'all' ? BANKS : String(banksArg).toUpperCase().split(',');
    if (!banks.every((b) => BANKS.includes(b))) throw new Error('--banks must be A, B, C, a list like A,C, or all');
    const keep = args.includes('--keep');
    const frames = animation.frames().slice(0, MAX_FRAMES);

    if (args.includes('--dry-run')) {
        frames.forEach((colors, i) => { console.log(`frame ${i + 1}/${frames.length}`); printFrame(colors); });
        return;
    }

    const device = new StarrypadDevice(/^STARRYPAD$/);
    let stopRequested = false;
    process.on('SIGINT', () => {
        if (!stopRequested) console.log('\nStopping after this frame…');
        stopRequested = true;
    });

    try {
        const original = await device.readConfig();
        if (!original) throw new Error('The pad did not answer the config request. Replug it and retry.');

        let writes = 0;
        let expected = original;
        for (const [i, colors] of frames.entries()) {
            if (stopRequested) break;
            const config = StarrypadConfig.fromJSON(original.toJSON());
            for (const bank of banks) colors.forEach((color, k) => config.setPadColor(bank, k + 1, 'idle', color));
            process.stdout.write(`\r${name}: frame ${i + 1}/${frames.length}`);
            await device.writeConfig(config);
            writes++;
            expected = config;
        }
        if (!keep || stopRequested) {
            process.stdout.write(keep ? '\nrestoring previous colours' : '\rrestoring previous colours        ');
            await device.writeConfig(original);
            writes++;
            expected = original;
        }

        const check = await device.readConfig();
        const ok = check && JSON.stringify(check.blocks) === JSON.stringify(expected.blocks);
        const end = expected === original ? 'previous colours restored' : 'last frame kept';
        console.log(`\nDone – ${writes} config writes, ${end}${ok ? ' (verified)' : ' – WARNING: read-back did not match'}.`);
        if (!ok) process.exitCode = 1;
    } finally {
        device.close();
    }
}

main().then(() => process.exit(process.exitCode ?? 0), (error) => { console.error(error.message); process.exit(1); });
