// Sound cues. Drop MP3s into sounds/ with these names to replace the built-in tones.
// Press "M" during a game to mute.

const SOUND_FILES = {
  theme: "theme.mp3", // title screen and lobby (loops)
  round: "round.mp3", // a round title card
  question: "think.mp3", // while a question is open (loops)
  timesup: "timesup.mp3", // the clock runs out
  reveal: "reveal.mp3", // the answer is revealed
  standings: "standings.mp3", // round standings
  winner: "winner.mp3", // final results
};

const LOOPING = new Set(["theme", "question"]);

let current = null;
let muted = false;
let ctx = null;
const missing = new Set();

export function playSound(name) {
  stopSound();
  if (muted) return;
  const file = SOUND_FILES[name];
  if (!file || missing.has(name)) {
    synth(name);
    return;
  }
  const audio = new Audio(`sounds/${file}`);
  audio.loop = LOOPING.has(name);
  current = audio;
  audio.addEventListener(
    "error",
    () => {
      missing.add(name);
      if (current === audio) {
        current = null;
        synth(name);
      }
    },
    { once: true }
  );
  audio.play().catch(() => {});
}

export function stopSound() {
  if (current) {
    current.pause();
    current = null;
  }
}

export function toggleMute() {
  muted = !muted;
  if (muted) stopSound();
  return muted;
}

export function isMuted() {
  return muted;
}

// Built-in fallback tones: [frequency in Hz, start time, length] per note.
const TONES = {
  round: [[523, 0, 0.12], [659, 0.12, 0.12], [784, 0.24, 0.3]],
  timesup: [[440, 0, 0.12], [440, 0.18, 0.12], [330, 0.36, 0.4]],
  reveal: [[660, 0, 0.12], [880, 0.1, 0.25]],
  standings: [[392, 0, 0.1], [494, 0.1, 0.1], [587, 0.2, 0.3]],
  winner: [[523, 0, 0.15], [659, 0.15, 0.15], [784, 0.3, 0.15], [1047, 0.45, 0.6]],
};

function synth(name) {
  const notes = TONES[name];
  if (!notes || muted) return;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = ctx.currentTime + 0.02;
    for (const [freq, start, len] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = name === "timesup" ? "triangle" : "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + len + 0.05);
    }
  } catch {
    // No audio available; ignore.
  }
}
