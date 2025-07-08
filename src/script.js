class VideoPlayer {
    constructor(directoryName, fileURLs, directoryHandle, appManager) {
        this.directoryName = directoryName;
        this.fileURLs = fileURLs;
        this.directoryHandle = directoryHandle;
        this.appManager = appManager; // Store AppManager instance

        this.initProperties();
        this.initUI();
        this.initPlayer();
    }

    initProperties() {
        this.state = {
            englishCues: [],
            persianCues: [],
            savedCues: [],
            activeCueIndex: -1,
            isFullscreen: false,
            arePersianSubtitlesVisible: true,
            isScrubbing: false,
            lastClickTime: 0,
            controlsTimeoutId: null,
            saveProgressTimeoutId: null,
            syncRequestId: null,
        };

        this.config = {
            maxTimeDiff: 1,
            lookAheadLimit: 5,
            volumeStep: 0.05,
            feedbackDuration: 500,
            saveProgressInterval: 2000,
            controlsHideDelay: 500,
            doubleClickTime: 300,
            subtitleOffset: 0.5,
        };

        this.storageKeys = {
            progress: `video_progress_${this.directoryName}`,
            persianPref: `persian_subtitles_visible_${this.directoryName}`,
            savedCues: `saved_cues_${this.directoryName}`,
            maxTimeDiff: `max_time_diff_${this.directoryName}`,
            subtitleOffset: `subtitle_offset_${this.directoryName}`,
        };

        this.boundListeners = new Map();
    }

    initUI() {
        const getElement = (id) => document.getElementById(id);
        const querySelector = (selector) => document.querySelector(selector);

        this.ui = {
            player: getElement('video-player'),
            video: getElement('video-element'),
            subtitlePanel: getElement('subtitle-panel'),
            savedCuesPanel: getElement('saved-cues-panel'),
            settingsPanel: getElement('settings-panel'),
            subtitleTab: getElement('subtitle-tab'),
            savedTab: getElement('saved-tab'),
            settingsTab: getElement('settings-tab'),
            homeBtn: getElement('home-btn'), // Add home button
            videoContainer: querySelector('.video-player__video-container'),
            customControls: getElement('custom-controls'),
            playPauseBtn: getElement('play-pause-btn'),
            progressBar: querySelector('.progress-bar__watched'),
            bufferedBar: querySelector('.progress-bar__buffered'),
            progressBarContainer: querySelector('.progress-bar-container'),
            currentTimeEl: getElement('current-time'),
            durationEl: getElement('duration'),
            fullscreenBtn: getElement('fullscreen-btn'),
            resizeHandle: getElement('resize-handle'),
            feedbackDisplay: getElement('feedback-display'),
            feedbackText: getElement('feedback-display-text'),
            feedbackProgressBar: getElement('feedback-display-progress-bar'),
            feedbackProgressFill: getElement('feedback-display-progress-fill'),
            subtitleSection: querySelector('.subtitle-section'), 
        };
    }

    async initPlayer() {
        try {
            this.ui.video.src = this.fileURLs.videoURL;
            this.loadSettings();
            this.loadSavedCues();

            const [englishCues, persianCues] = await this.loadSubtitles();
            this.state.englishCues = englishCues;
            this.state.persianCues = persianCues;

            this.renderSettingsPanel();
            this.renderSubtitles();
            this.renderSavedCues();
            this.bindEventListeners();
            this.loadVideoProgress();
            this.startSubtitleSync();
        } catch (error) {
            console.error("Initialization Error:", error);
            this.displayError('خطای بارگذاری فایل');
        }
    }

    bindEventListeners() {
        this.boundResizeMouseMove = this.onResizeMouseMove.bind(this);
        this.boundResizeMouseUp = this.onResizeMouseUp.bind(this);

        const eventListeners = {
            'video': [
                ['loadedmetadata', () => { this.updateTimeDisplay(); this.adjustLayout(); }],
                ['timeupdate', () => { this.updateTimeDisplay(); this.updateProgressBar(); this.scheduleProgressSave(); }],
                ['progress', this.updateBufferedBar],
                ['play', this.updatePlayPauseIcon],
                ['pause', this.updatePlayPauseIcon],
                ['ended', this.clearVideoProgress],
            ],
            'playPauseBtn': [['click', this.togglePlayPause]],
            'fullscreenBtn': [['click', this.toggleFullScreen]],
            'progressBarContainer': [
                ['mousedown', this.startScrubbing],
                ['touchstart', this.startScrubbing]
            ],
            'videoContainer': [
                ['mouseenter', this.showControls],
                ['mouseleave', this.hideControlsWithDelay],
                ['mousemove', this.resetControlsTimeout],
                ['click', this.handleVideoContainerClick],
            ],
            'subtitlePanel': [['click', this.handleSubtitlePanelClick]],
            'savedCuesPanel': [['click', this.handleSavedCuesPanelClick]],
            'resizeHandle': [['mousedown', this.onResizeHandleMouseDown]],
            'subtitleTab': [['click', () => this.switchTab('subtitles')]],
            'savedTab': [['click', () => this.switchTab('saved')]],
            'settingsTab': [['click', () => this.switchTab('settings')]],
            'homeBtn': [['click', this.goHome]], // Add listener for home button
            'document': [
                ['keydown', this.handleKeyboardInput],
                ['fullscreenchange', this.handleFullscreenChange],
            ],
            'window': [
                ['beforeunload', this.destroy],
                ['resize', this.adjustLayout],
            ]
        };

        for (const elementKey in eventListeners) {
            const target = elementKey === 'document' ? document : elementKey === 'window' ? window : this.ui[elementKey];
            if (!this.boundListeners.has(target)) {
                this.boundListeners.set(target, []);
            }

            eventListeners[elementKey].forEach(([event, handler]) => {
                const boundHandler = handler.bind(this);
                this.boundListeners.get(target).push({ event, handler: boundHandler });
                target.addEventListener(event, boundHandler);
            });
        }
    }

    async loadSubtitles() {
        const fetchAndParseVtt = async (url) => {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                const vttText = await response.text();
                const cues = [];
                const blocks = vttText.trim().replace(/\r/g, '').split('\n\n');
                for (const block of blocks) {
                    const lines = block.split('\n');
                    const timeLineIndex = lines.findIndex(line => line.includes('-->'));
                    if (timeLineIndex === -1) continue;
                    const text = lines.slice(timeLineIndex + 1).join('\n').trim();
                    if (!text) continue;
                    const [startTime, endTime] = this.parseVttTime(lines[timeLineIndex]);
                    if (startTime !== undefined && endTime !== undefined) {
                        cues.push(new VTTCue(startTime, endTime, text));
                    }
                }
                return cues;
            } catch (error) {
                console.error(`Failed to load or parse VTT from ${url}:`, error);
                return [];
            }
        };

        return Promise.all([
            fetchAndParseVtt(this.fileURLs.enVttURL),
            fetchAndParseVtt(this.fileURLs.faVttURL),
        ]);
    }

    parseVttTime(timeString) {
        const parts = timeString.split(' --> ');
        if (parts.length !== 2) return [undefined, undefined];
        const timeToSeconds = (t) => t.split(':').reduce((acc, part) => acc * 60 + parseFloat(part.replace(',', '.')), 0);
        return [timeToSeconds(parts[0]), timeToSeconds(parts[1].split(' ')[0])];
    }

    renderSubtitles() {
        const fragment = document.createDocumentFragment();
        const { englishCues, persianCues, savedCues } = this.state;
        const { maxTimeDiff, lookAheadLimit } = this.config;
        let faSearchIndex = 0;
        const matchedPersianIndexes = new Set();
        const savedCueIndexes = new Set(savedCues.map(cue => cue.index));

        const subtitleItems = englishCues.map((enCue, index) => {
            const bestMatch = this.findBestPersianMatch(enCue, persianCues, faSearchIndex, lookAheadLimit, maxTimeDiff);
            let persianText = '';
            if (bestMatch.index !== -1) {
                persianText = persianCues[bestMatch.index].text;
                faSearchIndex = bestMatch.index + 1;
                matchedPersianIndexes.add(bestMatch.index);
            }
            return { en: enCue.text, fa: persianText, time: enCue.startTime, index };
        });

        persianCues.forEach((faCue, index) => {
            if (!matchedPersianIndexes.has(index)) {
                const targetIndex = subtitleItems.findLastIndex(item => item.time < faCue.startTime);
                if (targetIndex !== -1) {
                    subtitleItems[targetIndex].fa += `\n${faCue.text}`;
                }
            }
        });

        subtitleItems.forEach(({ en, fa, time, index }) => {
            const item = document.createElement('div');
            const isBookmarked = savedCueIndexes.has(index);
            item.className = 'subtitle-line';
            item.dataset.index = index;
            item.dataset.time = time;
            item.innerHTML = `
                <div class="subtitle-text">
                    <div class="subtitle-line__english">${en}</div>
                    <div class="subtitle-line__persian">${fa}</div>
                </div>
                <button class="bookmark-btn ${isBookmarked ? 'bookmarked' : ''}" title="ذخیره کردن">🔖</button>
            `;
            fragment.appendChild(item);
        });

        this.ui.subtitlePanel.innerHTML = '';
        this.ui.subtitlePanel.appendChild(fragment);
        this.applyPersianSubtitlePreference();
    }

    renderSavedCues() {
        const fragment = document.createDocumentFragment();
        this.ui.savedCuesPanel.innerHTML = '';

        if (this.state.savedCues.length === 0) {
            this.ui.savedCuesPanel.innerHTML = '<div class="subtitle-panel__loading">هیچ زیرنویس ذخیره‌ شده‌ای وجود ندارد.</div>';
            this.ui.savedTab.dataset.count = 0;
            return;
        }

        this.ui.savedTab.dataset.count = this.state.savedCues.length;

        this.state.savedCues.forEach((cue) => {
            const item = document.createElement('div');
            item.className = 'subtitle-line';
            item.dataset.index = cue.index;
            item.dataset.time = cue.time;
            item.innerHTML = `
                <div class="subtitle-text">
                    <div class="subtitle-line__english">${cue.en}</div>
                    <div class="subtitle-line__persian">${cue.fa}</div>
                </div>
                <button class="delete-bookmark-btn" title="حذف">❌</button>
            `;
            fragment.appendChild(item);
        });
        this.ui.savedCuesPanel.appendChild(fragment);
    }
    
    renderSettingsPanel() {
        this.ui.settingsPanel.innerHTML = `
            <div class="settings-item">
                <div class="settings-label">
                    persian ❤️
                </div>
                <div class="settings-control">
                    <label class="toggle-switch">
                        <input type="checkbox" id="persian-toggle-setting" ${this.state.arePersianSubtitlesVisible ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
            </div>
            <div class="settings-item">
                <div class="settings-label">
                    sync (s)
                </div>
                <div class="settings-control">
                    <input type="number" id="max-time-diff-setting" class="settings-input" name="maxTimeDiff" step="0.1" value="${this.config.maxTimeDiff}">
                </div>
            </div>
            <div class="settings-item">
                <div class="settings-label">
                    delay (s)
                </div>
                <div class="settings-control">
                    <input type="number" id="subtitle-offset-setting" class="settings-input" name="subtitleOffset" step="0.1" value="${this.config.subtitleOffset}">
                </div>
            </div>
        `;
    
        document.getElementById('persian-toggle-setting').addEventListener('change', this.togglePersianSubtitles.bind(this));
        document.getElementById('max-time-diff-setting').addEventListener('change', this.handleSettingChange.bind(this));
        document.getElementById('subtitle-offset-setting').addEventListener('change', this.handleSettingChange.bind(this));
    }


    findBestPersianMatch(enCue, faCues, startIndex, lookAhead, maxDiff) {
        let bestMatch = { index: -1, diff: Infinity };
        const endIndex = Math.min(faCues.length, startIndex + lookAhead);
        for (let j = startIndex; j < endIndex; j++) {
            const diff = Math.abs(enCue.startTime - faCues[j].startTime);
            if (diff < maxDiff && diff < bestMatch.diff) {
                bestMatch = { index: j, diff: diff };
            }
        }
        return bestMatch;
    }

    startSubtitleSync() {
        const sync = () => {
            const { currentTime } = this.ui.video;
            const { subtitleOffset } = this.config;
            const activeIndex = this.state.englishCues.findIndex(cue =>
                currentTime >= (cue.startTime - subtitleOffset) && currentTime < (cue.endTime - subtitleOffset)
            );

            if (activeIndex !== this.state.activeCueIndex) {
                const currentActive = this.ui.subtitlePanel.querySelector('.subtitle-line--active');
                if (currentActive) currentActive.classList.remove('subtitle-line--active');

                if (activeIndex >= 0) {
                    const newActive = this.ui.subtitlePanel.querySelector(`[data-index='${activeIndex}']`);
                    if (newActive) {
                        newActive.classList.add('subtitle-line--active');
                        if (!this.state.isScrubbing) {
                           newActive.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }
                }
                this.state.activeCueIndex = activeIndex;
            }
            this.state.syncRequestId = requestAnimationFrame(sync);
        };
        sync();
    }

    handleKeyboardInput(event) {
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;

        const actions = {
            'Space': () => this.togglePlayPause(),
            'ArrowRight': () => this.jumpToNextCue(),
            'ArrowLeft': () => this.jumpToPreviousCue(),
            'ArrowUp': () => this.adjustVolume(this.config.volumeStep),
            'ArrowDown': () => this.adjustVolume(-this.config.volumeStep),
            'Enter': () => this.toggleFullScreen(),
        };

        if (actions[event.code]) {
            event.preventDefault();
            actions[event.code]();
        }
    }

    togglePlayPause() { this.ui.video.paused ? this.play() : this.pause(); }
    play() { this.ui.video.play(); this.showFeedback('▶'); this.resetControlsTimeout(); }
    pause() { this.ui.video.pause(); this.showFeedback('❚❚'); this.showControls(); clearTimeout(this.state.controlsTimeoutId); }
    seek(time) { this.ui.video.currentTime = Math.max(0, time); this.updateProgressBar(); if (this.ui.video.paused) this.play(); }

    handleSubtitlePanelClick(e) {
        const bookmarkBtn = e.target.closest('.bookmark-btn');
        const subtitleLine = e.target.closest('.subtitle-line');

        if (bookmarkBtn) {
            this.toggleBookmark(subtitleLine, bookmarkBtn);
            return;
        }

        if (subtitleLine?.dataset.time) {
            this.seek(parseFloat(subtitleLine.dataset.time) - this.config.subtitleOffset);
        }
    }

    handleSavedCuesPanelClick(e) {
        const deleteBtn = e.target.closest('.delete-bookmark-btn');
        const subtitleLine = e.target.closest('.subtitle-line');
        
        if (deleteBtn) {
            const cueIndex = parseInt(subtitleLine.dataset.index, 10);
            this.state.savedCues = this.state.savedCues.filter(c => c.index !== cueIndex);
            this.saveSavedCues();
            this.renderSavedCues();
            const originalBookmarkBtn = this.ui.subtitlePanel.querySelector(`.subtitle-line[data-index='${cueIndex}'] .bookmark-btn`);
            if (originalBookmarkBtn) {
                originalBookmarkBtn.classList.remove('bookmarked');
            }
            return;
        }

        if (subtitleLine?.dataset.time) {
            this.seek(parseFloat(subtitleLine.dataset.time) - this.config.subtitleOffset);
        }
    }

    toggleBookmark(subtitleLine, bookmarkBtn) {
        const cueIndex = parseInt(subtitleLine.dataset.index, 10);
        const isBookmarked = this.state.savedCues.some(c => c.index === cueIndex);

        if (isBookmarked) {
            this.state.savedCues = this.state.savedCues.filter(c => c.index !== cueIndex);
            bookmarkBtn.classList.remove('bookmarked');
        } else {
            const enText = subtitleLine.querySelector('.subtitle-line__english').textContent;
            const faText = subtitleLine.querySelector('.subtitle-line__persian').textContent;
            const time = parseFloat(subtitleLine.dataset.time);
            this.state.savedCues.push({ index: cueIndex, en: enText, fa: faText, time: time });
            bookmarkBtn.classList.add('bookmarked');
        }
        this.saveSavedCues();
        this.renderSavedCues();
    }


    handleVideoContainerClick(e) {
        if (e.target.closest('#custom-controls')) return;
        const now = Date.now();
        if (now - this.state.lastClickTime < this.config.doubleClickTime) {
            const containerWidth = this.ui.videoContainer.offsetWidth;
            const clickX = e.offsetX;
            if (clickX < containerWidth * 0.35) {
                this.ui.video.currentTime -= 10;
                this.showFeedback('« ۱۰');
            } else if (clickX > containerWidth * 0.65) {
                this.ui.video.currentTime += 10;
                this.showFeedback('۱۰ »');
            }
            this.updateProgressBar();
            this.state.lastClickTime = 0;
        } else {
            this.togglePlayPause();
        }
        this.state.lastClickTime = now;
    }

    jumpToNextCue() {
        const nextCue = this.state.englishCues.find(c => (c.startTime - this.config.subtitleOffset) > this.ui.video.currentTime);
        if (nextCue) {
            this.seek(nextCue.startTime - this.config.subtitleOffset);
            this.showFeedback('⏭');
        }
    }

    jumpToPreviousCue() {
        const { currentTime } = this.ui.video;
        const { subtitleOffset } = this.config;
        const prevCue = this.state.englishCues.slice().reverse().find(c => (c.startTime - subtitleOffset) < currentTime - 1);
        if (prevCue) {
            this.seek(prevCue.startTime - subtitleOffset);
            this.showFeedback('⏮');
        }
    }

    adjustVolume(delta) {
        const video = this.ui.video;
        video.volume = Math.max(0, Math.min(1, video.volume + delta));
        const percentage = Math.round(video.volume * 100);
        const icon = video.muted || video.volume === 0 ? '🔇' : video.volume < 0.5 ? '🔉' : '🔊';
        this.showFeedback(`${icon} ${percentage}%`, percentage);
    }

    showFeedback(text, progress = -1) {
        clearTimeout(this.state.feedbackTimeoutId);
        this.ui.feedbackText.textContent = text;
        this.ui.feedbackProgressBar.style.display = progress >= 0 ? 'block' : 'none';
        if (progress >= 0) {
            this.ui.feedbackProgressFill.style.width = `${progress}%`;
        }
        this.ui.feedbackDisplay.classList.add('visible');
        this.state.feedbackTimeoutId = setTimeout(() => {
            this.ui.feedbackDisplay.classList.remove('visible');
        }, this.config.feedbackDuration);
    }

    updateTimeDisplay() {
        const formatTime = (time) => new Date(1000 * time).toISOString().substr(time >= 3600 ? 11 : 14, time >= 3600 ? 8 : 5);
        this.ui.currentTimeEl.textContent = formatTime(this.ui.video.currentTime);
        if (!isNaN(this.ui.video.duration)) {
            this.ui.durationEl.textContent = formatTime(this.ui.video.duration);
        }
    }

    updateProgressBar() {
        const percentage = (this.ui.video.currentTime / this.ui.video.duration) * 100;
        this.ui.progressBar.style.width = `${percentage}%`;
    }

    updateBufferedBar() {
        if (this.ui.video.buffered.length > 0) {
            const bufferedEnd = this.ui.video.buffered.end(this.ui.video.buffered.length - 1);
            const percentage = (bufferedEnd / this.ui.video.duration) * 100;
            this.ui.bufferedBar.style.width = `${percentage}%`;
        }
    }

    startScrubbing(e) {
        this.state.isScrubbing = true;
        document.body.classList.add('is-scrubbing');
        this.scrub(e);
        document.addEventListener('mousemove', this.scrub);
        document.addEventListener('touchmove', this.scrub);
        document.addEventListener('mouseup', this.stopScrubbing);
        document.addEventListener('touchend', this.stopScrubbing);
    }

    scrub = (e) => {
        if (!this.state.isScrubbing) return;
        e.preventDefault();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const rect = this.ui.progressBarContainer.getBoundingClientRect();
        const percentage = Math.min(Math.max(0, clientX - rect.left), rect.width) / rect.width;

        if (isFinite(this.ui.video.duration)) {
            this.ui.video.currentTime = this.ui.video.duration * percentage;
            this.updateProgressBar();
        }
    }

    stopScrubbing = () => {
        this.state.isScrubbing = false;
        document.body.classList.remove('is-scrubbing');
        document.removeEventListener('mousemove', this.scrub);
        document.removeEventListener('touchmove', this.scrub);
        document.removeEventListener('mouseup', this.stopScrubbing);
        document.removeEventListener('touchend', this.stopScrubbing);
        this.hideControlsWithDelay();
    }

    showControls() {
        clearTimeout(this.state.controlsTimeoutId);
        this.ui.videoContainer.classList.remove('controls-hidden');
    }

    hideControlsWithDelay() {
        if (this.ui.video.paused || this.state.isScrubbing) return;
        this.resetControlsTimeout();
    }

    resetControlsTimeout() {
        this.showControls();
        clearTimeout(this.state.controlsTimeoutId);
        this.state.controlsTimeoutId = setTimeout(() => {
            if (!this.ui.video.paused && !this.state.isScrubbing) {
                this.ui.videoContainer.classList.add('controls-hidden');
            }
        }, this.config.controlsHideDelay);
    }

    onResizeHandleMouseDown(e) {
        e.preventDefault();
        document.addEventListener('mousemove', this.boundResizeMouseMove);
        document.addEventListener('mouseup', this.boundResizeMouseUp);
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
    };

    onResizeMouseMove(e) {
        const playerRect = this.ui.player.getBoundingClientRect();
        let newHeightPercent = ((e.clientY - playerRect.top) / playerRect.height) * 100;
        newHeightPercent = Math.max(20, Math.min(85, newHeightPercent));
        this.ui.videoContainer.style.height = `${newHeightPercent}%`;
        this.adjustLayout();
    };

    onResizeMouseUp() {
        document.removeEventListener('mousemove', this.boundResizeMouseMove);
        document.removeEventListener('mouseup', this.boundResizeMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    };

    adjustLayout() {
        if (window.innerWidth <= 768) {
            const offsetHeight = this.ui.player.querySelector('.fixed').offsetHeight;
            this.ui.subtitleSection.style.paddingTop = `${offsetHeight}px`;
        } else {
            this.ui.subtitleSection.style.paddingTop = '0';
        }
    }

    toggleFullScreen() { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(console.error); }
    handleFullscreenChange() { this.state.isFullscreen = !!document.fullscreenElement; this.ui.player.classList.toggle('fullscreen', this.state.isFullscreen); this.adjustLayout(); }
    updatePlayPauseIcon() { this.ui.videoContainer.classList.toggle('playing', !this.ui.video.paused); }
    saveVideoProgress() {
        const { currentTime, duration, ended } = this.ui.video;
        if (ended || currentTime < 1 || currentTime > duration - 5) {
            if (ended) this.clearVideoProgress();
            return;
        }
        localStorage.setItem(this.storageKeys.progress, currentTime.toString());
    }

    loadVideoProgress() { const savedTime = localStorage.getItem(this.storageKeys.progress); if (savedTime) this.ui.video.currentTime = parseFloat(savedTime); }
    clearVideoProgress() { localStorage.removeItem(this.storageKeys.progress); }
    scheduleProgressSave() { if (!this.state.saveProgressTimeoutId) { this.state.saveProgressTimeoutId = setTimeout(() => { this.saveVideoProgress(); this.state.saveProgressTimeoutId = null; }, this.config.saveProgressInterval); } }
    
    togglePersianSubtitles() { 
        this.state.arePersianSubtitlesVisible = !this.state.arePersianSubtitlesVisible;
        localStorage.setItem(this.storageKeys.persianPref, this.state.arePersianSubtitlesVisible);
        this.applyPersianSubtitlePreference();
    }
    
    applyPersianSubtitlePreference() { 
        this.ui.subtitlePanel.classList.toggle('hide-persian', !this.state.arePersianSubtitlesVisible); 
        const toggle = document.getElementById('persian-toggle-setting');
        if (toggle) {
            toggle.checked = this.state.arePersianSubtitlesVisible;
        }
    }
    
    handleSettingChange(e) {
        const { name, value } = e.target;
        if (this.config[name] !== undefined) {
            const numericValue = parseFloat(value);
            if (!isNaN(numericValue)) {
                this.config[name] = numericValue;
                localStorage.setItem(this.storageKeys[name], numericValue.toString());
                if (name === 'maxTimeDiff') {
                    this.renderSubtitles();
                }
            }
        }
    }
    
    loadSettings() {
        this.state.arePersianSubtitlesVisible = localStorage.getItem(this.storageKeys.persianPref) !== 'false';
        const storedMaxTimeDiff = localStorage.getItem(this.storageKeys.maxTimeDiff);
        if (storedMaxTimeDiff) {
            this.config.maxTimeDiff = parseFloat(storedMaxTimeDiff);
        }
        const storedSubtitleOffset = localStorage.getItem(this.storageKeys.subtitleOffset);
        if (storedSubtitleOffset) {
            this.config.subtitleOffset = parseFloat(storedSubtitleOffset);
        }
        this.applyPersianSubtitlePreference();
    }

    displayError(message) { this.ui.subtitlePanel.innerHTML = `<div class="subtitle-panel__loading" style="color: #ff6b6b;">${message}</div>`; }
    
    saveSavedCues() { localStorage.setItem(this.storageKeys.savedCues, JSON.stringify(this.state.savedCues)); }
    loadSavedCues() { const saved = localStorage.getItem(this.storageKeys.savedCues); if (saved) { this.state.savedCues = JSON.parse(saved); } }
    
    switchTab(tabName) {
        const tabs = {
            subtitles: { btn: this.ui.subtitleTab, panel: this.ui.subtitlePanel },
            saved: { btn: this.ui.savedTab, panel: this.ui.savedCuesPanel },
            settings: { btn: this.ui.settingsTab, panel: this.ui.settingsPanel }
        };

        Object.values(tabs).forEach(tab => {
            tab.btn.classList.remove('tab-btn--active');
            tab.panel.style.display = 'none';
        });

        if (tabs[tabName]) {
            tabs[tabName].btn.classList.add('tab-btn--active');
            tabs[tabName].panel.style.display = 'block';
        }
    }

    goHome() {
        this.destroy(); // Clean up video player resources
        this.appManager.showInitialScreen(); // Tell AppManager to show the initial screen
    }

    destroy() {
        this.saveVideoProgress();
        this.saveSavedCues();

        if (this.state.syncRequestId) cancelAnimationFrame(this.state.syncRequestId);
        clearTimeout(this.state.feedbackTimeoutId);
        clearTimeout(this.state.saveProgressTimeoutId);
        clearTimeout(this.state.controlsTimeoutId);

        this.boundListeners.forEach((listeners, target) => {
            listeners.forEach(({ event, handler }) => {
                target.removeEventListener(event, handler);
            });
        });

        document.removeEventListener('mousemove', this.scrub);
        document.removeEventListener('mouseup', this.stopScrubbing);
        document.removeEventListener('mousemove', this.boundResizeMouseMove);
        document.removeEventListener('mouseup', this.boundResizeMouseUp);

        Object.values(this.fileURLs).forEach(url => URL.revokeObjectURL(url));
        console.log("VideoPlayer instance destroyed.");
    }
}

class AppManager {
    constructor() {
        this.initUI();
        this.currentPlayer = null;
        this.database = null;
        this.dbConfig = { name: 'RecentFoldersDB', storeName: 'folders' };
        this.isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent);
        this.init();
    }

    initUI() {
        const getElement = (id) => document.getElementById(id);
        this.ui = {
            initialScreen: getElement('initial-screen'),
            loadButton: getElement('load-directory-button'),
            player: getElement('video-player'),
            recentDirectoriesList: getElement('recent-directories-list'),
            recentDirectoriesContainer: getElement('recent-directories-container'),
            dropHint: document.querySelector('.initial-screen__drop-hint'),
            homeSavedItemsContainer: getElement('home-saved-items-container'),
            homeSavedItemsList: getElement('home-saved-items-list'),
        };
    }

    async init() {
        this.bindEventListeners();
        this.registerServiceWorker();
        if (this.isMobile) {
            this.setupMobile();
        } else {
            this.setupDesktop();
            await this.initDatabase();
            await this.renderRecentDirectories();
        }
        await this.renderGlobalSavedItems(); // Render saved items on initial load
    }

    setupMobile() {
        this.ui.loadButton.innerHTML = '📂 انتخاب فایل';
        this.ui.dropHint.textContent = 'فایل های movie.mp4, en.vtt, fa.vtt را انتخاب کنید.';
        this.ui.dropHint.style.direction = 'rtl';
        this.fileInputElement = document.createElement('input');
        this.fileInputElement.type = 'file';
        this.fileInputElement.multiple = true;
        this.fileInputElement.accept = '.mp4,.vtt';
        this.fileInputElement.style.display = 'none';
        document.body.appendChild(this.fileInputElement);
        this.fileInputElement.addEventListener('change', e => {
            if (e.target.files?.length > 0) this.loadFromFiles(e.target.files);
        });
    }

    setupDesktop() {
        ['dragover', 'dragleave', 'drop'].forEach(event => {
            [this.ui.initialScreen, this.ui.player].forEach(el => {
                el.addEventListener(event, this.handleDragAndDrop.bind(this));
            });
        });
    }

    bindEventListeners() {
        this.ui.loadButton.addEventListener('click', () => {
            this.isMobile ? this.fileInputElement.click() : this.selectDirectory();
        });
    }

    async selectDirectory() {
        try {
            const directoryHandle = await window.showDirectoryPicker();
            await this.loadFromDirectory(directoryHandle);
        } catch (err) {
            if (err.name !== 'AbortError') console.error('Folder selection error:', err);
        }
    }

    async handleDragAndDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === 'dragover') {
            e.currentTarget.classList.add('drag-over');
        } else if (e.type === 'dragleave') {
            if (!e.currentTarget.contains(e.relatedTarget)) {
                e.currentTarget.classList.remove('drag-over');
            }
        } else if (e.type === 'drop') {
            e.currentTarget.classList.remove('drag-over');
            const handle = await e.dataTransfer.items?.[0]?.getAsFileSystemHandle();
            if (handle?.kind === 'directory') {
                await this.loadFromDirectory(handle);
            } else {
                alert('لطفاً پوشه را رها کنید.');
            }
        }
    }

    async loadFromFiles(files) {
        try {
            const fileMap = {};
            Array.from(files).forEach(file => {
                const name = file.name.toLowerCase();
                if (name.endsWith('.mp4')) fileMap.video = file;
                else if (name.includes('en') && name.endsWith('.vtt')) fileMap.enVtt = file;
                else if (name.includes('fa') && name.endsWith('.vtt')) fileMap.faVtt = file;
            });

            if (!fileMap.video || !fileMap.enVtt || !fileMap.faVtt) {
                return alert('فایل mp4 و زیرنویس‌های "en" و "fa" لازم است.');
            }

            const fileURLs = {
                videoURL: URL.createObjectURL(fileMap.video),
                enVttURL: URL.createObjectURL(fileMap.enVtt),
                faVttURL: URL.createObjectURL(fileMap.faVtt),
            };
            this.launchPlayer(fileMap.video.name, fileURLs, null);
        } catch (err) {
            console.error('Error processing files:', err);
            this.showInitialScreen();
        }
    }

    async loadFromDirectory(directoryHandle) {
        try {
            const getFile = async (name) => (await directoryHandle.getFileHandle(name)).getFile();
            const [videoFile, enVttFile, faVttFile] = await Promise.all([
                getFile('movie.mp4'), getFile('en.vtt'), getFile('fa.vtt')
            ]);

            const fileURLs = {
                videoURL: URL.createObjectURL(videoFile),
                enVttURL: URL.createObjectURL(enVttFile),
                faVttURL: URL.createObjectURL(faVttFile),
            };
            this.launchPlayer(directoryHandle.name, fileURLs, directoryHandle);
        } catch (err) {
            console.error('Error processing directory:', err);
            alert('پوشه باید شامل movie.mp4، en.vtt و fa.vtt باشد.');
            await this.showInitialScreen();
        }
    }

    async launchPlayer(directoryName, fileURLs, directoryHandle) {
        if (this.currentPlayer) {
            this.currentPlayer.destroy();
            this.currentPlayer = null;
        }
        this.ui.initialScreen.style.display = 'none';
        this.ui.player.style.display = 'flex';
        // Reset subtitle panel content for the new video
        const subtitlePanel = document.getElementById('subtitle-panel');
        if (subtitlePanel) {
            subtitlePanel.innerHTML = '<div class="subtitle-panel__loading">... در حال بارگذاری زیرنویس</div>';
        }
         // Reset saved cues panel content
        const savedCuesPanel = document.getElementById('saved-cues-panel');
        if (savedCuesPanel) {
            savedCuesPanel.innerHTML = '<div class="subtitle-panel__loading">... در حال بارگذاری</div>';
        }
        // Reset settings panel
        const settingsPanel = document.getElementById('settings-panel');
        if (settingsPanel) {
            settingsPanel.innerHTML = '';
        }
        // Ensure subtitle tab is active by default
        document.getElementById('subtitle-tab')?.classList.add('tab-btn--active');
        document.getElementById('saved-tab')?.classList.remove('tab-btn--active');
        document.getElementById('settings-tab')?.classList.remove('tab-btn--active');


        this.currentPlayer = new VideoPlayer(directoryName, fileURLs, directoryHandle, this); // Pass AppManager instance

        if (directoryHandle && this.database) {
            await this.saveRecentDirectory(directoryHandle);
            // No need to render recent directories here, showInitialScreen will do it
        }
    }

    async showInitialScreen() {
        if (this.currentPlayer) {
            // If a player exists, it means we are navigating back, so destroy it.
            // The destroy method is now called by VideoPlayer.goHome() before this.
            // this.currentPlayer.destroy(); // This might be redundant if goHome always calls destroy
            this.currentPlayer = null;
        }
        this.ui.player.style.display = 'none';
        this.ui.initialScreen.style.display = 'flex';

        if (!this.isMobile && this.database) {
            await this.renderRecentDirectories();
        }
        await this.renderGlobalSavedItems(); // Also update saved items when returning home
    }

    async renderGlobalSavedItems() {
        this.ui.homeSavedItemsList.innerHTML = ''; // Clear previous items
        let allSavedCues = [];

        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('saved_cues_')) {
                const directoryName = key.substring('saved_cues_'.length);
                try {
                    const cuesString = localStorage.getItem(key);
                    const cues = JSON.parse(cuesString);
                    if (Array.isArray(cues)) {
                        cues.forEach(cue => {
                            allSavedCues.push({ ...cue, directoryName });
                        });
                    }
                } catch (error) {
                    console.error(`Error parsing saved cues for ${directoryName}:`, error);
                }
            }
        }

        if (allSavedCues.length > 0) {
            const fragment = document.createDocumentFragment();
            // Sort by directory name, then by time (optional, but good for consistency)
            allSavedCues.sort((a, b) => {
                if (a.directoryName < b.directoryName) return -1;
                if (a.directoryName > b.directoryName) return 1;
                return a.time - b.time;
            });

            allSavedCues.forEach(cue => {
                const item = document.createElement('li');
                item.className = 'home-saved-item';
                item.innerHTML = `
                    <div class="home-saved-item__source">Video: ${cue.directoryName}</div>
                    <div class="home-saved-item__en">${cue.en}</div>
                    <div class="home-saved-item__fa">${cue.fa}</div>
                `;
                // Potentially add a click handler to load this video and seek to the cue time
                item.addEventListener('click', async () => {
                    // This is a more advanced feature: find the directory handle and launch
                    // console.log(`Clicked saved item from ${cue.directoryName} at time ${cue.time}`);
                    // For now, just log. To implement fully, we'd need to:
                    // 1. Find the directoryHandle (e.g., from recent directories in IndexedDB)
                    // 2. Call this.loadFromDirectory(handle)
                    // 3. Once player is loaded, seek to cue.time. This requires VideoPlayer to accept a start time.
                    alert(`Item from: ${cue.directoryName}\nTime: ${cue.time}\nEN: ${cue.en}\nFA: ${cue.fa}`);
                });
                fragment.appendChild(item);
            });
            this.ui.homeSavedItemsList.appendChild(fragment);
            this.ui.homeSavedItemsContainer.style.display = 'block';
        } else {
            this.ui.homeSavedItemsContainer.style.display = 'none';
        }
    }


    async initDatabase() {
        if (!('indexedDB' in window)) return;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbConfig.name, 1);
            request.onerror = (e) => reject('DB error: ' + e.target.errorCode);
            request.onsuccess = (e) => { this.database = e.target.result; resolve(); };
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.dbConfig.storeName)) {
                    db.createObjectStore(this.dbConfig.storeName, { keyPath: 'id', autoIncrement: true });
                }
            };
        });
    }

    dbRequest(storeName, mode, action, data) {
        return new Promise((resolve, reject) => {
            const transaction = this.database.transaction(storeName, mode);
            const store = transaction.objectStore(storeName);
            const request = store[action](data);
            transaction.oncomplete = () => resolve(request.result);
            transaction.onerror = () => reject(transaction.error);
        });
    }

    async saveRecentDirectory(directoryHandle) {
        if (!this.database) return;
        const all = await this.dbRequest(this.dbConfig.storeName, 'readonly', 'getAll');
        const exists = all.some(item => item.name === directoryHandle.name);
        if (!exists) {
            await this.dbRequest(this.dbConfig.storeName, 'readwrite', 'add', { name: directoryHandle.name, handle: directoryHandle });
        }
    }

    async deleteRecentDirectory(folderId) {
        if (!this.database) return;
        await this.dbRequest(this.dbConfig.storeName, 'readwrite', 'delete', folderId);
        await this.renderRecentDirectories();
    }

    async renderRecentDirectories() {
        if (!this.database) return;
        const directories = await this.dbRequest(this.dbConfig.storeName, 'readonly', 'getAll');
        this.ui.recentDirectoriesList.innerHTML = '';
        if (directories.length > 0) {
            this.ui.recentDirectoriesContainer.style.display = 'block';
            const fragment = document.createDocumentFragment();
            directories.reverse().forEach(dir => {
                const item = document.createElement('li');
                item.className = 'recent-directories__item';
                item.innerHTML = `<span>${dir.name}</span><span class="recent-directories__delete-button" title="حذف">&times;</span>`;
                item.querySelector('.recent-directories__delete-button').onclick = (e) => {
                    e.stopPropagation();
                    this.deleteRecentDirectory(dir.id);
                };
                item.onclick = () => this.loadFromDirectory(dir.handle);
                fragment.appendChild(item);
            });
            this.ui.recentDirectoriesList.appendChild(fragment);
        } else {
            this.ui.recentDirectoriesContainer.style.display = 'none';
        }
    }

    registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('src/sw.js')
                    .then(reg => console.log('ServiceWorker registered:', reg.scope))
                    .catch(err => console.error('ServiceWorker registration failed:', err));
            });
        }
    }
}

document.addEventListener('DOMContentLoaded', () => new AppManager());