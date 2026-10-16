// Prints everything the STARRYPAD sends, decoded – move a fader or turn a knob to see its CC and channel.
//
//   node tools/midi-monitor.js [--pressure]
//
//   --pressure  also print the channel-pressure stream the pads send while held (noisy)
//
// Control names follow the factory mapping (STARRYPAD-PROTOCOL.md §3).
import midi from 'midi';

const CONTROLS = {
    28: 'K1 (bank A)', 9: 'K2 (bank A)', 12: 'K1 (bank B)', 13: 'K2 (bank B)', 14: 'K1 (bank C)', 15: 'K2 (bank C)',
    20: 'F1 (bank A)', 21: 'F2 (bank A)', 22: 'F1 (bank B)', 23: 'F2 (bank B)', 24: 'F1 (bank C)', 25: 'F2 (bank C)',
    26: 'button 1', 27: 'button 2', 60: 'button Play', 62: 'button Rec',
};
const padName = (note) => (note >= 36 && note <= 83 ? `pad ${'ABC'[Math.floor((note - 36) / 16)]}${((note - 36) % 16) + 1}` : `note ${note}`);

function describe([status, a, b]) {
    const type = status & 0xf0;
    const channel = `ch${(status & 0x0f) + 1}`;
    if (type === 0x90 && b > 0) return `${channel} ${padName(a)} on, velocity ${b}`;
    if (type === 0x80 || type === 0x90) return `${channel} ${padName(a)} off`;
    if (type === 0xb0) return `${channel} CC ${a} = ${b}${CONTROLS[a] ? `  ${CONTROLS[a]}` : ''}`;
    if (type === 0xd0) return `${channel} pressure ${a}`;
    if (type === 0xa0) return `${channel} ${padName(a)} poly pressure ${b}`;
    return null;
}

const showPressure = process.argv.includes('--pressure');
const input = new midi.Input();
let port = -1;
for (let i = 0; i < input.getPortCount(); i++) if (/starry/i.test(input.getPortName(i))) port = i;
if (port < 0) {
    console.error('STARRYPAD not found.');
    process.exit(1);
}

input.ignoreTypes(false, true, true);
input.on('message', (_dt, message) => {
    if ((message[0] & 0xf0) === 0xd0 && !showPressure) return;
    const hex = message.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`${hex.padEnd(10)} ${describe(message) ?? (message[0] === 0xf0 ? `SysEx, ${message.length} bytes` : '')}`);
});
input.openPort(port);
console.log(`Listening on ${input.getPortName(port)} – Ctrl-C to stop.`);
// The input stays referenced by the listener for the whole process (closing node-midi inputs early crashes).
