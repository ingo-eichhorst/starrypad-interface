class StarrypadApp {
    constructor() {
        this.socket = null;
        this.isConnected = false;
        this.debugMode = true;
        this.padMapping = {};
        this.midiDevice = null;
        this.audioContext = null;
        this.sounds = {};
        
        this.init();
    }
    
    init() {
        this.connectWebSocket();
        this.setupEventListeners();
        this.updateDebugPanel();
        this.initializeAudio();
        this.initColorEditor();
    }
    
    connectWebSocket() {
        // WebSocket only: the long-polling transport kept dropping with "transport error" (local app, no fallback needed)
        this.socket = io({ transports: ['websocket'] });
        
        this.socket.on('connect', () => {
            this.isConnected = true;
            this.updateConnectionStatus('ws', true);
            console.log('Connected to server');
        });
        
        this.socket.on('disconnect', () => {
            this.isConnected = false;
            this.updateConnectionStatus('ws', false);
            console.log('Disconnected from server');
        });
        
        // Handle server events
        this.socket.on('status', (data) => this.handleStatus(data));
        this.socket.on('midiConnected', (data) => this.handleMidiConnected(data));
        this.socket.on('padHit', (data) => this.handlePadHit(data));
        this.socket.on('debugMIDI', (data) => this.handleDebugMidi(data));
        this.socket.on('unknownNote', (data) => this.handleUnknownNote(data));
        this.socket.on('debugModeChanged', (data) => this.handleDebugModeChanged(data));
        this.socket.on('padColors', (data) => this.handlePadColors(data.colors));
    }
    
    setupEventListeners() {
        // Debug toggle button
        document.getElementById('debug-toggle').addEventListener('click', () => {
            this.toggleDebugMode();
        });
        
        // Clear log button
        document.getElementById('clear-log').addEventListener('click', () => {
            this.clearMidiLog();
        });
        
        // Pad click simulation (for testing)
        document.querySelectorAll('.pad').forEach(pad => {
            pad.addEventListener('click', () => {
                const padId = parseInt(pad.dataset.padId);
                this.simulatePadHit(padId);
            });
        });
    }
    
    handleStatus(data) {
        this.debugMode = data.debugMode;
        this.padMapping = data.padMapping;
        this.midiDevice = data.deviceName;
        
        this.updateConnectionStatus('midi', data.midiConnected);
        this.updateDebugPanel();
        this.updateDeviceInfo();
        this.updateNoteMappingDisplay();
        
        this.addActivityEntry(`Status updated: MIDI ${data.midiConnected ? 'connected' : 'disconnected'}`);
    }
    
    handleMidiConnected(data) {
        this.midiDevice = data.deviceName;
        this.updateConnectionStatus('midi', true);
        this.updateDeviceInfo();
        this.addActivityEntry(`MIDI device connected: ${data.deviceName}`);
    }
    
    handlePadHit(data) {
        this.flashPad(data.id, data.velocity);
        this.playSound(data.sound, data.velocity);
        this.addActivityEntry(`${data.name} hit (velocity: ${data.velocity})`, 'pad-hit');
        
        // Add to MIDI log if debug mode is on
        if (this.debugMode) {
            this.addMidiLogEntry(`PAD HIT: ${data.name} | Note: ${this.getNoteForPad(data.id)} | Velocity: ${data.velocity}`, 'midi-note');
        }
    }
    
    handleDebugMidi(data) {
        if (this.debugMode) {
            this.addMidiLogEntry(`Note: ${data.note} | Velocity: ${data.velocity} | Channel: ${data.channel}`, 'midi-note');
        }
    }
    
    handleUnknownNote(data) {
        if (this.debugMode) {
            this.addMidiLogEntry(`UNKNOWN: Note ${data.note} | Velocity: ${data.velocity} | Channel: ${data.channel}`, 'unknown-note');
        }
    }
    
    handleDebugModeChanged(data) {
        this.debugMode = data.debugMode;
        this.updateDebugPanel();
        this.addActivityEntry(`Debug mode ${this.debugMode ? 'enabled' : 'disabled'}`);
    }
    
    toggleDebugMode() {
        this.socket.emit('toggleDebug');
    }
    
    flashPad(padId, velocity = 127) {
        const pad = document.querySelector(`[data-pad-id="${padId}"]`);
        if (!pad) return;
        
        // Remove existing animation class
        pad.classList.remove('hit');
        
        // Force reflow to restart animation
        void pad.offsetWidth;
        
        // Add animation class
        pad.classList.add('hit');
        
        // Adjust flash intensity based on velocity
        const light = pad.querySelector('.pad-light');
        const intensity = Math.max(0.3, velocity / 127);
        light.style.opacity = intensity;
        
        // Remove animation class after animation completes
        setTimeout(() => {
            pad.classList.remove('hit');
            light.style.opacity = '0';
        }, 300);
    }
    
    simulatePadHit(padId) {
        // Simulate a pad hit for testing (when clicked)
        const pad = document.querySelector(`[data-pad-id="${padId}"]`);
        const sound = pad ? pad.dataset.sound : 'kick1';
        
        this.flashPad(padId, 100);
        this.playSound(sound, 100);
        this.addActivityEntry(`Pad ${padId} clicked (simulation)`, 'pad-hit');
    }
    
    initializeAudio() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            console.log('Audio context initialized');
            this.addActivityEntry('Audio system initialized');
        } catch (error) {
            console.error('Failed to initialize audio context:', error);
            this.addActivityEntry('Audio system failed to initialize');
        }
    }
    
    // Generate synthetic drum sounds using Web Audio API
    createSynthSound(type, frequency, duration, velocity) {
        if (!this.audioContext) return;
        
        const volume = Math.max(0.1, velocity / 127);
        const gainNode = this.audioContext.createGain();
        gainNode.connect(this.audioContext.destination);
        
        switch (type) {
            case 'kick':
                this.createKickSound(gainNode, frequency, duration, volume);
                break;
            case 'snare':
                this.createSnareSound(gainNode, frequency, duration, volume);
                break;
            case 'hihat':
                this.createHihatSound(gainNode, duration, volume);
                break;
            case 'crash':
                this.createCrashSound(gainNode, duration, volume);
                break;
            case 'tom':
                this.createTomSound(gainNode, frequency, duration, volume);
                break;
            case 'perc':
                this.createPercSound(gainNode, frequency, duration, volume);
                break;
            default:
                this.createKickSound(gainNode, frequency, duration, volume);
        }
    }
    
    createKickSound(gainNode, frequency, duration, volume) {
        const osc = this.audioContext.createOscillator();
        const oscGain = this.audioContext.createGain();
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(frequency, this.audioContext.currentTime);
        osc.frequency.exponentialRampToValueAtTime(20, this.audioContext.currentTime + 0.1);
        
        oscGain.gain.setValueAtTime(volume, this.audioContext.currentTime);
        oscGain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + duration);
        
        osc.connect(oscGain);
        oscGain.connect(gainNode);
        
        osc.start();
        osc.stop(this.audioContext.currentTime + duration);
    }
    
    createSnareSound(gainNode, frequency, duration, volume) {
        // Tone component
        const osc = this.audioContext.createOscillator();
        const oscGain = this.audioContext.createGain();
        
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(frequency, this.audioContext.currentTime);
        
        oscGain.gain.setValueAtTime(volume * 0.3, this.audioContext.currentTime);
        oscGain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + duration);
        
        osc.connect(oscGain);
        oscGain.connect(gainNode);
        
        // Noise component
        const bufferSize = this.audioContext.sampleRate * duration;
        const noiseBuffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        
        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }
        
        const noiseSource = this.audioContext.createBufferSource();
        const noiseGain = this.audioContext.createGain();
        const noiseFilter = this.audioContext.createBiquadFilter();
        
        noiseSource.buffer = noiseBuffer;
        noiseFilter.type = 'highpass';
        noiseFilter.frequency.value = 1000;
        
        noiseGain.gain.setValueAtTime(volume * 0.7, this.audioContext.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + duration);
        
        noiseSource.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(gainNode);
        
        osc.start();
        noiseSource.start();
        osc.stop(this.audioContext.currentTime + duration);
        noiseSource.stop(this.audioContext.currentTime + duration);
    }
    
    createHihatSound(gainNode, duration, volume) {
        const bufferSize = this.audioContext.sampleRate * duration;
        const noiseBuffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        
        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }
        
        const noiseSource = this.audioContext.createBufferSource();
        const noiseGain = this.audioContext.createGain();
        const filter = this.audioContext.createBiquadFilter();
        
        noiseSource.buffer = noiseBuffer;
        filter.type = 'highpass';
        filter.frequency.value = 7000;
        
        noiseGain.gain.setValueAtTime(volume, this.audioContext.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + duration);
        
        noiseSource.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(gainNode);
        
        noiseSource.start();
        noiseSource.stop(this.audioContext.currentTime + duration);
    }
    
    createCrashSound(gainNode, duration, volume) {
        const bufferSize = this.audioContext.sampleRate * duration;
        const noiseBuffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        
        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }
        
        const noiseSource = this.audioContext.createBufferSource();
        const noiseGain = this.audioContext.createGain();
        const filter = this.audioContext.createBiquadFilter();
        
        noiseSource.buffer = noiseBuffer;
        filter.type = 'bandpass';
        filter.frequency.value = 3000;
        filter.Q.value = 0.5;
        
        noiseGain.gain.setValueAtTime(volume, this.audioContext.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + duration * 3);
        
        noiseSource.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(gainNode);
        
        noiseSource.start();
        noiseSource.stop(this.audioContext.currentTime + duration * 3);
    }
    
    createTomSound(gainNode, frequency, duration, volume) {
        const osc = this.audioContext.createOscillator();
        const oscGain = this.audioContext.createGain();
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(frequency, this.audioContext.currentTime);
        osc.frequency.exponentialRampToValueAtTime(frequency * 0.5, this.audioContext.currentTime + duration);
        
        oscGain.gain.setValueAtTime(volume, this.audioContext.currentTime);
        oscGain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + duration);
        
        osc.connect(oscGain);
        oscGain.connect(gainNode);
        
        osc.start();
        osc.stop(this.audioContext.currentTime + duration);
    }
    
    createPercSound(gainNode, frequency, duration, volume) {
        const osc = this.audioContext.createOscillator();
        const oscGain = this.audioContext.createGain();
        
        osc.type = 'square';
        osc.frequency.setValueAtTime(frequency, this.audioContext.currentTime);
        
        oscGain.gain.setValueAtTime(volume, this.audioContext.currentTime);
        oscGain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + duration);
        
        osc.connect(oscGain);
        oscGain.connect(gainNode);
        
        osc.start();
        osc.stop(this.audioContext.currentTime + duration);
    }
    
    playSound(soundType, velocity = 127) {
        if (!this.audioContext) return;
        
        // Resume audio context if it's suspended (browser policy)
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
        
        const soundMap = {
            kick1: () => this.createSynthSound('kick', 60, 0.5, velocity),
            kick2: () => this.createSynthSound('kick', 45, 0.6, velocity),
            snare1: () => this.createSynthSound('snare', 200, 0.2, velocity),
            snare2: () => this.createSynthSound('snare', 180, 0.25, velocity),
            hihat1: () => this.createSynthSound('hihat', 0, 0.1, velocity),
            hihat2: () => this.createSynthSound('hihat', 0, 0.05, velocity),
            crash1: () => this.createSynthSound('crash', 0, 1.5, velocity),
            crash2: () => this.createSynthSound('crash', 0, 2.0, velocity),
            tom1: () => this.createSynthSound('tom', 150, 0.4, velocity),
            tom2: () => this.createSynthSound('tom', 120, 0.5, velocity),
            tom3: () => this.createSynthSound('tom', 100, 0.6, velocity),
            tom4: () => this.createSynthSound('tom', 80, 0.7, velocity),
            perc1: () => this.createSynthSound('perc', 800, 0.1, velocity),
            perc2: () => this.createSynthSound('perc', 600, 0.15, velocity),
            perc3: () => this.createSynthSound('perc', 400, 0.2, velocity),
            perc4: () => this.createSynthSound('perc', 300, 0.25, velocity)
        };
        
        const playFunction = soundMap[soundType];
        if (playFunction) {
            playFunction();
        } else {
            // Default to kick sound
            this.createSynthSound('kick', 60, 0.5, velocity);
        }
    }
    
    updateConnectionStatus(type, connected) {
        const statusElement = document.getElementById(`${type}-status`);
        if (statusElement) {
            statusElement.textContent = `${type.toUpperCase()}: ${connected ? '✅' : '❌'}`;
        }
    }
    
    updateDebugPanel() {
        const debugPanel = document.getElementById('debug-panel');
        const debugToggle = document.getElementById('debug-toggle');
        
        if (this.debugMode) {
            debugPanel.classList.remove('hidden');
            debugToggle.textContent = 'Debug Mode: ON';
            debugToggle.classList.remove('off');
        } else {
            debugPanel.classList.add('hidden');
            debugToggle.textContent = 'Debug Mode: OFF';
            debugToggle.classList.add('off');
        }
    }
    
    updateDeviceInfo() {
        const deviceInfo = document.getElementById('device-info');
        if (this.midiDevice) {
            deviceInfo.innerHTML = `
                <strong>Connected:</strong> ${this.midiDevice}<br>
                <small>Status: Active and receiving MIDI data</small>
            `;
        } else {
            deviceInfo.innerHTML = '<span style="color: #ff6b6b;">No MIDI device connected</span>';
        }
    }
    
    updateNoteMappingDisplay() {
        const mappingContainer = document.getElementById('note-mapping');
        mappingContainer.innerHTML = '';
        
        Object.entries(this.padMapping).forEach(([note, padData]) => {
            const mappingItem = document.createElement('div');
            mappingItem.className = 'mapping-item';
            mappingItem.innerHTML = `
                <span class="mapping-note">Note ${note}</span>
                <span class="mapping-pad">${padData.name}</span>
            `;
            mappingContainer.appendChild(mappingItem);
        });
    }
    
    addMidiLogEntry(message, type = '') {
        const midiLog = document.getElementById('midi-log');
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.textContent = `${this.getTimestamp()} ${message}`;
        
        midiLog.appendChild(entry);
        midiLog.scrollTop = midiLog.scrollHeight;
        
        // Limit log entries to prevent memory issues
        const entries = midiLog.querySelectorAll('.log-entry');
        if (entries.length > 100) {
            entries[0].remove();
        }
    }
    
    addActivityEntry(message, type = '') {
        const activityLog = document.getElementById('activity-log');
        const entry = document.createElement('div');
        entry.className = `activity-entry ${type}`;
        
        const timestamp = document.createElement('span');
        timestamp.className = 'timestamp';
        timestamp.textContent = this.getTimestamp();
        
        entry.textContent = message;
        entry.appendChild(timestamp);
        
        activityLog.insertBefore(entry, activityLog.firstChild);
        
        // Limit activity entries
        const entries = activityLog.querySelectorAll('.activity-entry');
        if (entries.length > 50) {
            entries[entries.length - 1].remove();
        }
    }
    
    clearMidiLog() {
        const midiLog = document.getElementById('midi-log');
        midiLog.innerHTML = '<div class="log-entry">MIDI log cleared</div>';
    }
    
    getNoteForPad(padId) {
        // Find the MIDI note that corresponds to this pad ID
        for (const [note, padData] of Object.entries(this.padMapping)) {
            if (padData.id === padId) {
                return note;
            }
        }
        return 'Unknown';
    }
    
    // ---- Pad LED colours (persistent device config via /api/pads/colors) ----
    initColorEditor() {
        this.colorHex = {
            off: '#222222', red: '#ff3b3b', green: '#2bff6a', blue: '#3b7bff',
            yellow: '#ffe23b', purple: '#c43bff', cyan: '#3bf6ff', white: '#ffffff'
        };
        this.padColors = null;     // { A: { hit: [16], idle: [16] }, B: ..., C: ... } as stored on the pad
        this.pendingColors = {};   // "A:1" -> { hit?, idle? } not yet sent
        this.colorBank = 'A';
        this.selectedPads = new Set();

        // Physical layout: Pad13-16 on top, Pad1-4 at the bottom
        const grid = document.getElementById('color-grid');
        for (let row = 3; row >= 0; row--) {
            for (let col = 1; col <= 4; col++) {
                const pad = row * 4 + col;
                const cell = document.createElement('div');
                cell.className = 'color-cell';
                cell.dataset.pad = pad;
                cell.textContent = pad;
                cell.addEventListener('click', () => {
                    if (this.selectedPads.has(pad)) this.selectedPads.delete(pad);
                    else this.selectedPads.add(pad);
                    this.renderColorEditor();
                });
                grid.appendChild(cell);
            }
        }

        document.querySelectorAll('.palette').forEach(palette => {
            for (const [name, hex] of Object.entries(this.colorHex)) {
                const swatch = document.createElement('div');
                swatch.className = name === 'off' ? 'swatch off' : 'swatch';
                if (name !== 'off') swatch.style.background = hex;
                swatch.title = name;
                swatch.addEventListener('click', () => this.applyColor(palette.dataset.slot, name));
                palette.appendChild(swatch);
            }
        });

        document.querySelectorAll('.bank-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.colorBank = tab.dataset.bank;
                this.selectedPads.clear();
                this.renderColorEditor();
            });
        });
        document.getElementById('colors-select-all').addEventListener('click', () => {
            if (this.selectedPads.size === 16) this.selectedPads.clear();
            else for (let pad = 1; pad <= 16; pad++) this.selectedPads.add(pad);
            this.renderColorEditor();
        });
        document.getElementById('colors-load').addEventListener('click', () => this.loadPadColors());
        document.getElementById('colors-send').addEventListener('click', () => this.sendPadColors());

        this.renderColorEditor();
        this.loadPadColors();
    }

    effectiveColor(bank, pad, slot) {
        return this.pendingColors[`${bank}:${pad}`]?.[slot]
            ?? this.padColors?.[bank]?.[slot]?.[pad - 1]
            ?? 'off';
    }

    applyColor(slot, color) {
        if (this.selectedPads.size === 0) {
            this.setColorStatus('Select one or more pads first.');
            return;
        }
        for (const pad of this.selectedPads) {
            const key = `${this.colorBank}:${pad}`;
            this.pendingColors[key] = { ...this.pendingColors[key], [slot]: color };
        }
        this.renderColorEditor();
        this.setColorStatus(`${Object.keys(this.pendingColors).length} pad(s) changed – click "Send to pad".`);
    }

    renderColorEditor() {
        document.querySelectorAll('.bank-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.bank === this.colorBank);
        });
        document.querySelectorAll('.color-cell').forEach(cell => {
            const pad = Number(cell.dataset.pad);
            cell.style.setProperty('--hit', this.colorHex[this.effectiveColor(this.colorBank, pad, 'hit')]);
            cell.style.setProperty('--idle', this.colorHex[this.effectiveColor(this.colorBank, pad, 'idle')]);
            cell.classList.toggle('selected', this.selectedPads.has(pad));
            cell.classList.toggle('dirty', Boolean(this.pendingColors[`${this.colorBank}:${pad}`]));
        });

        // Mirror bank A's stored colours on the big pads (Pad1 = note 36 = bottom-left = pad id 12)
        if (!this.padColors) return;
        for (let pad = 1; pad <= 16; pad++) {
            const id = (3 - Math.floor((pad - 1) / 4)) * 4 + ((pad - 1) % 4);
            const el = document.querySelector(`.pad[data-pad-id="${id}"]`);
            if (!el) continue;
            el.style.setProperty('--pad-hit', this.colorHex[this.padColors.A.hit[pad - 1]]);
            el.style.setProperty('--pad-idle', this.colorHex[this.padColors.A.idle[pad - 1]]);
        }
    }

    handlePadColors(colors) {
        this.padColors = colors;
        this.renderColorEditor();
    }

    async loadPadColors() {
        this.setColorStatus('Reading colours from pad…');
        try {
            const res = await fetch('/api/pads/colors');
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            this.pendingColors = {};
            this.handlePadColors(data.colors);
            this.setColorStatus('Loaded from pad.');
        } catch (error) {
            this.setColorStatus(`⚠️ ${error.message}`);
        }
    }

    async sendPadColors() {
        const changes = Object.entries(this.pendingColors).map(([key, colors]) => {
            const [bank, pad] = key.split(':');
            return { bank, pad: Number(pad), ...colors };
        });
        if (changes.length === 0) {
            this.setColorStatus('Nothing to send.');
            return;
        }
        this.setColorStatus('Writing to pad…');
        try {
            const res = await fetch('/api/pads/colors', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ changes })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            this.pendingColors = {};
            this.handlePadColors(data.colors);
            this.setColorStatus('Saved on pad ✓');
            this.addActivityEntry(`Pad colours updated (${changes.length} pad(s))`);
        } catch (error) {
            this.setColorStatus(`⚠️ ${error.message}`);
        }
    }

    setColorStatus(text) {
        document.getElementById('colors-status').textContent = text;
    }

    getTimestamp() {
        const now = new Date();
        return now.toLocaleTimeString('en-US', { 
            hour12: false, 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
        });
    }
}

// Initialize the app when the page loads
document.addEventListener('DOMContentLoaded', () => {
    window.starrypadApp = new StarrypadApp();
});