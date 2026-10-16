// Read / change the STARRYPAD pad LED colours (persistent device config).
//
//   node tools/pad-colors.js show
//   node tools/pad-colors.js set <banks> <pads> [hit=<colour>] [idle=<colour>] [--dry-run]
//        banks: A | A,C | all   pads: 1 | 1,2,5 | 1-4 | all   (Pad1 = bottom-left, Pad16 = top-right)
//        e.g. set A 1 idle=white      set all all hit=green idle=green      set C 13-16 idle=yellow
//   node tools/pad-colors.js backup <file.json>
//   node tools/pad-colors.js restore <file.json>
//
// Colours: off red green blue yellow purple cyan white
import fs from 'fs';
import { StarrypadDevice, StarrypadConfig, BANKS, SLOTS, COLORS, colorIndex } from '../lib/starrypad.js';

const NO_REPLY = 'The pad did not answer the config request. Unplug/replug it (or open the Donner editor once) and retry.';

function parsePads(spec) {
    if (spec === 'all') return Array.from({ length: 16 }, (_, i) => i + 1);
    return spec.split(',').flatMap((part) => {
        const [a, b] = part.split('-').map(Number);
        return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
    });
}

function printColors(cfg) {
    // Physical layout: Pad13-16 on top, Pad1-4 at the bottom.
    for (const bank of BANKS) {
        console.log(`\nBank ${bank}   (hit / idle)`);
        for (let row = 3; row >= 0; row--) {
            const cells = [1, 2, 3, 4].map((c) => {
                const pad = row * 4 + c;
                return `${String(pad).padStart(2)}: ${cfg.getPadColor(bank, pad, 'hit').padEnd(6)}/ ${cfg.getPadColor(bank, pad, 'idle').padEnd(6)}`;
            });
            console.log('  ' + cells.join('  '));
        }
    }
}

async function readOrDie(dev) {
    await dev.handshake();
    const cfg = await dev.readConfig();
    if (!cfg) {
        dev.close();
        console.error(NO_REPLY);
        process.exit(1);
    }
    return cfg;
}

async function writeAndVerify(dev, cfg) {
    await dev.writeConfig(cfg);
    const check = await dev.readConfig();
    const ok = check && JSON.stringify(check.blocks) === JSON.stringify(cfg.blocks);
    console.log(ok ? 'Written and verified (read back matches).' : 'WARNING: written, but read-back differs or failed.');
    return ok;
}

async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    if (!cmd || cmd === 'help' || cmd === '--help') {
        console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').slice(0, 10).join('\n'));
        return;
    }
    const dev = new StarrypadDevice(/^STARRYPAD$/);
    try {
        if (cmd === 'show') {
            printColors(await readOrDie(dev));
        } else if (cmd === 'backup') {
            if (!args[0]) throw new Error('usage: backup <file.json>');
            const cfg = await readOrDie(dev);
            fs.writeFileSync(args[0], JSON.stringify(cfg.toJSON(), null, 1));
            console.log(`Saved to ${args[0]}`);
        } else if (cmd === 'restore') {
            if (!args[0]) throw new Error('usage: restore <file.json>');
            const cfg = StarrypadConfig.fromJSON(JSON.parse(fs.readFileSync(args[0], 'utf8')));
            await dev.handshake();
            await writeAndVerify(dev, cfg);
        } else if (cmd === 'set') {
            const [bankArg, padsArg, ...rest] = args;
            const dryRun = rest.includes('--dry-run');
            const banks = bankArg === 'all' ? BANKS : String(bankArg ?? '').toUpperCase().split(',');
            if (!padsArg || !banks.every((b) => BANKS.includes(b))) {
                throw new Error('usage: set <A|B|C|A,C|all> <pads> [hit=<colour>] [idle=<colour>]');
            }
            const changes = rest.filter((r) => r.includes('=')).map((r) => r.split('='));
            if (!changes.length) throw new Error(`give hit=<colour> and/or idle=<colour> (${COLORS.join(', ')})`);
            for (const [slot, color] of changes) {
                if (!SLOTS.includes(slot)) throw new Error(`unknown slot "${slot}" (use hit or idle)`);
                colorIndex(color); // validate early
            }
            const cfg = await readOrDie(dev);
            for (const bank of banks) {
                for (const pad of parsePads(padsArg)) {
                    for (const [slot, color] of changes) cfg.setPadColor(bank, pad, slot, color);
                }
            }
            printColors(cfg);
            if (dryRun) console.log('\n--dry-run: nothing written.');
            else await writeAndVerify(dev, cfg);
        } else {
            throw new Error(`unknown command "${cmd}" (show | set | backup | restore)`);
        }
    } finally {
        dev.close();
    }
}

main().then(() => process.exit(0), (err) => { console.error(err.message); process.exit(1); });
