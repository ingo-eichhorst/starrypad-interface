// Logging MIDI proxy between an app (e.g. Donner's STARRYPAD Editor) and the real pad.
//   node tools/midi-proxy.js [logfile]
// Creates virtual ports "STARRYPAD Proxy" (in + out). In the app, pick "STARRYPAD Proxy"
// as MIDI In and MIDI Out; everything is forwarded to/from the real STARRYPAD and logged.
import midi from 'midi';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logFile = process.argv[2] ?? path.join(__dirname, '..', 'captures', `proxy-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
fs.mkdirSync(path.dirname(logFile), { recursive: true });
const log = fs.createWriteStream(logFile, { flags: 'a' });

const hex = (a) => a.map((b) => b.toString(16).padStart(2, '0')).join(' ');
const t0 = Date.now();
const record = (dir, m) => {
    const line = `${((Date.now() - t0) / 1000).toFixed(3).padStart(8)}  ${dir}  (${m.length})  ${hex(m)}`;
    console.log(line);
    log.write(line + '\n');
};

const findPort = (io) => [...Array(io.getPortCount()).keys()].find((i) => io.getPortName(i) === 'STARRYPAD');
const realIn = new midi.Input();
const realOut = new midi.Output();
const inPort = findPort(realIn);
const outPort = findPort(realOut);
if (inPort === undefined || outPort === undefined) {
    console.error('Real STARRYPAD ports not found');
    process.exit(1);
}

const virtIn = new midi.Input();   // app sends here
const virtOut = new midi.Output(); // app listens here
for (const i of [realIn, virtIn]) i.ignoreTypes(false, true, true);

virtIn.on('message', (_dt, m) => { record('APP -> PAD', m); realOut.sendMessage(m); });
realIn.on('message', (_dt, m) => { record('PAD -> APP', m); virtOut.sendMessage(m); });

realIn.openPort(inPort);
realOut.openPort(outPort);
virtIn.openVirtualPort('STARRYPAD Proxy');
virtOut.openVirtualPort('STARRYPAD Proxy');
console.log(`Proxy up. Select "STARRYPAD Proxy" as MIDI In/Out in the app. Logging to ${logFile}`);

const shutdown = () => {
    for (const p of [realIn, realOut, virtIn, virtOut]) p.closePort();
    log.end(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
