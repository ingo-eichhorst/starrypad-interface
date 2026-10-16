// Donner STARRYPAD config/colour protocol (see ../STARRYPAD-PROTOCOL.md).
// Pure helpers + a small node-midi transport. Colours are written as part of the full
// device config (13 SysEx blocks), which the pad stores persistently.
import midi from 'midi';

export const HEADER = [0xf0, 0x43, 0x56];
export const CMD = { DATA: 0x02, REQUEST_DUMP: 0x03, HANDSHAKE: 0x05, HANDSHAKE_REPLY: 0x06 };
export const COLORS = ['off', 'red', 'green', 'blue', 'yellow', 'purple', 'cyan', 'white'];
export const BANKS = ['A', 'B', 'C'];
export const BLOCK_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
export const WRITE_GAP_MS = 50; // the editor sleeps 50 ms between blocks

// Where each bank's two 8-byte colour sets live: [block id, data offset of hit set, data offset of idle set].
// Verified on hardware: the first set is the colour while a pad is hit, the second its idle colour.
// Block 11 has 4 unrelated bytes between bank A's two sets.
const COLOR_SETS = { A: [11, 0, 12], B: [12, 0, 8], C: [13, 0, 8] };
export const SLOTS = ['hit', 'idle'];

const hexBytes = (s) => s.trim().split(/\s+/).map((h) => parseInt(h, 16));
const padRow = (firstNote, n = 8) =>
    Array.from({ length: n }, (_, i) => `28 ${(firstNote + i).toString(16)} 00 00`).join(' ');

// Factory defaults, extracted from the editor's FACTORY RESET table (data bytes after the block id).
export const FACTORY_BLOCKS = {
    1: hexBytes('48 43 44 38 38 38 38 38 00 01 00 00'),
    2: hexBytes('28 24 01 00 28 25 01 00 28 26 01 00 28 27 01 00 ' + padRow(0x28, 4)),
    3: hexBytes(padRow(0x2c)),
    4: hexBytes(padRow(0x34)),
    5: hexBytes(padRow(0x3c)),
    6: hexBytes(padRow(0x44)),
    7: hexBytes(padRow(0x4c)),
    8: hexBytes('04 1c 01 00 04 09 01 00 04 0c 01 00 04 0d 01 00 04 0e 01 00 04 0f 01 00'),
    9: hexBytes('04 14 00 7f 04 15 00 7f 04 16 00 7f 04 17 00 7f 04 18 00 7f 04 19 00 7f'),
    10: hexBytes('05 1a 7f 00 05 1b 7f 00 05 3c 7f 00 04 3e 7f 00 00 04 0c 00'),
    11: hexBytes('11 11 11 11 11 11 11 11 77 21 12 01 00 00 00 00 00 00 00 00'),
    12: hexBytes('22 22 22 22 22 22 22 22 00 00 00 00 00 00 00 00'),
    13: hexBytes('33 33 33 33 33 33 33 33 00 00 00 00 00 00 00 00'),
};

export const toHex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');

export function colorIndex(color) {
    const i = typeof color === 'number' ? color : COLORS.indexOf(String(color).toLowerCase());
    if (!(i >= 0 && i <= 7)) throw new Error(`Unknown colour "${color}" (use ${COLORS.join(', ')} or 0-7)`);
    return i;
}

export class StarrypadConfig {
    constructor(blocks) {
        this.blocks = {};
        for (const id of BLOCK_IDS) {
            if (!blocks[id] || blocks[id].length !== FACTORY_BLOCKS[id].length) {
                throw new Error(`Block ${id} missing or wrong length`);
            }
            this.blocks[id] = [...blocks[id]];
        }
    }

    static factory() {
        return new StarrypadConfig(FACTORY_BLOCKS);
    }

    // bank 'A'|'B'|'C', pad 1-16 (Pad1 = bottom-left), slot 'hit'|'idle'
    getPadColor(bank, pad, slot) {
        const { data, byte, shift } = this.#locate(bank, pad, slot);
        return COLORS[(data[byte] >> shift) & 0x0f] ?? (data[byte] >> shift) & 0x0f;
    }

    setPadColor(bank, pad, slot, color) {
        const { data, byte, shift } = this.#locate(bank, pad, slot);
        data[byte] = (data[byte] & ~(0x0f << shift)) | (colorIndex(color) << shift);
        return this;
    }

    // { A: { hit: [16 colours], idle: [16 colours] }, B: …, C: … }
    getAllColors() {
        return Object.fromEntries(BANKS.map((bank) => [bank, Object.fromEntries(
            SLOTS.map((slot) => [slot, Array.from({ length: 16 }, (_, i) => this.getPadColor(bank, i + 1, slot))]))]));
    }

    toJSON() {
        return { blocks: this.blocks };
    }

    static fromJSON(json) {
        return new StarrypadConfig(json.blocks);
    }

    #locate(bank, pad, slot) {
        const entry = COLOR_SETS[String(bank).toUpperCase()];
        if (!entry) throw new Error(`Unknown bank "${bank}" (use A, B or C)`);
        if (!(Number.isInteger(pad) && pad >= 1 && pad <= 16)) throw new Error(`Pad must be 1-16, got ${pad}`);
        const s = SLOTS.indexOf(slot);
        if (s < 0) throw new Error(`Slot must be "hit" or "idle", got "${slot}"`);
        const [blockId, ...offsets] = entry;
        const k = pad - 1;
        return { data: this.blocks[blockId], byte: offsets[s] + (k >> 1), shift: (k & 1) * 4 };
    }

    toMessages() {
        return BLOCK_IDS.map((id) => [...HEADER, CMD.DATA, 0x00, id, ...this.blocks[id], 0xf7]);
    }
}

export function handshakeMessage(a, b) {
    return [...HEADER, CMD.HANDSHAKE, a & 0x7f, b & 0x7f, 0xf7];
}

export function expectedHandshakeReply(a, b) {
    return [Math.trunc(((a + 3) * a + 10) / (b + 1)) & 0x7f, Math.trunc(((b + 5) * b + 7) / (a + 2)) & 0x7f];
}

export const dumpRequestMessage = () => [...HEADER, CMD.REQUEST_DUMP, 0x00, 0xf7];

// Returns { type: 'block', id, data } | { type: 'handshake', x, y } | null
export function parseMessage(m) {
    if (m.length < 5 || m[0] !== 0xf0 || m[1] !== 0x43 || m[2] !== 0x56) return null;
    const body = m.slice(3, m[m.length - 1] === 0xf7 ? -1 : undefined);
    if (body[0] === CMD.HANDSHAKE_REPLY) return { type: 'handshake', x: body[1], y: body[2] };
    if (body[0] === CMD.DATA && body.length >= 3) return { type: 'block', id: body[2], data: body.slice(3) };
    return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class StarrypadDevice {
    constructor(namePattern = /starry/i) {
        this.input = new midi.Input();
        this.output = new midi.Output();
        this.input.ignoreTypes(false, true, true);
        const find = (io) => [...Array(io.getPortCount()).keys()].find((i) => namePattern.test(io.getPortName(i)));
        const inPort = find(this.input);
        const outPort = find(this.output);
        if (inPort === undefined || outPort === undefined) throw new Error('STARRYPAD MIDI ports not found');
        this.input.openPort(inPort);
        this.output.openPort(outPort);
        this.listeners = new Set();
        this.input.on('message', (_dt, m) => this.listeners.forEach((fn) => fn(m)));
    }

    send(message) {
        this.output.sendMessage(message);
    }

    async handshake(timeoutMs = 500) {
        const a = Math.floor(Math.random() * 128);
        const b = Math.floor(Math.random() * 128);
        const [ex, ey] = expectedHandshakeReply(a, b);
        const reply = this.#waitFor((p) => p?.type === 'handshake', timeoutMs);
        this.send(handshakeMessage(a, b));
        const r = await reply;
        return r ? r.x === ex && r.y === ey : false;
    }

    // Resolves to a StarrypadConfig, or null if the pad does not answer.
    async readConfig(timeoutMs = 1500) {
        const blocks = {};
        const done = new Promise((resolve) => {
            const timer = setTimeout(() => finish(null), timeoutMs);
            const onMsg = (m) => {
                const p = parseMessage(m);
                if (p?.type !== 'block') return;
                blocks[p.id] = p.data;
                if (BLOCK_IDS.every((id) => blocks[id])) finish(new StarrypadConfig(blocks));
            };
            const finish = (v) => { clearTimeout(timer); this.listeners.delete(onMsg); resolve(v); };
            this.listeners.add(onMsg);
        });
        this.send(dumpRequestMessage());
        return done;
    }

    async writeConfig(config) {
        for (const m of config.toMessages()) {
            this.send(m);
            await sleep(WRITE_GAP_MS);
        }
    }

    #waitFor(predicate, timeoutMs) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => { this.listeners.delete(onMsg); resolve(null); }, timeoutMs);
            const onMsg = (m) => {
                const p = parseMessage(m);
                if (predicate(p)) { clearTimeout(timer); this.listeners.delete(onMsg); resolve(p); }
            };
            this.listeners.add(onMsg);
        });
    }

    close() {
        this.input.closePort();
        this.output.closePort();
    }
}
