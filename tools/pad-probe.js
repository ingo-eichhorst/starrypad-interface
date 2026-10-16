// Interactive STARRYPAD probe — run it while watching the pad:
//   node tools/pad-probe.js
// 1. Listens 5 s for pad hits (verifies the MIDI-in path).
// 2. Sends the editor handshake + dump request (read-only) and logs any SysEx reply.
// 3. Plays numbered LED-feedback steps (Note On / CC to the pad) — note which step lights a pad.
import midi from 'midi';

const hex = (a) => a.map((b) => b.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const input = new midi.Input();
const output = new midi.Output();
const findPort = (io) => {
    for (let i = 0; i < io.getPortCount(); i++) if (/starry/i.test(io.getPortName(i))) return i;
    return -1;
};
const inPort = findPort(input);
const outPort = findPort(output);
if (inPort < 0 || outPort < 0) {
    console.error('STARRYPAD not found. Ports:', [...Array(input.getPortCount())].map((_, i) => input.getPortName(i)));
    process.exit(1);
}

let phase = 'idle';
let received = 0;
input.ignoreTypes(false, true, true); // keep SysEx
input.on('message', (_dt, m) => {
    received++;
    console.log(`  [${phase}] IN  ${hex(m)}`);
});
input.openPort(inPort);
output.openPort(outPort);
const send = (m) => output.sendMessage(m);

async function main() {
    phase = 'listen';
    console.log('\n=== STEP 0: tap a few pads now (5 s) ===');
    await sleep(5000);
    console.log(`  -> ${received} message(s) received from the pad`);

    phase = 'sysex';
    console.log('\n=== STEP 1: editor handshake + dump request (read-only) ===');
    const a = 17, b = 42;
    console.log(`  OUT f0 43 56 05 ${hex([a, b])} f7   (device should answer 06 ${hex([(((a + 3) * a + 10) / (b + 1) | 0) & 0x7f, (((b + 5) * b + 7) / (a + 2) | 0) & 0x7f])})`);
    send([0xf0, 0x43, 0x56, 0x05, a, b, 0xf7]);
    await sleep(500);
    console.log('  OUT f0 43 56 03 00 f7   (device should answer with 13 blocks f0 43 56 02 ..)');
    send([0xf0, 0x43, 0x56, 0x03, 0x00, 0xf7]);
    await sleep(2000);

    phase = 'leds';
    const steps = [];
    const allNotes = (status, vel) => () => { for (let n = 36; n <= 51; n++) send([status, n, vel]); };
    const allOff = (ch) => () => { for (let n = 36; n <= 51; n++) send([0x80 | ch, n, 0]); };
    steps.push(['all 16 pads Note On ch10 vel 127', allNotes(0x99, 127), allOff(9)]);
    steps.push(['all 16 pads Note On ch1 vel 127', allNotes(0x90, 127), allOff(0)]);
    steps.push(['all 16 pads Note On on every channel 1-16 vel 127',
        () => { for (let ch = 0; ch < 16; ch++) allNotes(0x90 | ch, 127)(); },
        () => { for (let ch = 0; ch < 16; ch++) allOff(ch)(); }]);
    steps.push(['LED-index notes 0-15 ch1 vel 127',
        () => { for (let n = 0; n < 16; n++) send([0x90, n, 127]); },
        () => { for (let n = 0; n < 16; n++) send([0x80, n, 0]); }]);
    for (const v of [1, 5, 9, 13, 17, 21, 33, 45, 60, 64, 80, 100, 127]) {
        steps.push([`pad note 36 ch10 vel ${v}`, () => send([0x99, 36, v]), () => send([0x89, 36, 0])]);
    }
    steps.push(['CC 36-51 = 127 on ch10', () => { for (let n = 36; n <= 51; n++) send([0xb9, n, 127]); },
        () => { for (let n = 36; n <= 51; n++) send([0xb9, n, 0]); }]);

    console.log('\n=== STEP 2: LED feedback — watch the pads ===');
    for (let i = 0; i < steps.length; i++) {
        const [label, on, off] = steps[i];
        console.log(`  2.${i + 1}  ${label}`);
        on();
        await sleep(1500);
        off();
        await sleep(400);
    }
    console.log('\nDone. Report which step numbers (if any) changed a pad light, and the colour.');
    input.closePort();
    output.closePort();
    process.exit(0);
}

main();
