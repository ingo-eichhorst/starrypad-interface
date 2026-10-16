// Keeps a STARRYPAD connected for a long-running app (see ../STARRYPAD-PROTOCOL.md §7):
// - opens its MIDI input and picks the pad up again after it was unplugged,
// - decodes notes and CCs into 'midi' events,
// - queues SysEx config reads/writes so they never overlap, and lets writes wait for a quiet pad
//   (SysEx while the pad is sending, e.g. a fader still moving, makes it reboot).
//
// Events: 'midi' { type: 'noteon'|'noteoff'|'cc', channel, number, value }, 'message' (raw bytes),
//         'connected' { name, index }, 'disconnected' { name }
import { EventEmitter } from 'node:events';
import midi from 'midi';
import { StarrypadDevice } from './starrypad.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withStatus = (error, status) => Object.assign(error, { status });

export class StarrypadConnection extends EventEmitter {
    // match: input port names to connect to; sysexPort: the exact port name for config reads/writes
    // (tools such as midi-proxy add ports like "STARRYPAD Proxy"); fallbackToFirst: without a pad,
    // open the first MIDI input instead (handy for testing with another controller).
    constructor({ match = /starry|donner|pad/i, sysexPort = /^STARRYPAD$/, pollMs = 2000, fallbackToFirst = true, log = console.log } = {}) {
        super();
        Object.assign(this, { match, sysexPort, pollMs, fallbackToFirst, log });
        this.input = new midi.Input();
        this.portName = null;
        this.configQueue = Promise.resolve();
        this.lastMessageAt = 0;
        this.device = null; // SysEx device, opened on the first config request
        this.retired = []; // closed node-midi objects crash the process when garbage-collected – keep them
        this.input.on('message', (deltaTime, message) => this.#onMessage(deltaTime, message));
    }

    start() {
        const names = this.ports();
        names.forEach((name) => this.log(`Found MIDI device: ${name}`));
        const index = names.findIndex((name) => this.match.test(name));
        if (index >= 0) this.connect(index);
        else if (this.fallbackToFirst && names.length > 0) {
            this.log('No STARRYPAD found, connecting to the first MIDI input for testing');
            this.connect(0);
        }
        this.timer = setInterval(() => this.#check(), this.pollMs);
        return this;
    }

    get connected() {
        return this.portName !== null;
    }

    ports() {
        return Array.from({ length: this.input.getPortCount() }, (_, i) => this.input.getPortName(i));
    }

    connect(index) {
        try {
            if (this.portName) this.input.closePort();
            this.input.openPort(index);
            this.portName = this.input.getPortName(index);
            this.log(`Connected to MIDI device: ${this.portName}`);
            this.emit('connected', { name: this.portName, index });
            return true;
        } catch (error) {
            this.log(`Failed to connect to MIDI device ${index}: ${error.message}`);
            this.portName = null;
            return false;
        }
    }

    // Runs fn(config, device) with a freshly read StarrypadConfig; calls are queued.
    withConfig(fn) {
        const run = this.configQueue.then(async () => {
            this.device ??= new StarrypadDevice(this.sysexPort);
            await this.device.handshake();
            // The pad sometimes ignores the first request after a quiet spell – ask twice.
            const config = await this.device.readConfig() ?? await this.device.readConfig();
            if (!config) throw withStatus(new Error('Pad did not answer the config request (try replugging it)'), 503);
            return fn(config, this.device);
        });
        this.configQueue = run.catch(() => {});
        return run;
    }

    // Resolves once the pad has sent nothing for quietMs; gives up after maxMs.
    async waitForIdle(quietMs = 1500, maxMs = 20000) {
        const started = Date.now();
        while (Date.now() - this.lastMessageAt < quietMs) {
            if (Date.now() - started > maxMs) throw withStatus(new Error('Pad does not go quiet – colours left unchanged'), 503);
            await sleep(100);
        }
    }

    // Writes a whole config built by edit(config) once the pad is quiet, then verifies it.
    async writeConfig(edit) {
        await this.waitForIdle();
        return this.withConfig(async (config, device) => {
            edit(config);
            await device.writeConfig(config);
            const check = await device.readConfig();
            if (!check || JSON.stringify(check.blocks) !== JSON.stringify(config.blocks)) {
                throw new Error('Config written but read-back did not match');
            }
            return check;
        });
    }

    // changes: [{ bank: 'A', pad: 1, hit: 'red', idle: 'off' }, ...] → all colours after the write
    async updateColors(changes) {
        if (!Array.isArray(changes) || changes.length === 0) {
            throw withStatus(new Error('Expected { changes: [{ bank, pad, hit?, idle? }] }'), 400);
        }
        const check = await this.writeConfig((config) => {
            try {
                for (const { bank, pad, hit, idle } of changes) {
                    if (hit !== undefined) config.setPadColor(bank, Number(pad), 'hit', hit);
                    if (idle !== undefined) config.setPadColor(bank, Number(pad), 'idle', idle);
                }
            } catch (error) {
                throw withStatus(error, 400);
            }
        });
        return check.getAllColors();
    }

    close() {
        clearInterval(this.timer);
        if (this.portName) this.input.closePort();
        this.portName = null;
        this.#retireDevice();
    }

    #onMessage(deltaTime, message) {
        this.lastMessageAt = Date.now();
        this.emit('message', message, deltaTime);
        const [status, number, value] = message;
        const kind = status >> 4;
        if (kind === 8 || kind === 9 || kind === 11) {
            const type = kind === 11 ? 'cc' : kind === 9 && value > 0 ? 'noteon' : 'noteoff';
            this.emit('midi', { type, channel: status & 0x0f, number, value });
        }
    }

    // Survive unplugging on stage: drop a vanished device and pick the pad up again when it returns
    // (also switches from a fallback device to the pad once it is plugged in).
    #check() {
        const names = this.ports();
        if (this.portName && !names.includes(this.portName)) {
            const name = this.portName;
            this.log(`MIDI device disconnected: ${name}`);
            this.input.closePort();
            this.portName = null;
            this.#retireDevice(); // its ports are stale after a replug; reopen on the next config request
            this.emit('disconnected', { name });
        }
        if (!this.portName || !this.match.test(this.portName)) {
            const index = names.findIndex((name) => this.match.test(name));
            if (index >= 0) this.connect(index);
        }
    }

    #retireDevice() {
        if (!this.device) return;
        this.device.close();
        this.retired.push(this.device);
        this.device = null;
    }
}
