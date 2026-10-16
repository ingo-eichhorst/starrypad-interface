import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { StarrypadConnection } from './lib/connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class StarrypadInterface {
    constructor() {
        this.app = express();
        this.server = createServer(this.app);
        this.io = new Server(this.server, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            }
        });

        this.port = process.env.PORT || 3001;
        this.pad = new StarrypadConnection();
        this.debugMode = true; // Enable debug mode by default
        this.clients = new Set();

        // 4x4 MIDI mapping: note 36 is bottom-left, increments right then up
        this.padMapping = {
            // Row 1 (bottom)
            36: { id: 12, name: 'Kick 1', sound: 'kick1' },
            37: { id: 13, name: 'Kick 2', sound: 'kick2' },
            38: { id: 14, name: 'Snare 1', sound: 'snare1' },
            39: { id: 15, name: 'Snare 2', sound: 'snare2' },
            // Row 2
            40: { id: 8, name: 'Hihat 1', sound: 'hihat1' },
            41: { id: 9, name: 'Hihat 2', sound: 'hihat2' },
            42: { id: 10, name: 'Crash 1', sound: 'crash1' },
            43: { id: 11, name: 'Crash 2', sound: 'crash2' },
            // Row 3
            44: { id: 4, name: 'Tom 1', sound: 'tom1' },
            45: { id: 5, name: 'Tom 2', sound: 'tom2' },
            46: { id: 6, name: 'Tom 3', sound: 'tom3' },
            47: { id: 7, name: 'Tom 4', sound: 'tom4' },
            // Row 4 (top)
            48: { id: 0, name: 'Perc 1', sound: 'perc1' },
            49: { id: 1, name: 'Perc 2', sound: 'perc2' },
            50: { id: 2, name: 'Perc 3', sound: 'perc3' },
            51: { id: 3, name: 'Perc 4', sound: 'perc4' }
        };

        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
        this.setupMIDI();
    }

    setupMiddleware() {
        this.app.use(express.static(path.join(__dirname, 'public')));
        this.app.use(express.json());
    }

    setupRoutes() {
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });

        this.app.get('/api/status', (req, res) => {
            res.json({
                midiConnected: this.pad.connected,
                deviceName: this.pad.portName,
                debugMode: this.debugMode,
                padMapping: this.padMapping,
                connectedClients: this.clients.size
            });
        });

        this.app.get('/api/midi/devices', (req, res) => {
            res.json(this.pad.ports().map((name, id) => ({ id, name })));
        });

        this.app.post('/api/midi/connect/:deviceId', (req, res) => {
            const success = this.pad.connect(parseInt(req.params.deviceId));
            res.json({ success, deviceName: this.pad.portName });
        });

        // Pad LED colours (persistent device config, see STARRYPAD-PROTOCOL.md)
        this.app.get('/api/pads/colors', async (req, res) => {
            try {
                res.json({ colors: await this.pad.withConfig((cfg) => cfg.getAllColors()) });
            } catch (error) {
                res.status(error.status || 500).json({ error: error.message });
            }
        });

        // Body: { changes: [{ bank: 'A', pad: 1, hit: 'red', idle: 'off' }, ...] }
        this.app.put('/api/pads/colors', async (req, res) => {
            try {
                const colors = await this.pad.updateColors(req.body?.changes ?? []);
                console.log(`Pad colours updated (${req.body.changes.length} change(s))`);
                this.broadcastToClients('padColors', { colors });
                res.json({ colors });
            } catch (error) {
                res.status(error.status || 500).json({ error: error.message });
            }
        });

        this.app.post('/api/debug/toggle', (req, res) => {
            this.debugMode = !this.debugMode;
            this.broadcastToClients('debugModeChanged', { debugMode: this.debugMode });
            res.json({ debugMode: this.debugMode });
        });
    }

    setupWebSocket() {
        this.io.on('connection', (socket) => {
            console.log('Client connected:', socket.id);
            this.clients.add(socket);

            // Send current state to new client
            socket.emit('status', {
                midiConnected: this.pad.connected,
                deviceName: this.pad.portName,
                debugMode: this.debugMode,
                padMapping: this.padMapping
            });

            socket.on('disconnect', (reason) => {
                console.log('Client disconnected:', socket.id, `(${reason})`);
                this.clients.delete(socket);
            });

            socket.on('toggleDebug', () => {
                this.debugMode = !this.debugMode;
                this.broadcastToClients('debugModeChanged', { debugMode: this.debugMode });
            });
        });
    }

    setupMIDI() {
        this.pad.on('midi', (event) => this.handleMIDI(event));
        this.pad.on('connected', ({ name, index }) => this.broadcastToClients('midiConnected', { deviceName: name, deviceId: index }));
        this.pad.on('disconnected', () => this.broadcastToClients('midiDisconnected', {}));
        // Auto-connects to the pad and picks it up again after a replug (lib/connection.js)
        this.pad.start();
    }

    handleMIDI({ type, channel, number: note, value: velocity }) {
        // Raw notes and CCs for clients that do their own mapping (faders, knobs, buttons, other banks)
        this.broadcastToClients('midi', { type, channel, number: note, value: velocity });
        if (type === 'cc' && this.debugMode) console.log(`MIDI CC: ${note} = ${velocity}, Channel: ${channel}`);

        if (type === 'noteon') {
            const midiData = {
                note,
                velocity,
                channel,
                timestamp: Date.now()
            };

            if (this.debugMode) {
                console.log(`MIDI Note: ${note}, Velocity: ${velocity}, Channel: ${channel}`);
                this.broadcastToClients('debugMIDI', midiData);
            }

            // Check if this note is mapped to a pad
            if (this.padMapping[note]) {
                const padData = {
                    ...this.padMapping[note],
                    velocity,
                    timestamp: Date.now()
                };

                console.log(`Pad hit: ${padData.name} (Note ${note}), Velocity: ${velocity}`);
                this.broadcastToClients('padHit', padData);
            } else if (this.debugMode) {
                // Unknown note - show in debug
                this.broadcastToClients('unknownNote', midiData);
            }
        }
    }

    broadcastToClients(event, data) {
        this.io.emit(event, data);
    }

    start() {
        this.server.listen(this.port, () => {
            console.log(`🥁 Starrypad Interface running on http://localhost:${this.port}`);
            console.log(`Debug mode: ${this.debugMode ? 'ON' : 'OFF'}`);
            console.log('Features:');
            console.log('  - Real-time MIDI input from Starrypad');
            console.log('  - Visual drum pad interface');
            console.log('  - Pad LED colours over SysEx');
            console.log('  - Debug mode for MIDI note discovery');
            console.log('  - WebSocket communication');
        });
    }

    stop() {
        this.pad.close();
        this.server.close();
    }
}

// Create and start the application
const starrypadInterface = new StarrypadInterface();

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down Starrypad Interface...');
    starrypadInterface.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down Starrypad Interface...');
    starrypadInterface.stop();
    process.exit(0);
});

// Start the server
starrypadInterface.start();

export default StarrypadInterface;
