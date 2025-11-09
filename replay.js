import Board from './board.js';
import * as recorder from './recorder.js';
import { playSound, playBackgroundMusic } from './audio.js';

export default class Replay {
    constructor(game, config) {
        this.game = game;
        this.config = config;
        this.replayBgmControl = null;
        this.controlsTimeout = null;
        this.animationFrameId = null;
        this.lastFrameTime = 0;
        this.state = {
            isPlaying: false,
            isPaused: true,
            currentTime: 0,
            duration: 0,
            actions: [],
            actionIndex: 0,
            initialState: null,
            currentReplayBoard: null,
        };

        this.setupUI();
    }

    setupUI() {
        document.getElementById('clip-button').addEventListener('click', () => this.show());
        document.getElementById('close-replay-button').addEventListener('click', () => this.hide());
        const replayContainer = document.getElementById('replay-container');
        replayContainer.addEventListener('click', (e) => this.handleContainerClick(e));
        replayContainer.addEventListener('pointermove', () => this.showControls());

        const scrubber = document.getElementById('replay-scrubber');
        scrubber.addEventListener('input', (e) => this.handleScrub(e));
    }

    handleContainerClick(e) {
        // Prevent pause/play when scrubbing
        if (e.target.id === 'replay-scrubber') return;

        if (!this.state.isPlaying) return;
        this.togglePlayback();
    }

    handleScrub(e) {
        this.pause();
        const time = parseFloat(e.target.value);
        this.seek(time);
    }
    
    showControls() {
        const playPauseButton = document.getElementById('play-pause-button');
        const scrubber = document.getElementById('replay-scrubber');
        playPauseButton.classList.add('visible');
        scrubber.classList.add('visible');
        clearTimeout(this.controlsTimeout);
        this.controlsTimeout = setTimeout(() => {
            if (!this.state.isPaused) {
                playPauseButton.classList.remove('visible');
                scrubber.classList.remove('visible');
            }
        }, 2000);
    }
    
    show() {
        this.game.pauseTimer();
        this.game.pauseMainBGM();
        if (this.game.isRecordingStarted) {
            recorder.pauseRecording();
        }
        const modal = document.getElementById('replay-modal');
        modal.classList.remove('hidden');
        this.start();
    }

    hide() {
        const modal = document.getElementById('replay-modal');
        modal.classList.add('hidden');
        this.stop();

        if (this.game.isRecordingStarted) {
            recorder.resumeRecording();
        }
        this.game.resumeMainBGM();
        this.game.resumeTimer();
    }

    async start() {
        const recording = recorder.getRecording();
        if (!recording || !recording.initialState) return;

        this.state.isPlaying = true;
        this.state.isPaused = true;
        this.state.initialState = recording.initialState;
        this.state.actions = [...recording.actions];
        this.state.duration = this.state.actions.length > 0 ? this.state.actions[this.state.actions.length - 1].timestamp : 0;
        
        const scrubber = document.getElementById('replay-scrubber');
        scrubber.max = this.state.duration;
        
        await this.seek(0); // Build the initial state
        this.showControls();
        this.togglePlayback();
    }
    
    async seek(time) {
        this.state.currentTime = time;

        const scrubber = document.getElementById('replay-scrubber');
        scrubber.value = time;

        const replayBoardElement = document.getElementById('replay-board');
        replayBoardElement.innerHTML = '';

        const candyQueue = recorder.getRecording().actions.filter(a => a.type === 'newCandy').map(a => a.candyType);
        const replayTypeGenerator = () => candyQueue.shift() || this.config.candyTypes[0];

        const replayBoard = new Board(this.config.boardSize, this.config.candyTypes, () => {}, replayTypeGenerator);
        replayBoard.boardElement = replayBoardElement;
        replayBoard.setupBoard();
        replayBoard.initialize(this.state.initialState, true); // isInstant = true
        this.state.currentReplayBoard = replayBoard;

        if (this.replayBgmControl) {
            this.replayBgmControl.stop();
            this.replayBgmControl = null;
        }

        // Fast-forward simulation
        for (const action of this.state.actions) {
            if (action.timestamp > time) break;

            if (action.type === 'swap') {
                const candy1 = replayBoard.grid[action.from.r][action.from.c];
                const candy2 = replayBoard.grid[action.to.r][action.to.c];
                if (candy1 && candy2) {
                    await replayBoard.swapCandies(candy1, candy2, true);
                    const isValid = await replayBoard.processMatches(false, [candy1, candy2], true);
                    if (!isValid) {
                        await replayBoard.swapCandies(candy1, candy2, true);
                    }
                }
            } else if (action.type === 'activateRainbow') {
                 const rainbowCandy = replayBoard.grid[action.rainbowCandy.r][action.rainbowCandy.c];
                 const otherCandy = replayBoard.grid[action.otherCandy.r][action.otherCandy.c];
                 if (rainbowCandy && otherCandy) {
                     await replayBoard.activateRainbowPowerup(rainbowCandy, otherCandy, true);
                 }
            } else if (action.type === 'smash') {
                const candiesToSmash = action.smashed
                    .map(coords => (replayBoard.grid[coords.r] ? replayBoard.grid[coords.r][coords.c] : null))
                    .filter(Boolean);
                if (candiesToSmash.length > 0) {
                    await replayBoard.smashCandies(candiesToSmash, true);
                }
            } else if (action.type === 'initialCascade') {
                await replayBoard.processMatches(false, null, true);
            } else if (action.type === 'startBGM' && !this.replayBgmControl) {
                this.replayBgmControl = await playBackgroundMusic(true);
                if (this.state.isPaused) this.replayBgmControl.pause();
            }
        }
        
        // Find next action index
        this.state.actionIndex = this.state.actions.findIndex(a => a.timestamp >= time);
        if (this.state.actionIndex === -1) this.state.actionIndex = this.state.actions.length;
    }
    
    gameLoop(timestamp) {
        if (this.state.isPaused || !this.state.isPlaying) {
            this.animationFrameId = null;
            return;
        }

        const deltaTime = timestamp - (this.lastFrameTime || timestamp);
        this.lastFrameTime = timestamp;

        this.state.currentTime += deltaTime;

        if (this.state.currentTime >= this.state.duration + 2000) {
            this.hide();
            return;
        }
        
        document.getElementById('replay-scrubber').value = this.state.currentTime;

        this.processCurrentActions();

        this.animationFrameId = requestAnimationFrame((t) => this.gameLoop(t));
    }
    
    async processCurrentActions() {
        while (
            this.state.actionIndex < this.state.actions.length &&
            this.state.actions[this.state.actionIndex].timestamp <= this.state.currentTime
        ) {
            const action = this.state.actions[this.state.actionIndex];
            const replayBoard = this.state.currentReplayBoard;
            
            if (action.type === 'swap') {
                const candy1 = replayBoard.grid[action.from.r][action.from.c];
                const candy2 = replayBoard.grid[action.to.r][action.to.c];
                if(candy1 && candy2) {
                    await replayBoard.swapCandies(candy1, candy2);
                    const isValid = await replayBoard.processMatches(false, [candy1, candy2]);
                    if(!isValid) {
                         await replayBoard.swapCandies(candy1, candy2);
                    }
                }
            } else if (action.type === 'activateRainbow') {
                const rainbowCandy = replayBoard.grid[action.rainbowCandy.r][action.rainbowCandy.c];
                const otherCandy = replayBoard.grid[action.otherCandy.r][action.otherCandy.c];
                if (rainbowCandy && otherCandy) {
                    await replayBoard.activateRainbowPowerup(rainbowCandy, otherCandy);
                }
            } else if (action.type === 'smash') {
                const candiesToSmash = action.smashed
                    .map(coords => (replayBoard.grid[coords.r] ? replayBoard.grid[coords.r][coords.c] : null))
                    .filter(Boolean);
                if (candiesToSmash.length > 0) {
                    await replayBoard.smashCandies(candiesToSmash);
                }
            } else if (action.type === 'initialCascade') {
                await replayBoard.processMatches(false, null);
            } else if (action.type === 'sound') {
                playSound(action.name);
            } else if (action.type === 'startRainbow') {
                document.getElementById('replay-container').classList.add('rainbow-mode');
            } else if (action.type === 'endRainbow') {
                document.getElementById('replay-container').classList.remove('rainbow-mode');
            } else if (action.type === 'startBGM' && !this.replayBgmControl) {
                this.replayBgmControl = await playBackgroundMusic(true);
            }

            this.state.actionIndex++;
        }
    }


    togglePlayback() {
        if (this.state.isPaused) {
            this.resume();
        } else {
            this.pause();
        }
    }

    pause() {
        if (!this.state.isPlaying || this.state.isPaused) return;
        this.state.isPaused = true;

        if (this.replayBgmControl && this.replayBgmControl.pause) {
            this.replayBgmControl.pause();
        }
        
        const playPauseButton = document.getElementById('play-pause-button');
        playPauseButton.innerHTML = '&#9658;'; // Play icon
        this.showControls();
    }

    resume() {
        if (!this.state.isPaused) return;

        this.state.isPaused = false;
        
        if (this.replayBgmControl && this.replayBgmControl.resume) {
            this.replayBgmControl.resume();
        }
        
        const playPauseButton = document.getElementById('play-pause-button');
        playPauseButton.innerHTML = '&#10074;&#10074;'; // Pause icon

        if (!this.animationFrameId) {
            this.lastFrameTime = performance.now();
            this.animationFrameId = requestAnimationFrame((t) => this.gameLoop(t));
        }
    }

    stop() {
        if(this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        if (this.replayBgmControl) {
            this.replayBgmControl.stop();
            this.replayBgmControl = null;
        }
        clearTimeout(this.controlsTimeout);
        this.state = { isPlaying: false, isPaused: true, currentTime: 0, duration: 0, actions: [], actionIndex: 0, initialState: null, currentReplayBoard: null };

        const playPauseButton = document.getElementById('play-pause-button');
        const scrubber = document.getElementById('replay-scrubber');
        playPauseButton.innerHTML = '&#9658;'; // Play icon
        playPauseButton.classList.remove('visible');
        scrubber.classList.remove('visible');
        scrubber.value = 0;

        const lingeringCandies = document.querySelectorAll('.replay-candy');
        lingeringCandies.forEach(candy => candy.remove());
    }
}