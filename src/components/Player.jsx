// src/components/Player.jsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import Hls from 'hls.js';
import './Player.css';

// دارایی‌ها دیگر import نمی‌شوند، بلکه آدرس آن‌ها به صورت رشته مستقیم نوشته می‌شود
const hlsSrc = '/after_stream/playlist.m3u8';         // ✅ مسیر جدید
const enTrackSrc = '/after_cut-en.vtt';                   // ✅ مسیر جدید
const faTrackSrc = '/after_cut-fa.vtt'; 

const Player = () => {
    // --- State and Refs ---
    const [subtitles, setSubtitles] = useState([]);
    const [activeCueIndex, setActiveCueIndex] = useState(-1);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    const [feedback, setFeedback] = useState({ text: '', progress: -1, visible: false });
    const [persianVisible, setPersianVisible] = useState(true);
    const [isFullscreen, setIsFullscreen] = useState(false);

    const videoRef = useRef(null);
    const subtitlesContainerRef = useRef(null);
    const hlsInstanceRef = useRef(null);
    const feedbackTimeoutRef = useRef(null);
    const saveTimeoutRef = useRef(null);
    const enTrackRef = useRef(null);
    const faTrackRef = useRef(null);

    // --- LocalStorage Keys ---
    const getStableKey = (url) => `player_${url.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const videoKey = getStableKey(hlsSrc);
    const persianSubsVisibleKey = `${videoKey}_persian_visible`;

    // --- Subtitle Logic ---
    const findBestFaMatch = (enCue, faCues, startIndex) => {
        const lookAheadLimit = 5;
        const maxTimeDiff = 1.5;
        let bestMatch = { index: -1, diff: Infinity };
        const endIndex = Math.min(faCues.length, startIndex + lookAheadLimit);

        for (let j = startIndex; j < endIndex; j++) {
            const diff = Math.abs(enCue.startTime - faCues[j].startTime);
            if (diff < bestMatch.diff && diff < maxTimeDiff) {
                bestMatch = { index: j, diff };
            }
        }
        return bestMatch;
    };
    
    const loadSubtitles = useCallback(async () => {
        try {
            const fetchTrackCues = (trackRef) => {
                return new Promise((resolve, reject) => {
                    const track = trackRef.current.track;
                    track.mode = 'hidden';
                    const onLoaded = () => resolve(Array.from(track.cues || []));
                    const onError = () => reject(new Error(`Failed to load ${track.language} subtitles.`));
                    
                    if (track.readyState === 2 || (track.cues && track.cues.length > 0)) {
                         onLoaded();
                    } else {
                        trackRef.current.addEventListener('load', onLoaded, { once: true });
                        trackRef.current.addEventListener('error', onError, { once: true });
                    }
                });
            };

            const [enCues, faCues] = await Promise.all([
                fetchTrackCues(enTrackRef),
                fetchTrackCues(faTrackRef)
            ]);

            let faSearchIndex = 0;
            const combined = enCues.map((enCue) => {
                const bestMatch = findBestFaMatch(enCue, faCues, faSearchIndex);
                let faText = '';
                if (bestMatch.index !== -1) {
                    faText = faCues[bestMatch.index].text;
                    faSearchIndex = bestMatch.index + 1;
                }
                return { en: enCue.text, fa: faText, start: enCue.startTime, end: enCue.endTime };
            });

            setSubtitles(combined);
            setIsLoading(false);

        } catch (err) {
            console.error(err);
            setError('خطا در بارگذاری زیرنویس‌ها');
            setIsLoading(false);
        }
    }, []);
    
    // --- HLS and Player Initialization ---
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const initPlayer = () => {
            loadSubtitles(); // Load subtitles after metadata is ready
            const savedTime = localStorage.getItem(videoKey);
            if (savedTime) {
                video.currentTime = parseFloat(savedTime);
            }
        };

        if (Hls.isSupported()) {
            const hls = new Hls();
            hlsInstanceRef.current = hls;
            hls.loadSource(hlsSrc);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                console.log("HLS manifest parsed, initializing player.");
                initPlayer();
            });
             hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    setError('خطا در پخش ویدیو (HLS)');
                    console.error('HLS fatal error:', data);
                }
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = hlsSrc;
            video.addEventListener('loadedmetadata', initPlayer, { once: true });
        } else {
             setError('مرورگر شما از پخش استریم HLS پشتیبانی نمی‌کند.');
        }

        // Load saved settings
        const savedVisibility = localStorage.getItem(persianSubsVisibleKey);
        setPersianVisible(savedVisibility !== 'false');

        // Cleanup
        return () => {
            if (hlsInstanceRef.current) {
                hlsInstanceRef.current.destroy();
            }
             video.removeEventListener('loadedmetadata', initPlayer);
        };
    }, [hlsSrc, loadSubtitles, videoKey, persianSubsVisibleKey]);

    // --- Event Listeners and Handlers ---
    const showFeedback = useCallback((text, progress = -1) => {
        clearTimeout(feedbackTimeoutRef.current);
        setFeedback({ text, progress, visible: true });
        feedbackTimeoutRef.current = setTimeout(() => {
            setFeedback(f => ({ ...f, visible: false }));
        }, 500);
    }, []);

    // Time update effect
    useEffect(() => {
        const video = videoRef.current;
        const handleTimeUpdate = () => {
            if (!video) return;
            const currentTime = video.currentTime;
            const currentIndex = subtitles.findIndex(cue => currentTime >= cue.start && currentTime < cue.end);
            
            if (currentIndex !== activeCueIndex) {
                setActiveCueIndex(currentIndex);
                if (currentIndex >= 0) {
                    subtitlesContainerRef.current?.children[currentIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        };
        video?.addEventListener('timeupdate', handleTimeUpdate);
        return () => video?.removeEventListener('timeupdate', handleTimeUpdate);
    }, [subtitles, activeCueIndex]);

    // Save progress effect
    useEffect(() => {
        const video = videoRef.current;
        const saveProgress = () => {
            if (video && video.currentTime > 0 && !video.ended) {
                localStorage.setItem(videoKey, video.currentTime.toString());
            }
            saveTimeoutRef.current = null;
        };
        const interval = setInterval(() => {
            saveProgress();
        }, 2000);
        
        window.addEventListener('beforeunload', saveProgress);

        return () => {
            clearInterval(interval);
            window.removeEventListener('beforeunload', saveProgress);
        }
    }, [videoKey]);

    // Keyboard and other events effect
    useEffect(() => {
        const video = videoRef.current;
        
        const seekToNext = () => {
            if (!video || !subtitles.length) return;
            const nextCue = subtitles.find(cue => cue.start > video.currentTime);
            if (nextCue) {
                video.currentTime = nextCue.start;
                showFeedback('⏭');
            }
        };

        const seekToPrevious = () => {
            if (!video || !subtitles.length) return;
            const prevCue = [...subtitles].reverse().find(cue => cue.start < video.currentTime - 0.5);
            if (prevCue) {
                video.currentTime = prevCue.start;
                showFeedback('⏮');
            }
        };

        const adjustVolume = (delta) => {
            if (!video) return;
            const newVolume = Math.max(0, Math.min(1, video.volume + delta));
            video.volume = newVolume;
            const volumePercent = Math.round(newVolume * 100);
            const icon = newVolume === 0 ? '🔇' : newVolume < 0.5 ? '🔉' : '🔊';
            showFeedback(icon, volumePercent);
        };

        const handleKeyDown = (e) => {
            if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
            e.preventDefault();
            switch(e.code) {
                case 'Space': video.paused ? video.play() : video.pause(); break;
                case 'ArrowRight': seekToNext(); break;
                case 'ArrowLeft': seekToPrevious(); break;
                case 'ArrowUp': adjustVolume(0.05); break;
                case 'ArrowDown': adjustVolume(-0.05); break;
                case 'Enter': toggleFullScreen(); break;
                default: break;
            }
        };
        
        const handlePlay = () => showFeedback('▶');
        const handlePause = () => showFeedback('❚❚');
        const handleEnded = () => localStorage.removeItem(videoKey);
        
        document.addEventListener('keydown', handleKeyDown);
        video?.addEventListener('play', handlePlay);
        video?.addEventListener('pause', handlePause);
        video?.addEventListener('ended', handleEnded);

        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            video?.removeEventListener('play', handlePlay);
            video?.removeEventListener('pause', handlePause);
            video?.removeEventListener('ended', handleEnded);
        };
    }, [showFeedback, subtitles, videoKey]);

    // Fullscreen handler
    useEffect(() => {
        const handleFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
    }, []);

    // --- Component Functions ---
    const seekToTime = (time) => {
        if (videoRef.current) {
            videoRef.current.currentTime = time;
            if (videoRef.current.paused) videoRef.current.play();
        }
    };

    const togglePersianVisibility = () => {
        setPersianVisible(prev => {
            const newVisibility = !prev;
            localStorage.setItem(persianSubsVisibleKey, newVisibility);
            return newVisibility;
        });
    };
    
    const toggleFullScreen = () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err => console.log(err.message));
        } else {
            document.exitFullscreen();
        }
    };

    return (
        <>
            {!isFullscreen && (
                <>
                    <button className="fullscreen-btn" title="تمام صفحه (Enter)" onClick={toggleFullScreen}>⛶</button>
                    <button 
                        className={`toggle-fa-btn ${!persianVisible ? 'disabled' : ''}`} 
                        title="نمایش/مخفی کردن زیرنویس فارسی" 
                        onClick={togglePersianVisibility}>
                        ❤️فارسی
                    </button>
                </>
            )}

            <div className="player-wrapper">
                <div className="video-container">
                    <video ref={videoRef} controls controlsList="nodownload novolume" preload="metadata">
                        <track ref={enTrackRef} src={enTrackSrc} kind="subtitles" srcLang="en" label="English" />
                        <track ref={faTrackRef} src={faTrackSrc} kind="subtitles" srcLang="fa" label="فارسی" />
                        مرورگر شما از تگ ویدیو پشتیبانی نمی‌کند.
                    </video>

                    <div className={`feedback-indicator ${feedback.visible ? 'visible' : ''}`}>
                        <span className="feedback-text">{feedback.text}</span>
                        {feedback.progress >= 0 && (
                             <div className="progress-bar">
                                <div className="progress-bar-fill" style={{ width: `${feedback.progress}%` }}></div>
                            </div>
                        )}
                    </div>
                </div>

                <div ref={subtitlesContainerRef} className={`subtitles-container ${!persianVisible ? 'hide-persian' : ''}`}>
                    {isLoading ? (
                        <div className="loading">در حال بارگذاری زیرنویس‌ها...</div>
                    ) : error ? (
                        <div className="loading" style={{ color: '#ff6b6b' }}>{error}</div>
                    ) : (
                        subtitles.map((cue, index) => (
                            <div
                                key={`${index}-${cue.start}`}
                                className={`subtitle-item ${index === activeCueIndex ? 'active' : ''}`}
                                onClick={() => seekToTime(cue.start)}
                            >
                                <div className="subtitle-en">{cue.en}</div>
                                <div className="subtitle-fa">{cue.fa}</div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </>
    );
};

export default Player;