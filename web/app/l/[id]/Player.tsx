"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

export type PlayerChapter = { at: number; name?: string; label?: string };
export type PlayerHandle = { seek: (at: number) => void };

const RATES = [1, 1.25, 1.5, 1.75, 2] as const;
const RATE_KEY = "spool-rate";
const DEFAULT_RATE = 1.5;
const IDLE_MS = 2500;

const fmt = (s: number) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
};

type Props = {
  src: string;
  poster?: string;
  chapters?: PlayerChapter[];
  onTime?: (t: number) => void;
};

// Loom-style custom player shared by the watch and embed pages. Attempts
// unmuted autoplay, falls back to muted + a tap-to-unmute pill, defaults 1.5x.
const Player = forwardRef<PlayerHandle, Props>(function Player(
  { src, poster, chapters = [], onTime },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [needsUnmute, setNeedsUnmute] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [rate, setRateState] = useState(DEFAULT_RATE);
  const [barShown, setBarShown] = useState(true);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [fs, setFs] = useState(false);

  const applyRate = useCallback((r: number) => {
    const v = videoRef.current;
    if (v) v.playbackRate = r;
    setRateState(r);
  }, []);

  const unmute = useCallback(() => {
    const v = videoRef.current;
    if (v) v.muted = false;
    setMuted(false);
    setNeedsUnmute(false);
  }, []);

  // Mount: restore persisted rate (wins over 1.5 default) and attempt unmuted
  // autoplay, falling back to muted autoplay + the unmute pill on rejection.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const stored = Number(localStorage.getItem(RATE_KEY));
    const startRate = (RATES as readonly number[]).includes(stored)
      ? stored
      : DEFAULT_RATE;
    applyRate(startRate);
    v.muted = false;
    setMuted(false);
    v.play()
      .then(() => setPlaying(true))
      .catch(() => {
        v.muted = true;
        setMuted(true);
        setNeedsUnmute(true);
        v.play()
          .then(() => setPlaying(true))
          .catch(() => {});
      });
  }, [applyRate]);

  useImperativeHandle(ref, () => ({
    seek: (at: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.currentTime = at + 0.001;
      if (needsUnmute) unmute();
      void v.play().catch(() => {});
    },
  }));

  const showBar = useCallback(() => {
    setBarShown(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (videoRef.current && !videoRef.current.paused) {
      idleTimer.current = setTimeout(() => setBarShown(false), IDLE_MS);
    }
  }, []);

  // Bar is always visible while paused; starts its idle countdown on play.
  useEffect(() => {
    if (playing) showBar();
    else {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      setBarShown(true);
    }
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [playing, showBar]);

  useEffect(() => {
    const onFsChange = () => setFs(document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (needsUnmute) unmute();
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  }, [needsUnmute, unmute]);

  const nudge = useCallback((d: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + d));
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (needsUnmute) {
      unmute();
      return;
    }
    v.muted = !v.muted;
    setMuted(v.muted);
  }, [needsUnmute, unmute]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void wrapRef.current?.requestFullscreen().catch(() => {});
  }, []);

  const chooseRate = useCallback(
    (r: number) => {
      applyRate(r);
      try {
        localStorage.setItem(RATE_KEY, String(r));
      } catch {}
      setSpeedOpen(false);
    },
    [applyRate],
  );

  // Scrub: pointer down/drag maps clientX across the track to a seek time.
  const trackRef = useRef<HTMLDivElement>(null);
  const seekToClientX = useCallback((clientX: number) => {
    const v = videoRef.current;
    const track = trackRef.current;
    if (!v || !track || !v.duration) return;
    const rect = track.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    v.currentTime = frac * v.duration;
    setCurrent(v.currentTime);
  }, []);

  const onTrackPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (needsUnmute) unmute();
      seekToClientX(e.clientX);
      const move = (ev: PointerEvent) => seekToClientX(ev.clientX);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [needsUnmute, seekToClientX, unmute],
  );

  // Keyboard shortcuts when the player is hovered or focused; never while the
  // caret sits in an input, textarea, or contenteditable (the ask panel).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const focused = hoverRef.current || wrap.contains(document.activeElement);
      if (!focused) return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      )
        return;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          nudge(-5);
          break;
        case "ArrowRight":
          e.preventDefault();
          nudge(5);
          break;
        case "m":
          toggleMute();
          break;
        case "f":
          toggleFullscreen();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nudge, toggleFullscreen, toggleMute, togglePlay]);

  const pct = duration ? (current / duration) * 100 : 0;
  const bufPct = duration ? (buffered / duration) * 100 : 0;

  return (
    <div
      ref={wrapRef}
      className={`wv-p${barShown ? " wv-p-active" : ""}${fs ? " wv-p-fs" : ""}`}
      onMouseEnter={() => {
        hoverRef.current = true;
      }}
      onMouseLeave={() => {
        hoverRef.current = false;
      }}
      onMouseMove={showBar}
      onTouchStart={showBar}
    >
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        playsInline
        preload="metadata"
        className="wv-p-video"
        onClick={togglePlay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime;
          setCurrent(t);
          onTime?.(t);
        }}
        onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
        onLoadedMetadata={(e) => {
          setDuration(e.currentTarget.duration || 0);
          e.currentTarget.playbackRate = rate;
        }}
        onProgress={(e) => {
          const v = e.currentTarget;
          if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
        }}
        onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
      />

      {needsUnmute && (
        <button type="button" className="wv-p-unmute" onClick={unmute}>
          <IconMuted />
          <span>Tap to unmute</span>
        </button>
      )}

      {!playing && (
        <button
          type="button"
          className="wv-p-big"
          aria-label="Play"
          onClick={togglePlay}
        >
          <IconPlay big />
        </button>
      )}

      <div className="wv-p-bar" role="group" aria-label="Video controls">
        <div
          ref={trackRef}
          className="wv-p-track"
          onPointerDown={onTrackPointerDown}
        >
          <div className="wv-p-buf" style={{ width: `${bufPct}%` }} />
          <div className="wv-p-fill" style={{ width: `${pct}%` }}>
            <span className="wv-p-knob" />
          </div>
          {duration > 0 &&
            chapters.map((c, i) =>
              c.at > 0 && c.at < duration ? (
                <span
                  key={i}
                  className="wv-p-tick"
                  style={{ left: `${(c.at / duration) * 100}%` }}
                >
                  <span className="wv-p-tip">{c.name || c.label || ""}</span>
                </span>
              ) : null,
            )}
        </div>

        <div className="wv-p-row">
          <button
            type="button"
            className="wv-p-btn"
            aria-label={playing ? "Pause" : "Play"}
            onClick={togglePlay}
          >
            {playing ? <IconPause /> : <IconPlay />}
          </button>

          <span className="wv-p-time">
            {fmt(current)} / {fmt(duration)}
          </span>

          <span className="wv-p-spacer" />

          <div className="wv-p-speed">
            <button
              type="button"
              className="wv-p-btn wv-p-speed-btn"
              aria-label="Playback speed"
              onClick={() => setSpeedOpen((o) => !o)}
            >
              {rate}x
            </button>
            {speedOpen && (
              <div className="wv-p-menu">
                {RATES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={`wv-p-menu-item${r === rate ? " is-on" : ""}`}
                    onClick={() => chooseRate(r)}
                  >
                    {r}x
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            className="wv-p-btn"
            aria-label={muted ? "Unmute" : "Mute"}
            onClick={toggleMute}
          >
            {muted ? <IconMuted /> : <IconVolume />}
          </button>

          <button
            type="button"
            className="wv-p-btn"
            aria-label={fs ? "Exit fullscreen" : "Fullscreen"}
            onClick={toggleFullscreen}
          >
            {fs ? <IconExitFs /> : <IconFs />}
          </button>
        </div>
      </div>
    </div>
  );
});

export default Player;

function IconPlay({ big }: { big?: boolean }) {
  const s = big ? 26 : 16;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.6-6.86a1 1 0 0 0 0-1.7L9.53 4.3A1 1 0 0 0 8 5.14z" />
    </svg>
  );
}
function IconPause() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" />
    </svg>
  );
}
function IconVolume() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" stroke="none" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a8 8 0 0 1 0 12" />
    </svg>
  );
}
function IconMuted() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" stroke="none" />
      <path d="m17 9 5 6M22 9l-5 6" />
    </svg>
  );
}
function IconFs() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}
function IconExitFs() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 8h3V5M19 8h-3V5M5 16h3v3M19 16h-3v3" />
    </svg>
  );
}
