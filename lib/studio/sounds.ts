/**
 * lib/studio/sounds.ts
 *
 * Studio's audio choreography — three sound events that punctuate the
 * reveal animation on `/studio`:
 *
 *   • click   — fires at every user tap (Submit, dropdowns, date
 *               picker, timeframe pills, Back, Replay, etc.). Wired
 *               globally by `<StudioClickSound />`.
 *   • swoosh  — fires at chart line-draw start.
 *   • ding    — fires at pill land.
 *
 * The CLICK sound is user-selectable — ten variants live in the
 * CLICK_VARIANTS map below, each a self-contained synth recipe. The
 * user picks their favourite in `/studio/sounds`; the selection is
 * persisted to localStorage under CLICK_STORAGE_KEY and every
 * subsequent `playClick()` dispatches to that variant.
 *
 * All synthesis is done with the Web Audio API — no audio files,
 * ~5-6KB bundle overhead. If a matching MP3 exists under
 * `/assets/sounds/{name}.mp3` at runtime, the module prefers it over
 * the synth (drop-in override slot for hand-recorded ASMR clips).
 */

// ── Types ────────────────────────────────────────────────────────

/** The five sound events used on /studio. */
export type SoundName = "click" | "swoosh" | "ding" | "rollup" | "cracker";

/** Human-readable IDs for the 10 click sound variants. Kept as a
 *  string union so a typo at a call site fails at compile time. */
export type ClickVariantId =
  | "layered"
  | "cherry_mx"
  | "topre_thock"
  | "wooden"
  | "bubble_pop"
  | "water_drop"
  | "chime_tick"
  | "paper_snap"
  | "iphone_tap"
  | "pluck";

/** Human-readable IDs for the 15 rollup sound variants. Fires once
 *  when the daily progress + stats cascade begins counting up. */
export type RollupVariantId =
  | "odometer"
  | "slot_machine"
  | "cash_register"
  | "bank_counter"
  | "typewriter"
  | "marimba_rise"
  | "piano_arpeggio"
  | "chime_cascade"
  | "xylophone_rise"
  | "data_stream"
  | "retro_beep"
  | "ratchet_roll"
  | "coin_rain"
  | "wind_chime"
  | "vinyl_rise";

/** Human-readable IDs for the 16 sky-cracker sound variants. Fires
 *  once when the celebration Lottie mounts, right after a successful
 *  order submit. Each is 400-2000ms so it wraps neatly inside the
 *  Lottie's 2670ms runtime without spilling into the reveal's
 *  swoosh + chart-draw beat.
 *
 *  The list is deliberately biased toward the whistle→burst family
 *  (7 of 16) because that's the visual/audio grammar of "sky-
 *  cracker" — anticipation via rising pitch, payoff via pop. The
 *  remaining variants offer other flavours (musical, hiss, bass
 *  drop, chime) for contrast. */
export type CrackerVariantId =
  // Whistle → burst family (7)
  | "rocket_whistle"
  | "whistle_bomb"
  | "screamer"
  | "fuse_bang"
  | "warble_rocket"
  | "whistle_chain"
  | "bottle_rocket_chain"
  // Other flavours (9)
  | "party_cannon"
  | "firework_cascade"
  | "diwali_bomb"
  | "classic_pop"
  | "champagne_cork"
  | "cinema_boom"
  | "sparkler_sizzle"
  | "success_chime"
  | "fanfare";

/** Metadata for the /studio/sounds preview UI. Each entry pairs an
 *  ID with a short display name and one-liner describing the vibe. */
export type ClickVariantMeta = {
  id: ClickVariantId;
  name: string;
  description: string;
};

/** Metadata for a rollup variant. Same shape as ClickVariantMeta
 *  but with the rollup-specific ID type. */
export type RollupVariantMeta = {
  id: RollupVariantId;
  name: string;
  description: string;
};

/** Metadata for a cracker variant. Same shape as the other variant
 *  metadata types. Used by /studio/sounds to render the picker UI. */
export type CrackerVariantMeta = {
  id: CrackerVariantId;
  name: string;
  description: string;
};

/** Human-readable IDs for the 18 verdict GREEN sound variants. One
 *  choice covers both the `green` and `big-green` tiers — each
 *  variant defines a pair of synths (compact for `green`, extended
 *  for `big-green`) so a single style covers both magnitudes with
 *  the appropriate scaling. Selecting a variant on /studio/sounds
 *  makes both tiers play that style. */
export type VerdictGreenVariantId =
  // Bell / mallet family
  | "major_bell"
  | "music_box"
  | "marimba"
  | "xylophone"
  | "kalimba"
  | "wind_chime"
  | "glass_ping"
  | "handpan"
  | "celesta"
  | "vibraphone"
  // Synthetic / modern
  | "sine_sparkle"
  | "chiptune"
  | "coin_get"
  | "level_up"
  | "notification"
  // Wind / brass
  | "trumpet_fanfare"
  | "steel_drum"
  | "harp_gliss";

/** Human-readable IDs for the 18 verdict RED sound variants.
 *  Every negative-move day plays the active red variant regardless
 *  of magnitude (the 4-tier taxonomy has no big-red split — see
 *  VerdictReactive docstring). Design constraint: nothing punitive.
 *  Markets are red ~40% of days and a shame ritual would train a
 *  daily flinch. Every variant here has a warm, muted, quiet
 *  character — the difference between them is timbre and gesture,
 *  not intensity. */
export type VerdictRedVariantId =
  // Descending melodic
  | "minor_descent"
  | "soft_bend"
  | "doorbell_low"
  | "reverse_chime"
  // Struck / plucked
  | "piano_minor"
  | "music_box_minor"
  | "detuned_bell"
  | "bell_toll"
  | "low_thud"
  // Sustained / bowed / wind
  | "cello_dip"
  | "muted_trombone"
  | "reed_sigh"
  | "sigh"
  // Noise / textural
  | "rain_patter"
  | "deflate"
  | "analog_fade"
  // Novelty / character
  | "coin_drop"
  | "minor_swell";

/** Metadata for a verdict-green variant. Used by /studio/sounds. */
export type VerdictGreenVariantMeta = {
  id: VerdictGreenVariantId;
  name: string;
  description: string;
};

/** Metadata for a verdict-red variant. Used by /studio/sounds. */
export type VerdictRedVariantMeta = {
  id: VerdictRedVariantId;
  name: string;
  description: string;
};

type Ctx = AudioContext;

// ── Module-level state ───────────────────────────────────────────

/** localStorage key for the user's active click variant selection. */
const CLICK_STORAGE_KEY = "studio.clickVariant";

/** localStorage key for the user's active rollup variant selection. */
const ROLLUP_STORAGE_KEY = "studio.rollupVariant";

/** localStorage key for the user's active cracker variant selection. */
const CRACKER_STORAGE_KEY = "studio.crackerVariant";

/** Fallback variant when nothing is stored yet — the original
 *  layered tap that shipped as the initial default. */
const DEFAULT_CLICK_VARIANT: ClickVariantId = "layered";

/** Fallback rollup variant — slot_machine is duration-synced to the
 *  reveal's Total Orders roll-up (≈2030ms + jackpot ding). Odometer
 *  used to be the default but its ~1.2s body ended near the top-value
 *  pill, which desynced the ASMR from the last stats tile. */
const DEFAULT_ROLLUP_VARIANT: RollupVariantId = "slot_machine";

/** Fallback cracker variant — rocket_whistle is the archetypal
 *  "sky-cracker" (rising whistle + burst) and matches the video-
 *  series recording aesthetic the user has confirmed on 2026-07-25.
 *  Any new device / fresh install lands on this variant unless the
 *  user picks another in /studio/sounds. */
const DEFAULT_CRACKER_VARIANT: CrackerVariantId = "rocket_whistle";

/** localStorage key for the user's active verdict-GREEN variant
 *  selection. Covers both the `green` and `big-green` tiers — one
 *  choice, two synths per variant. */
const VERDICT_GREEN_STORAGE_KEY = "studio.verdictGreenVariant";

/** localStorage key for the user's active verdict-RED variant. */
const VERDICT_RED_STORAGE_KEY = "studio.verdictRedVariant";

/** Fallback verdict-green variant — major_bell is the C-major
 *  arpeggio chime that shipped as the initial verdict sound. Keeps
 *  the reveal-coda audio unchanged for existing users when the
 *  variant framework rolls out. */
const DEFAULT_VERDICT_GREEN_VARIANT: VerdictGreenVariantId = "major_bell";

/** Fallback verdict-red variant — minor_descent is the D-minor run
 *  (F5-D5-C5-Bb4-A4) that shipped as the initial verdict-red
 *  sound. Same rollout continuity principle as the green default. */
const DEFAULT_VERDICT_RED_VARIANT: VerdictRedVariantId = "minor_descent";

/** Singleton AudioContext. Lazily created on first play call. */
let audioCtx: Ctx | null = null;

/** MP3 override cache. */
const mp3Cache: Partial<Record<SoundName, HTMLAudioElement>> = {};

let mp3ProbeStarted = false;

// ── Audio unlock ─────────────────────────────────────────────────

export async function unlockAudio(): Promise<void> {
  if (typeof window === "undefined") return;
  if (!audioCtx) {
    try {
      const Ctor = window.AudioContext;
      if (!Ctor) return;
      audioCtx = new Ctor();
    } catch (err) {
      console.debug("[studio.sounds] AudioContext create failed", err);
      return;
    }
  }
  if (audioCtx.state === "suspended") {
    try {
      await audioCtx.resume();
    } catch (err) {
      console.debug("[studio.sounds] resume() failed", err);
    }
  }
}

// ── MP3 preload probe ────────────────────────────────────────────

function startMp3Probe(): void {
  if (mp3ProbeStarted || typeof window === "undefined") return;
  mp3ProbeStarted = true;
  const names: SoundName[] = ["click", "swoosh", "ding", "rollup", "cracker"];
  for (const name of names) {
    const url = `/assets/sounds/${name}.mp3`;
    const el = new Audio();
    el.preload = "auto";
    el.src = url;
    el.volume = defaultVolume(name);
    el.addEventListener(
      "canplaythrough",
      () => {
        mp3Cache[name] = el;
      },
      { once: true }
    );
    el.addEventListener("error", () => {}, { once: true });
  }
}

// ── Reduced motion / mute check ──────────────────────────────────

function shouldPlay(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

function defaultVolume(name: SoundName): number {
  switch (name) {
    case "click":
      return 0.15;
    case "swoosh":
      return 0.1;
    case "ding":
      return 0.22;
    case "rollup":
      return 0.12;
    case "cracker":
      // Slightly louder than ding — this is the celebration beat and
      // needs to carry over the visual confetti burst. Any higher and
      // the AudioContext runs a real risk of clipping on cheap phone
      // speakers; any lower and the boom loses its punch.
      return 0.24;
  }
}

// ── Active click variant (localStorage-backed) ───────────────────

/** Read the user's selected click variant from localStorage. Falls
 *  back to DEFAULT_CLICK_VARIANT when unset or the stored value is
 *  no longer a valid variant ID (e.g., an old variant was removed
 *  in a later release). */
export function getActiveClickVariant(): ClickVariantId {
  if (typeof window === "undefined") return DEFAULT_CLICK_VARIANT;
  try {
    const stored = window.localStorage.getItem(CLICK_STORAGE_KEY);
    if (stored && stored in CLICK_VARIANTS) {
      return stored as ClickVariantId;
    }
  } catch {
    // localStorage may be blocked (private mode, security policy).
    // Silent fallback to default.
  }
  return DEFAULT_CLICK_VARIANT;
}

/** Persist the user's click variant choice and broadcast a custom
 *  event so any listening UI can react (e.g., the preview page
 *  highlighting the newly-active variant). */
export function setActiveClickVariant(id: ClickVariantId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CLICK_STORAGE_KEY, id);
  } catch {
    // localStorage blocked — nothing we can do; caller UI can still
    // hear the sound via the play() call it typically makes alongside
    // this setter.
  }
  window.dispatchEvent(
    new CustomEvent("studio:click-variant-changed", { detail: { id } })
  );
}

/** Read the user's selected rollup variant from localStorage. Falls
 *  back to DEFAULT_ROLLUP_VARIANT when unset or invalid. */
export function getActiveRollupVariant(): RollupVariantId {
  if (typeof window === "undefined") return DEFAULT_ROLLUP_VARIANT;
  try {
    const stored = window.localStorage.getItem(ROLLUP_STORAGE_KEY);
    if (stored && stored in ROLLUP_VARIANTS) {
      return stored as RollupVariantId;
    }
  } catch {
    // localStorage blocked — silent fallback.
  }
  return DEFAULT_ROLLUP_VARIANT;
}

/** Persist the user's rollup variant choice and broadcast a custom
 *  event so the preview page can highlight the new active. */
export function setActiveRollupVariant(id: RollupVariantId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ROLLUP_STORAGE_KEY, id);
  } catch {
    // localStorage blocked — silent no-op.
  }
  window.dispatchEvent(
    new CustomEvent("studio:rollup-variant-changed", { detail: { id } })
  );
}

/** Read the user's selected cracker variant from localStorage. Falls
 *  back to DEFAULT_CRACKER_VARIANT when unset or invalid. */
export function getActiveCrackerVariant(): CrackerVariantId {
  if (typeof window === "undefined") return DEFAULT_CRACKER_VARIANT;
  try {
    const stored = window.localStorage.getItem(CRACKER_STORAGE_KEY);
    if (stored && stored in CRACKER_VARIANTS) {
      return stored as CrackerVariantId;
    }
  } catch {
    // localStorage blocked — silent fallback.
  }
  return DEFAULT_CRACKER_VARIANT;
}

/** Persist the user's cracker variant choice and broadcast a custom
 *  event so the preview page can highlight the new active. */
export function setActiveCrackerVariant(id: CrackerVariantId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CRACKER_STORAGE_KEY, id);
  } catch {
    // localStorage blocked — silent no-op.
  }
  window.dispatchEvent(
    new CustomEvent("studio:cracker-variant-changed", { detail: { id } })
  );
}

/** Read the user's selected verdict-GREEN variant from localStorage.
 *  Falls back to DEFAULT_VERDICT_GREEN_VARIANT (major_bell) when
 *  unset or the stored value is no longer a valid variant ID. */
export function getActiveVerdictGreenVariant(): VerdictGreenVariantId {
  if (typeof window === "undefined") return DEFAULT_VERDICT_GREEN_VARIANT;
  try {
    const stored = window.localStorage.getItem(VERDICT_GREEN_STORAGE_KEY);
    if (stored && stored in VERDICT_GREEN_VARIANTS) {
      return stored as VerdictGreenVariantId;
    }
  } catch {
    // localStorage blocked — silent fallback.
  }
  return DEFAULT_VERDICT_GREEN_VARIANT;
}

/** Persist the user's verdict-green choice and broadcast a custom
 *  event so /studio/sounds can sync the active-row indicator
 *  without a page reload. */
export function setActiveVerdictGreenVariant(id: VerdictGreenVariantId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VERDICT_GREEN_STORAGE_KEY, id);
  } catch {
    // localStorage blocked — silent no-op.
  }
  window.dispatchEvent(
    new CustomEvent("studio:verdict-green-variant-changed", { detail: { id } })
  );
}

/** Read the user's selected verdict-RED variant from localStorage.
 *  Falls back to DEFAULT_VERDICT_RED_VARIANT (minor_descent) when
 *  unset or invalid. */
export function getActiveVerdictRedVariant(): VerdictRedVariantId {
  if (typeof window === "undefined") return DEFAULT_VERDICT_RED_VARIANT;
  try {
    const stored = window.localStorage.getItem(VERDICT_RED_STORAGE_KEY);
    if (stored && stored in VERDICT_RED_VARIANTS) {
      return stored as VerdictRedVariantId;
    }
  } catch {
    // localStorage blocked — silent fallback.
  }
  return DEFAULT_VERDICT_RED_VARIANT;
}

/** Persist the user's verdict-red choice and broadcast a custom
 *  event so /studio/sounds can sync the active-row indicator. */
export function setActiveVerdictRedVariant(id: VerdictRedVariantId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VERDICT_RED_STORAGE_KEY, id);
  } catch {
    // localStorage blocked — silent no-op.
  }
  window.dispatchEvent(
    new CustomEvent("studio:verdict-red-variant-changed", { detail: { id } })
  );
}

// ── Play dispatcher ──────────────────────────────────────────────

async function play(name: SoundName): Promise<void> {
  if (typeof window === "undefined") return;
  if (!shouldPlay()) return;

  const mp3 = mp3Cache[name];
  if (mp3) {
    try {
      const clone = mp3.cloneNode(true) as HTMLAudioElement;
      clone.volume = defaultVolume(name);
      await clone.play();
      return;
    } catch (err) {
      console.debug(`[studio.sounds] mp3 ${name} play failed, falling back`, err);
    }
  }

  await unlockAudio();
  if (!audioCtx) return;
  try {
    if (name === "click") {
      const variant = getActiveClickVariant();
      CLICK_VARIANTS[variant].synth(audioCtx);
    } else if (name === "swoosh") {
      synthSwoosh(audioCtx);
    } else if (name === "ding") {
      synthDing(audioCtx);
    } else if (name === "rollup") {
      const variant = getActiveRollupVariant();
      ROLLUP_VARIANTS[variant].synth(audioCtx);
    } else if (name === "cracker") {
      const variant = getActiveCrackerVariant();
      CRACKER_VARIANTS[variant].synth(audioCtx);
    }
  } catch (err) {
    console.debug(`[studio.sounds] synth ${name} failed`, err);
  }
}

/** Play a specific click variant WITHOUT changing the active setting.
 *  Used by the preview UI: the user taps a variant's play button,
 *  hears it, then decides whether to make it active. Also respects
 *  prefers-reduced-motion and unlocks audio like the normal path. */
export async function playClickVariant(id: ClickVariantId): Promise<void> {
  if (typeof window === "undefined") return;
  if (!shouldPlay()) return;
  await unlockAudio();
  if (!audioCtx) return;
  try {
    CLICK_VARIANTS[id].synth(audioCtx);
  } catch (err) {
    console.debug(`[studio.sounds] preview ${id} failed`, err);
  }
}

/** Play a specific rollup variant WITHOUT changing the active setting.
 *  Preview UI hook for the /studio/sounds rollup section. */
export async function playRollupVariant(id: RollupVariantId): Promise<void> {
  if (typeof window === "undefined") return;
  if (!shouldPlay()) return;
  await unlockAudio();
  if (!audioCtx) return;
  try {
    ROLLUP_VARIANTS[id].synth(audioCtx);
  } catch (err) {
    console.debug(`[studio.sounds] rollup preview ${id} failed`, err);
  }
}

/** Play a specific cracker variant WITHOUT changing the active
 *  setting. Preview UI hook for the /studio/sounds cracker section. */
export async function playCrackerVariant(id: CrackerVariantId): Promise<void> {
  if (typeof window === "undefined") return;
  if (!shouldPlay()) return;
  await unlockAudio();
  if (!audioCtx) return;
  try {
    CRACKER_VARIANTS[id].synth(audioCtx);
  } catch (err) {
    console.debug(`[studio.sounds] cracker preview ${id} failed`, err);
  }
}

// ── SHARED SYNTH HELPERS ─────────────────────────────────────────

/** Fill a mono AudioBuffer with `duration` seconds of white noise.
 *  Fresh buffer per call — noise cached across plays reveals the
 *  underlying loop pattern when reused rapidly. Cheap enough not
 *  to cache. */
function noiseBuffer(ctx: Ctx, duration: number): AudioBuffer {
  const size = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buf = ctx.createBuffer(1, size, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** Attach exponential decay envelope to a GainNode. Convenience
 *  wrapper for the recurring "set peak, ramp to silence" pattern. */
function decay(g: GainNode, start: number, peak: number, dur: number) {
  g.gain.setValueAtTime(peak, start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
}

/** Schedule a single short "tick" — small noise burst + optional
 *  sine sting. Used by odometer / slot / bank / typewriter / ratchet
 *  rollup variants. `at` is absolute AudioContext time. */
function scheduleTick(
  ctx: Ctx,
  at: number,
  {
    volume,
    freq = 2000,
    dur = 0.01,
    withSting = false,
    stingFreq = 1100,
  }: {
    volume: number;
    freq?: number;
    dur?: number;
    withSting?: boolean;
    stingFreq?: number;
  }
): void {
  // Noise burst
  const nSrc = ctx.createBufferSource();
  nSrc.buffer = noiseBuffer(ctx, dur);
  const nFilter = ctx.createBiquadFilter();
  nFilter.type = "bandpass";
  nFilter.frequency.value = freq;
  nFilter.Q.value = 1.2;
  const nGain = ctx.createGain();
  decay(nGain, at, volume, dur);
  nSrc.connect(nFilter);
  nFilter.connect(nGain);
  nGain.connect(ctx.destination);
  nSrc.start(at);
  nSrc.stop(at + dur + 0.005);

  if (withSting) {
    const stingDur = 0.015;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(stingFreq, at);
    const g = ctx.createGain();
    decay(g, at, volume * 0.5, stingDur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + stingDur + 0.005);
  }
}

/** Schedule a single pitched note (sine unless overridden). Used by
 *  the melodic rollup variants (marimba, piano, chime, xylophone). */
function scheduleNote(
  ctx: Ctx,
  at: number,
  {
    freq,
    volume,
    dur,
    type = "sine",
    filter,
  }: {
    freq: number;
    volume: number;
    dur: number;
    type?: OscillatorType;
    /** Optional lowpass filter cutoff in Hz. */
    filter?: number;
  }
): void {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(volume, at + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);

  if (filter != null) {
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = filter;
    osc.connect(f);
    f.connect(g);
  } else {
    osc.connect(g);
  }
  g.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.01);
}

// ── CLICK VARIANT #1: LAYERED (default) ──────────────────────────
// Three layers: noise burst + mid sine (750Hz) + low sine (380Hz).
// Warm, tactile, all-purpose. The original shipped default.
function synthLayered(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("click");

  // Layer 1: noise burst (attack character)
  const nDur = 0.008;
  const nSrc = ctx.createBufferSource();
  nSrc.buffer = noiseBuffer(ctx, nDur);
  const nFilter = ctx.createBiquadFilter();
  nFilter.type = "bandpass";
  nFilter.frequency.value = 2000;
  nFilter.Q.value = 0.8;
  const nGain = ctx.createGain();
  decay(nGain, now, master * 0.9, nDur);
  nSrc.connect(nFilter);
  nFilter.connect(nGain);
  nGain.connect(ctx.destination);
  nSrc.start(now);
  nSrc.stop(now + nDur + 0.01);

  // Layer 2: mid tone (750Hz)
  const midDur = 0.025;
  const midOsc = ctx.createOscillator();
  midOsc.type = "sine";
  midOsc.frequency.setValueAtTime(750, now);
  const midGain = ctx.createGain();
  decay(midGain, now, master * 0.7, midDur);
  midOsc.connect(midGain);
  midGain.connect(ctx.destination);
  midOsc.start(now);
  midOsc.stop(now + midDur + 0.01);

  // Layer 3: low warmth (380Hz)
  const lowDur = 0.04;
  const lowOsc = ctx.createOscillator();
  lowOsc.type = "sine";
  lowOsc.frequency.setValueAtTime(380, now);
  const lowGain = ctx.createGain();
  decay(lowGain, now, master * 0.5, lowDur);
  lowOsc.connect(lowGain);
  lowGain.connect(ctx.destination);
  lowOsc.start(now);
  lowOsc.stop(now + lowDur + 0.01);
}

// ── CLICK VARIANT #2: CHERRY MX BLUE ─────────────────────────────
// Sharp, pronounced click — the crisp "tick" of a mechanical Blue
// switch. High-passed noise burst + very short high-mid sine sting.
function synthCherryMx(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("click");

  // Sharp noise attack — bandpass higher up for "tick" character
  const nDur = 0.006;
  const nSrc = ctx.createBufferSource();
  nSrc.buffer = noiseBuffer(ctx, nDur);
  const nFilter = ctx.createBiquadFilter();
  nFilter.type = "bandpass";
  nFilter.frequency.value = 3500;
  nFilter.Q.value = 1.5;
  const nGain = ctx.createGain();
  decay(nGain, now, master * 1.2, nDur);
  nSrc.connect(nFilter);
  nFilter.connect(nGain);
  nGain.connect(ctx.destination);
  nSrc.start(now);
  nSrc.stop(now + nDur + 0.01);

  // Short sine sting @ 1100Hz — the tactile bump tone
  const stingDur = 0.015;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(1100, now);
  osc.frequency.exponentialRampToValueAtTime(700, now + stingDur);
  const g = ctx.createGain();
  decay(g, now, master * 0.6, stingDur);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + stingDur + 0.01);
}

// ── CLICK VARIANT #3: TOPRE THOCK ────────────────────────────────
// The famous "thock" of Topre / silent-tactile switches. Low warmth,
// no sharp attack, subtle wooden feel. Muted, boardroom-friendly.
function synthTopreThock(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("click");

  // Very short noise dampened low-pass — subtle "muffled tk"
  const nDur = 0.01;
  const nSrc = ctx.createBufferSource();
  nSrc.buffer = noiseBuffer(ctx, nDur);
  const nFilter = ctx.createBiquadFilter();
  nFilter.type = "lowpass";
  nFilter.frequency.value = 800;
  const nGain = ctx.createGain();
  decay(nGain, now, master * 0.7, nDur);
  nSrc.connect(nFilter);
  nFilter.connect(nGain);
  nGain.connect(ctx.destination);
  nSrc.start(now);
  nSrc.stop(now + nDur + 0.01);

  // Warm sine @ 240Hz — deep body
  const bodyDur = 0.06;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(240, now);
  const g = ctx.createGain();
  decay(g, now, master * 0.9, bodyDur);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + bodyDur + 0.01);

  // Faint sine @ 480Hz — the "hollow" resonance overtone
  const overDur = 0.05;
  const over = ctx.createOscillator();
  over.type = "sine";
  over.frequency.setValueAtTime(480, now);
  const overG = ctx.createGain();
  decay(overG, now, master * 0.3, overDur);
  over.connect(overG);
  overG.connect(ctx.destination);
  over.start(now);
  over.stop(now + overDur + 0.01);
}

// ── CLICK VARIANT #4: WOODEN ─────────────────────────────────────
// Warm wooden "tock" — like tapping a chopstick on hollow bamboo.
// Very low fundamental, pure sine, no noise. Serene, minimal.
function synthWooden(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("click");

  const bodyDur = 0.08;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(180, now);
  osc.frequency.exponentialRampToValueAtTime(140, now + bodyDur);
  const g = ctx.createGain();
  decay(g, now, master * 1.1, bodyDur);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + bodyDur + 0.01);

  const overDur = 0.05;
  const over = ctx.createOscillator();
  over.type = "sine";
  over.frequency.setValueAtTime(360, now);
  const overG = ctx.createGain();
  decay(overG, now, master * 0.35, overDur);
  over.connect(overG);
  overG.connect(ctx.destination);
  over.start(now);
  over.stop(now + overDur + 0.01);
}

// ── CLICK VARIANT #5: BUBBLE POP ─────────────────────────────────
// Playful upward sine sweep — cartoon "bloop". Kid-friendly, works
// well for happy-path confirmations.
function synthBubblePop(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("click");

  const dur = 0.06;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(400, now);
  osc.frequency.exponentialRampToValueAtTime(1400, now + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(master * 1.0, now + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.01);
}

// ── CLICK VARIANT #6: WATER DROP ─────────────────────────────────
// Descending sine with sparkle overtone — the ASMR classic. Slightly
// wetter and more resonant than the other clicks.
function synthWaterDrop(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("click");

  const dur = 0.11;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(1200, now);
  osc.frequency.exponentialRampToValueAtTime(500, now + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(master * 1.0, now + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.01);

  // Sparkle overtone at 2× the peak — adds "wet" character
  const overDur = 0.05;
  const over = ctx.createOscillator();
  over.type = "sine";
  over.frequency.setValueAtTime(2400, now);
  const overG = ctx.createGain();
  decay(overG, now, master * 0.35, overDur);
  over.connect(overG);
  overG.connect(ctx.destination);
  over.start(now);
  over.stop(now + overDur + 0.01);
}

// ── CLICK VARIANT #7: SOFT CHIME TICK ────────────────────────────
// Delicate bell-like tick — pair of high sines with matched short
// decays. Precious, almost musical. Feels like a xylophone tap.
function synthChimeTick(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("click");

  const notes: Array<{ f: number; v: number; d: number }> = [
    { f: 1568, v: 0.9, d: 0.09 }, // G6
    { f: 3136, v: 0.35, d: 0.05 }, // G7 (octave sparkle)
  ];
  for (const n of notes) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(n.f, now);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(master * n.v, now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, now + n.d);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + n.d + 0.01);
  }
}

// ── CLICK VARIANT #8: PAPER SNAP ─────────────────────────────────
// Dry, papery — pure filtered noise, no tonal component. Feels like
// flipping a card or snapping a page. Minimal, professional.
function synthPaperSnap(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("click");

  const dur = 0.02;
  const nSrc = ctx.createBufferSource();
  nSrc.buffer = noiseBuffer(ctx, dur);
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 1600;
  filter.Q.value = 0.6;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(master * 1.5, now + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  nSrc.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  nSrc.start(now);
  nSrc.stop(now + dur + 0.01);
}

// ── CLICK VARIANT #9: IPHONE TAP ─────────────────────────────────
// Clean UI tap — the sound Apple uses for keyboard clicks. Single
// filtered sine with a hint of noise. Familiar, universally readable.
function synthIphoneTap(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("click");

  const dur = 0.03;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(1000, now);
  osc.frequency.exponentialRampToValueAtTime(700, now + dur);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 3500;
  const g = ctx.createGain();
  decay(g, now, master * 1.0, dur);
  osc.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.01);

  // Tiny noise dust @ start for the "tik"
  const nDur = 0.004;
  const nSrc = ctx.createBufferSource();
  nSrc.buffer = noiseBuffer(ctx, nDur);
  const nFilter = ctx.createBiquadFilter();
  nFilter.type = "highpass";
  nFilter.frequency.value = 2000;
  const nG = ctx.createGain();
  decay(nG, now, master * 0.5, nDur);
  nSrc.connect(nFilter);
  nFilter.connect(nG);
  nG.connect(ctx.destination);
  nSrc.start(now);
  nSrc.stop(now + nDur + 0.01);
}

// ── CLICK VARIANT #10: PLUCK ─────────────────────────────────────
// Plucked string feel — sawtooth wave with fast lowpass sweep. Adds
// a musical / harp-adjacent character to interactions.
function synthPluck(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("click");

  const dur = 0.08;
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(440, now); // A4
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(4000, now);
  filter.frequency.exponentialRampToValueAtTime(400, now + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(master * 0.9, now + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.01);
}

// ── VARIANT REGISTRY ─────────────────────────────────────────────

/** Master map of all click variants. Each entry pairs the ID with
 *  display metadata (for the /studio/sounds UI) and its synth
 *  function. Insertion order defines display order on the picker. */
export const CLICK_VARIANTS: Record<
  ClickVariantId,
  ClickVariantMeta & { synth: (ctx: Ctx) => void }
> = {
  layered: {
    id: "layered",
    name: "Layered",
    description: "Warm three-layer tap. Noise burst + mid + low sine. The all-purpose default.",
    synth: synthLayered,
  },
  cherry_mx: {
    id: "cherry_mx",
    name: "Cherry MX Blue",
    description: "Sharp mechanical-switch click. Crisp, pronounced, gamer-desk energy.",
    synth: synthCherryMx,
  },
  topre_thock: {
    id: "topre_thock",
    name: "Topre Thock",
    description: "Deep silent-tactile thock. Muffled, warm, boardroom-friendly.",
    synth: synthTopreThock,
  },
  wooden: {
    id: "wooden",
    name: "Wooden",
    description: "Hollow wooden tap. Serene, minimal, no noise — pure sine warmth.",
    synth: synthWooden,
  },
  bubble_pop: {
    id: "bubble_pop",
    name: "Bubble Pop",
    description: "Cartoon upward bloop. Playful, kid-friendly, happy-path vibe.",
    synth: synthBubblePop,
  },
  water_drop: {
    id: "water_drop",
    name: "Water Drop",
    description: "Descending sine with sparkle overtone. Classic ASMR water plink.",
    synth: synthWaterDrop,
  },
  chime_tick: {
    id: "chime_tick",
    name: "Chime Tick",
    description: "Delicate bell tick — G6 + G7 sparkle. Almost musical.",
    synth: synthChimeTick,
  },
  paper_snap: {
    id: "paper_snap",
    name: "Paper Snap",
    description: "Dry papery snap. Pure filtered noise, no tone. Minimal & professional.",
    synth: synthPaperSnap,
  },
  iphone_tap: {
    id: "iphone_tap",
    name: "iPhone Tap",
    description: "Clean UI tap — familiar Apple keyboard click character.",
    synth: synthIphoneTap,
  },
  pluck: {
    id: "pluck",
    name: "Pluck",
    description: "Plucked string. Sawtooth with lowpass sweep — musical, harp-adjacent.",
    synth: synthPluck,
  },
};

/** Ordered list for iteration in the picker UI. Order matches
 *  CLICK_VARIANTS insertion order (which is display order). */
export const CLICK_VARIANT_LIST: readonly ClickVariantMeta[] = Object.values(
  CLICK_VARIANTS
).map(({ id, name, description }) => ({ id, name, description }));

// ─────────────────────────────────────────────────────────────────
// ROLLUP VARIANTS (15) — fire when progress + stats cells begin
// counting up. All designed to be 800-1500ms so they cover most of
// the cascade window without becoming a fatigue-inducing wash of
// sound. Each variant is a self-contained recipe below.
// ─────────────────────────────────────────────────────────────────

// ── ROLLUP #1: ODOMETER ─────────────────────────────────────────
// Rapid decelerating ticks — the classic "mechanical counter
// spinning down to a stop" sound. Duration + concluding ding match
// synthSlotMachine so either variant stays locked to Total Orders
// settling (ROLLUP_SOUND_BEGIN + ≈2030ms = 4030). Prior shorter
// body (~1.2s, no ding) ended near the chart pill roll-up.
function synthOdometer(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("rollup");
  // 26 ticks, cubic ease-out — same envelope length as slot_machine.
  const count = 26;
  let t = now;
  for (let i = 0; i < count; i++) {
    const isLast = i === count - 1;
    scheduleTick(ctx, t, {
      volume: master * (isLast ? 1.35 : 0.9),
      freq: isLast ? 2200 : 1800,
      dur: 0.008,
      withSting: isLast,
      stingFreq: 2000,
    });
    const progress = i / (count - 1);
    const interval = 0.048 + Math.pow(progress, 3) * 0.12;
    t += interval;
  }
  // Ending beep #1 — lands with Total Orders settle when fired from
  // ROLLUP_SOUND_BEGIN. No follow-up ding; one climax tone is enough.
  scheduleNote(ctx, t + 0.03, {
    freq: 1568, // G6
    volume: master * 1.15,
    dur: 0.5,
  });
}

// ── ROLLUP #2: SLOT MACHINE ─────────────────────────────────────
// Wheel spin with cubic ease-out deceleration — starts fast (~48ms
// between ticks) and gradually slows to a stop (~170ms between the
// final ticks), just like a real slot machine wheel losing momentum.
//
// TOTAL DURATION TUNING
// ─────────────────────
// Total spin time tuned to ~2030ms so the concluding jackpot chime
// lands exactly when the last rolling stats tile (currently Total
// Orders, index 5) finishes its roll-up animation. The math for the
// current 6-cell layout (2026-07-28 late night):
//
//   Sound trigger: ROLLUP_SOUND_BEGIN = 2000
//   Last roll ends: STATS_BASE + 5*STATS_STAGGER + STATS_ROLLUP
//                 = 2580 + 500 + 950 = 4030
//   Sound ends:     ROLLUP_SOUND_BEGIN + 2030 = 4030
//   Desync:         0ms (millisecond-perfect)
//
// History: the sync target was originally the XIRR tile (4th
// rolling cell) at STATS_BASE=2750 STATS_STAGGER=110, math
// 2750 + 330 + 950 - 2000 = 2030ms. XIRR was dropped and the
// grid iterated through several layouts; the target moved to
// the last rolling tile in each layout. Duration stayed constant
// (2030ms) — RevealDashboard's STUDIO_TIMING was adjusted instead
// to keep this sound as the audio "curtain".
function synthSlotMachine(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("rollup");

  // 26 ticks with cubic ease-out timing — interval starts at 48ms
  // and grows to ~168ms as the wheel decelerates. Sum ≈ 2000ms.
  const count = 26;
  let t = now;
  for (let i = 0; i < count; i++) {
    const isLast = i === count - 1;
    scheduleTick(ctx, t, {
      volume: master * (isLast ? 1.5 : 0.85),
      freq: isLast ? 2500 : 1700,
      dur: 0.01,
      withSting: isLast,
      stingFreq: 2200,
    });
    // Cubic ease-out: minimal deceleration at the start, aggressive
    // slowdown at the end. Feels like a physical wheel with drag.
    const progress = i / (count - 1);
    const interval = 0.048 + Math.pow(progress, 3) * 0.12;
    t += interval;
  }

  // Concluding chime — the jackpot ding. Lands ~30ms after the
  // final tick's sting, ending the sound at ~2030ms total. Longer
  // decay (500ms) than before so the ding lingers softly as the
  // visual reveal settles.
  scheduleNote(ctx, t + 0.03, {
    freq: 1568, // G6
    volume: master * 1.2,
    dur: 0.5,
  });
}

// ── ROLLUP #3: CASH REGISTER ────────────────────────────────────
// Mechanical whir + drawer bell. Filtered noise for the drawer
// slide, chime tone at the end for the "cha-ching".
function synthCashRegister(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("rollup");

  // Whir (filtered pink-ish noise)
  const whirDur = 0.65;
  const nSrc = ctx.createBufferSource();
  nSrc.buffer = noiseBuffer(ctx, whirDur);
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 900;
  filter.Q.value = 1.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(master * 1.1, now + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, now + whirDur);
  nSrc.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  nSrc.start(now);
  nSrc.stop(now + whirDur + 0.02);

  // Bell — the concluding "ching"
  scheduleNote(ctx, now + whirDur - 0.05, {
    freq: 1760, // A6
    volume: master * 1.2,
    dur: 0.4,
  });
  scheduleNote(ctx, now + whirDur - 0.05, {
    freq: 3520, // A7 sparkle
    volume: master * 0.5,
    dur: 0.25,
  });
}

// ── ROLLUP #4: BANK COUNTER ─────────────────────────────────────
// Rapid paper-flip sound — the currency counter machine. Purely
// noise-based, no tonal component. Feels "counting money".
function synthBankCounter(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("rollup");
  const count = 12;
  const interval = 0.075;
  for (let i = 0; i < count; i++) {
    const at = now + i * interval;
    const dur = 0.02;
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(ctx, dur);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1400 + (Math.random() - 0.5) * 200;
    filter.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(master * 1.3, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    nSrc.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);
    nSrc.start(at);
    nSrc.stop(at + dur + 0.005);
  }
}

// ── ROLLUP #5: TYPEWRITER ROLL ──────────────────────────────────
// Rapid staccato key clacks + concluding carriage return bell.
function synthTypewriter(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("rollup");
  const count = 10;
  const interval = 0.085;
  for (let i = 0; i < count; i++) {
    scheduleTick(ctx, now + i * interval, {
      volume: master * 0.9,
      freq: 2200,
      dur: 0.012,
      withSting: true,
      stingFreq: 900,
    });
  }
  // Carriage return bell at end
  scheduleNote(ctx, now + count * interval + 0.05, {
    freq: 2093, // C7
    volume: master * 0.9,
    dur: 0.5,
  });
}

// ── ROLLUP #6: MARIMBA RISE ─────────────────────────────────────
// Ascending wooden pentatonic scale — warm, mellow, resonant. 6
// notes over ~1s.
function synthMarimbaRise(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("rollup");
  // C major pentatonic: C4, D4, E4, G4, A4, C5, D5
  const notes = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33];
  const interval = 0.14;
  for (let i = 0; i < notes.length; i++) {
    scheduleNote(ctx, now + i * interval, {
      freq: notes[i],
      volume: master * 1.1,
      dur: 0.35,
      type: "sine",
      // Marimba warmth: lowpass keeps it from feeling glassy.
      filter: 3000,
    });
    // Octave overtone for wooden resonance
    scheduleNote(ctx, now + i * interval, {
      freq: notes[i] * 2,
      volume: master * 0.35,
      dur: 0.2,
      type: "sine",
    });
  }
}

// ── ROLLUP #7: PIANO ARPEGGIO ───────────────────────────────────
// Ascending major-scale arpeggio — feels like a hopeful, forward-
// moving musical phrase.
function synthPianoArpeggio(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("rollup");
  // C major arpeggio: C4, E4, G4, C5, E5, G5, C6
  const notes = [261.63, 329.63, 392.0, 523.25, 659.25, 783.99, 1046.5];
  const interval = 0.12;
  for (let i = 0; i < notes.length; i++) {
    // Fundamental
    scheduleNote(ctx, now + i * interval, {
      freq: notes[i],
      volume: master * 1.0,
      dur: 0.5,
      type: "triangle",
      filter: 3500,
    });
    // Fifth overtone (mimics piano's harmonic content)
    scheduleNote(ctx, now + i * interval, {
      freq: notes[i] * 1.5,
      volume: master * 0.3,
      dur: 0.3,
      type: "sine",
    });
  }
}

// ── ROLLUP #8: CHIME CASCADE ────────────────────────────────────
// Delicate high bell tones cascading upward with overlap — feels
// like a wind chime being brushed. Ethereal, precious.
function synthChimeCascade(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("rollup");
  // G major with sparkle: G5, B5, D6, G6, B6, D7
  const notes = [783.99, 987.77, 1174.66, 1567.98, 1975.53, 2349.32];
  const interval = 0.15;
  for (let i = 0; i < notes.length; i++) {
    scheduleNote(ctx, now + i * interval, {
      freq: notes[i],
      volume: master * 0.9,
      dur: 0.6, // Long tail so chimes overlap into a shimmer
      type: "sine",
    });
  }
}

// ── ROLLUP #9: XYLOPHONE RISE ───────────────────────────────────
// Bright ascending octave — 8 notes across a full octave, short
// crisp attacks.
function synthXylophoneRise(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("rollup");
  // C major scale: C5 → C6
  const notes = [523.25, 587.33, 659.25, 698.46, 783.99, 880.0, 987.77, 1046.5];
  const interval = 0.09;
  for (let i = 0; i < notes.length; i++) {
    scheduleNote(ctx, now + i * interval, {
      freq: notes[i],
      volume: master * 1.0,
      dur: 0.22,
      type: "sine",
    });
    // Second harmonic for xylo brightness
    scheduleNote(ctx, now + i * interval, {
      freq: notes[i] * 3,
      volume: master * 0.25,
      dur: 0.1,
      type: "sine",
    });
  }
}

// ── ROLLUP #10: DATA STREAM ─────────────────────────────────────
// Digital ascending beeps — retro-computer counting up. Square
// waves with fast pitch stepping.
function synthDataStream(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("rollup");
  const count = 16;
  const interval = 0.05;
  for (let i = 0; i < count; i++) {
    const freq = 400 + (i / (count - 1)) * 1600; // 400 → 2000Hz
    scheduleNote(ctx, now + i * interval, {
      freq,
      volume: master * 0.6,
      dur: 0.04,
      type: "square",
      filter: 3500,
    });
  }
}

// ── ROLLUP #11: RETRO BEEP ──────────────────────────────────────
// 8-bit arcade "power up" — classic chip-tune ascending sweep with
// stepped pitches.
function synthRetroBeep(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("rollup");
  const count = 10;
  const interval = 0.07;
  // Pentatonic stepping so it sounds musical, not random.
  const scale = [261.63, 329.63, 392.0, 523.25, 659.25];
  for (let i = 0; i < count; i++) {
    const freq = scale[i % scale.length] * Math.pow(2, Math.floor(i / scale.length));
    scheduleNote(ctx, now + i * interval, {
      freq,
      volume: master * 0.8,
      dur: 0.06,
      type: "square",
      filter: 3000,
    });
  }
}

// ── ROLLUP #12: RATCHET ROLL ────────────────────────────────────
// Clockwork regular ticks — no melody, pure mechanical rhythm.
// Even tempo throughout. Feels like winding a watch.
function synthRatchetRoll(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("rollup");
  const count = 18;
  const interval = 0.055;
  for (let i = 0; i < count; i++) {
    scheduleTick(ctx, now + i * interval, {
      volume: master * 0.85,
      freq: 1500,
      dur: 0.008,
      withSting: true,
      stingFreq: 600,
    });
  }
}

// ── ROLLUP #13: COIN RAIN ───────────────────────────────────────
// Metallic pings at randomized intervals — like coins spilling out
// of a cup one after another. Satisfying, prosperity-adjacent.
function synthCoinRain(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("rollup");
  const count = 10;
  const totalDur = 1.1;
  for (let i = 0; i < count; i++) {
    // Randomize timing within the window
    const t = now + (i / count) * totalDur + (Math.random() - 0.5) * 0.05;
    // Pick pitch randomly from a set of coin-like frequencies
    const pitchOptions = [1760, 1975, 2349, 2637, 3136]; // A6, B6, D7, E7, G7
    const freq = pitchOptions[Math.floor(Math.random() * pitchOptions.length)];
    scheduleNote(ctx, t, {
      freq,
      volume: master * (0.6 + Math.random() * 0.4),
      dur: 0.15,
      type: "sine",
    });
    // Metallic "tink" noise burst per coin
    const nDur = 0.005;
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuffer(ctx, nDur);
    const nFilter = ctx.createBiquadFilter();
    nFilter.type = "highpass";
    nFilter.frequency.value = 3000;
    const nG = ctx.createGain();
    decay(nG, t, master * 0.5, nDur);
    nSrc.connect(nFilter);
    nFilter.connect(nG);
    nG.connect(ctx.destination);
    nSrc.start(t);
    nSrc.stop(t + nDur + 0.005);
  }
}

// ── ROLLUP #14: WIND CHIME ──────────────────────────────────────
// Gentle detuned bell tones ringing at random times — the sound of
// a wind chime being brushed by a breeze. Longest & most ambient
// variant.
function synthWindChime(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("rollup");
  const count = 7;
  const totalDur = 1.3;
  // Slightly detuned pentatonic (Db6 pentatonic-ish, spread over
  // a wide range for that chimes-in-the-wind chorus effect).
  const notes = [
    1108.73, // Db6
    1244.51, // Eb6
    1479.98, // Gb6
    1661.22, // Ab6
    1975.53, // B6
    2217.46, // Db7
    2637.02, // E7
  ];
  for (let i = 0; i < count; i++) {
    const t = now + (i / count) * totalDur + (Math.random() - 0.5) * 0.08;
    const freq = notes[i % notes.length] * (1 + (Math.random() - 0.5) * 0.008);
    scheduleNote(ctx, t, {
      freq,
      volume: master * (0.6 + Math.random() * 0.4),
      dur: 0.7 + Math.random() * 0.3,
      type: "sine",
    });
  }
}

// ── ROLLUP #15: VINYL RISE ──────────────────────────────────────
// Warm vinyl crackle with a rising sub-tone underneath. Feels
// analog, nostalgic.
function synthVinylRise(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("rollup");
  const dur = 1.0;

  // Crackle: filtered noise, mid-band, moderate volume
  const nSrc = ctx.createBufferSource();
  nSrc.buffer = noiseBuffer(ctx, dur);
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(1500, now);
  filter.frequency.exponentialRampToValueAtTime(3500, now + dur);
  filter.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(master * 0.9, now + 0.1);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  nSrc.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  nSrc.start(now);
  nSrc.stop(now + dur + 0.02);

  // Rising sine underneath — the "coming into focus" character
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(220, now);
  osc.frequency.exponentialRampToValueAtTime(880, now + dur);
  const oscG = ctx.createGain();
  oscG.gain.setValueAtTime(0.0001, now);
  oscG.gain.exponentialRampToValueAtTime(master * 0.5, now + 0.15);
  oscG.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(oscG);
  oscG.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

// ── ROLLUP REGISTRY ─────────────────────────────────────────────

export const ROLLUP_VARIANTS: Record<
  RollupVariantId,
  RollupVariantMeta & { synth: (ctx: Ctx) => void }
> = {
  odometer: {
    id: "odometer",
    name: "Odometer",
    description: "Decelerating mechanical ticks — the classic counter spinning down.",
    synth: synthOdometer,
  },
  slot_machine: {
    id: "slot_machine",
    name: "Slot Machine",
    description: "Constant wheel clicks + jackpot ding. Vegas floor energy.",
    synth: synthSlotMachine,
  },
  cash_register: {
    id: "cash_register",
    name: "Cash Register",
    description: "Mechanical drawer whir + concluding cha-ching bell.",
    synth: synthCashRegister,
  },
  bank_counter: {
    id: "bank_counter",
    name: "Bank Counter",
    description: "Rapid currency-counter paper flips. All-noise, no tone.",
    synth: synthBankCounter,
  },
  typewriter: {
    id: "typewriter",
    name: "Typewriter",
    description: "Staccato key clacks + carriage-return bell. Newsroom vibes.",
    synth: synthTypewriter,
  },
  marimba_rise: {
    id: "marimba_rise",
    name: "Marimba Rise",
    description: "Ascending wooden pentatonic scale. Warm, mellow, resonant.",
    synth: synthMarimbaRise,
  },
  piano_arpeggio: {
    id: "piano_arpeggio",
    name: "Piano Arpeggio",
    description: "Ascending C-major arpeggio. Hopeful, forward-moving.",
    synth: synthPianoArpeggio,
  },
  chime_cascade: {
    id: "chime_cascade",
    name: "Chime Cascade",
    description: "Delicate overlapping bell tones. Ethereal shimmer.",
    synth: synthChimeCascade,
  },
  xylophone_rise: {
    id: "xylophone_rise",
    name: "Xylophone Rise",
    description: "Bright ascending octave — 8 crisp bell tones.",
    synth: synthXylophoneRise,
  },
  data_stream: {
    id: "data_stream",
    name: "Data Stream",
    description: "Retro-computer counting up. Rising square-wave beeps.",
    synth: synthDataStream,
  },
  retro_beep: {
    id: "retro_beep",
    name: "Retro Beep",
    description: "8-bit arcade power-up. Chip-tune stepping ascending sweep.",
    synth: synthRetroBeep,
  },
  ratchet_roll: {
    id: "ratchet_roll",
    name: "Ratchet Roll",
    description: "Clockwork mechanical ticks. Winding-a-watch rhythm.",
    synth: synthRatchetRoll,
  },
  coin_rain: {
    id: "coin_rain",
    name: "Coin Rain",
    description: "Metallic pings at random intervals. Coins spilling out.",
    synth: synthCoinRain,
  },
  wind_chime: {
    id: "wind_chime",
    name: "Wind Chime",
    description: "Gentle detuned bells ringing on the breeze. Most ambient.",
    synth: synthWindChime,
  },
  vinyl_rise: {
    id: "vinyl_rise",
    name: "Vinyl Rise",
    description: "Warm crackle + rising sub-tone. Analog, nostalgic.",
    synth: synthVinylRise,
  },
};

/** Ordered list for iteration in the picker UI. */
export const ROLLUP_VARIANT_LIST: readonly RollupVariantMeta[] =
  Object.values(ROLLUP_VARIANTS).map(({ id, name, description }) => ({
    id,
    name,
    description,
  }));

// ─────────────────────────────────────────────────────────────────
// SKY-CRACKER VARIANTS (10) — fire ONCE when the celebration Lottie
// mounts, right after a successful order submit. Each variant is
// 400-2000ms so it wraps inside the Lottie's 2670ms runtime without
// spilling into the reveal's swoosh + chart-draw beat (which starts
// at ~t=Lottie-end). All use defaultVolume("cracker") = 0.24 as the
// master gain — slightly louder than the ding because this IS the
// celebration beat.
// ─────────────────────────────────────────────────────────────────

/** Classic Pop — sharp square-wave attack + filtered noise burst.
 *  The universal "party popper crack" — like a small cardboard
 *  tube tearing open. ~350ms. */
function synthClassicPop(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("cracker");

  // Attack: brief square-wave chirp descending 200→60Hz (tactile "pop")
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.setValueAtTime(200, now);
  osc.frequency.exponentialRampToValueAtTime(60, now + 0.03);
  const oscGain = ctx.createGain();
  decay(oscGain, now, master * 0.6, 0.03);
  osc.connect(oscGain);
  oscGain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.05);

  // Noise burst: bandpass 3kHz, 300ms tail
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 0.3);
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 3000;
  filter.Q.value = 0.8;
  const g = ctx.createGain();
  decay(g, now, master * 0.5, 0.3);
  src.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  src.start(now);
  src.stop(now + 0.35);
}

/** Diwali Bomb — sub-bass boom followed by 1.2s of random crackle
 *  pulses in the highpass band. The cinematic "BOOM… crackle-
 *  crackle-crackle" of a big Diwali firework. ~1500ms. */
function synthDiwaliBomb(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("cracker");

  // Bass boom: 80Hz sine sweeping down to 30Hz, exponential decay
  const bass = ctx.createOscillator();
  bass.type = "sine";
  bass.frequency.setValueAtTime(80, now);
  bass.frequency.exponentialRampToValueAtTime(30, now + 0.4);
  const bassG = ctx.createGain();
  bassG.gain.setValueAtTime(0.0001, now);
  bassG.gain.exponentialRampToValueAtTime(master * 1.1, now + 0.01);
  bassG.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
  bass.connect(bassG);
  bassG.connect(ctx.destination);
  bass.start(now);
  bass.stop(now + 0.55);

  // Crackle tail: 12 random-timed short noise bursts over 1.2s
  // Each pulse gets a random highpass cutoff so the crackle has
  // pitch variance, not a monotone hiss.
  for (let i = 0; i < 12; i++) {
    const t = now + 0.15 + Math.random() * 1.2;
    const pulseDur = 0.02 + Math.random() * 0.03;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, pulseDur);
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 5000 + Math.random() * 3000;
    const g = ctx.createGain();
    decay(g, t, master * (0.15 + Math.random() * 0.25), pulseDur);
    src.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);
    src.start(t);
    src.stop(t + pulseDur + 0.005);
  }
}

/** Rocket Whistle — pitch-sweeping sine rising 400→2200Hz over
 *  800ms, then a bright noise pop at the peak. Classic bottle-
 *  rocket "PSSSSHHHH… POP!". THE DEFAULT — this is the archetypal
 *  sky-cracker for the recording aesthetic. ~1000ms. */
function synthRocketWhistle(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("cracker");

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(400, now);
  osc.frequency.exponentialRampToValueAtTime(2200, now + 0.8);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(master * 0.35, now + 0.05);
  g.gain.setValueAtTime(master * 0.35, now + 0.75);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.82);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.85);

  // Peak pop at t=0.8: broadband noise burst
  const popT = now + 0.8;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 0.15);
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 4000;
  filter.Q.value = 0.5;
  const popG = ctx.createGain();
  decay(popG, popT, master * 0.7, 0.15);
  src.connect(filter);
  filter.connect(popG);
  popG.connect(ctx.destination);
  src.start(popT);
  src.stop(popT + 0.2);
}

/** Whistle Bomb — rising whistle (375ms, 400→1600Hz) followed by
 *  a BIG bass-heavy boom (sub-bass sine sweep + broadband noise
 *  impact). More dramatic than Rocket Whistle; feels like a
 *  shooting-star Diwali rocket with real payload. Total ~600ms.
 *  User tuning 2026-07-25: retuned 1600 → 1000 → 800 → 600ms; the
 *  whistle-to-boom ratio (~5:3) is preserved so it still reads as
 *  "buildup → payoff", just compressed further. */
function synthWhistleBomb(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("cracker");

  // Whistle rise: 400 → 1600Hz over 375ms — lower peak than Rocket
  // Whistle so the boom has room to shine
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(400, now);
  osc.frequency.exponentialRampToValueAtTime(1600, now + 0.375);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(master * 0.32, now + 0.04);
  g.gain.setValueAtTime(master * 0.32, now + 0.335);
  // Fade to silence right at boom moment — auditory setup for impact
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.375);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.42);

  // BOOM at t=0.375: sub-bass 80→30Hz + broadband noise, both
  // decaying over 225ms → total sound ends at ~0.6s
  const boomT = now + 0.375;
  const bass = ctx.createOscillator();
  bass.type = "sine";
  bass.frequency.setValueAtTime(80, boomT);
  bass.frequency.exponentialRampToValueAtTime(30, boomT + 0.225);
  const bassG = ctx.createGain();
  bassG.gain.setValueAtTime(0.0001, boomT);
  bassG.gain.exponentialRampToValueAtTime(master * 1.1, boomT + 0.02);
  bassG.gain.exponentialRampToValueAtTime(0.0001, boomT + 0.225);
  bass.connect(bassG);
  bassG.connect(ctx.destination);
  bass.start(boomT);
  bass.stop(boomT + 0.28);

  // Impact noise on top of the bass boom, lowpass-filtered for warmth
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 0.2);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 4000;
  const noiseG = ctx.createGain();
  decay(noiseG, boomT, master * 0.7, 0.2);
  src.connect(filter);
  filter.connect(noiseG);
  noiseG.connect(ctx.destination);
  src.start(boomT);
  src.stop(boomT + 0.25);
}

/** Screamer — fast wild rise (600ms, 200→3500Hz) using a sawtooth
 *  oscillator (edgier than sine) with a lowpass filter sweep,
 *  capped by a sharp bright pop + high-freq sting. Chaotic and
 *  loud — the "screamer" variety of firework. ~800ms. */
function synthScreamer(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("cracker");

  // Sawtooth for harsh character, lowpass-filtered so it doesn't
  // shred phone speakers at the top of the sweep
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(200, now);
  osc.frequency.exponentialRampToValueAtTime(3500, now + 0.6);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(2000, now);
  filter.frequency.exponentialRampToValueAtTime(6000, now + 0.6);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(master * 0.25, now + 0.05);
  g.gain.setValueAtTime(master * 0.25, now + 0.55);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.62);
  osc.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.65);

  // Sharp bright pop at peak: bandpassed noise
  const popT = now + 0.6;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 0.18);
  const pFilter = ctx.createBiquadFilter();
  pFilter.type = "bandpass";
  pFilter.frequency.value = 3500;
  pFilter.Q.value = 1.5;
  const pG = ctx.createGain();
  decay(pG, popT, master * 0.85, 0.15);
  src.connect(pFilter);
  pFilter.connect(pG);
  pG.connect(ctx.destination);
  src.start(popT);
  src.stop(popT + 0.2);

  // Extra high-freq sting for cutting brightness on top of the pop
  const sting = ctx.createOscillator();
  sting.type = "sine";
  sting.frequency.setValueAtTime(4500, popT);
  const stingG = ctx.createGain();
  decay(stingG, popT, master * 0.4, 0.1);
  sting.connect(stingG);
  stingG.connect(ctx.destination);
  sting.start(popT);
  sting.stop(popT + 0.12);
}

/** Fuse & Bang — hissing noise fuse (highpass-filtered, low volume,
 *  with random-value sputter gain modulation) for 700ms, then a
 *  big sudden bomb burst. Cartoon TNT-with-lit-fuse. ~1000ms. */
function synthFuseBang(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("cracker");

  // Fuse: bandpass-filtered noise for 700ms
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 0.7);
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 3500;
  filter.Q.value = 1.2;
  const fuseG = ctx.createGain();
  // Sputter: random gain fluctuations over 700ms give the fuse
  // its characteristic irregular hiss. 10 breakpoints = ~14/sec,
  // faster than most human ears can resolve as individual events.
  fuseG.gain.setValueAtTime(0.0001, now);
  fuseG.gain.exponentialRampToValueAtTime(master * 0.18, now + 0.05);
  for (let i = 0; i < 10; i++) {
    const t = now + 0.05 + (i / 10) * 0.6;
    fuseG.gain.linearRampToValueAtTime(
      master * (0.15 + Math.random() * 0.15),
      t
    );
  }
  fuseG.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
  src.connect(filter);
  filter.connect(fuseG);
  fuseG.connect(ctx.destination);
  src.start(now);
  src.stop(now + 0.72);

  // BANG at t=0.7: bass boom + noise impact
  const bangT = now + 0.7;
  const bass = ctx.createOscillator();
  bass.type = "sine";
  bass.frequency.setValueAtTime(70, bangT);
  bass.frequency.exponentialRampToValueAtTime(25, bangT + 0.3);
  const bassG = ctx.createGain();
  bassG.gain.setValueAtTime(0.0001, bangT);
  bassG.gain.exponentialRampToValueAtTime(master * 1.15, bangT + 0.01);
  bassG.gain.exponentialRampToValueAtTime(0.0001, bangT + 0.3);
  bass.connect(bassG);
  bassG.connect(ctx.destination);
  bass.start(bangT);
  bass.stop(bangT + 0.35);

  const bSrc = ctx.createBufferSource();
  bSrc.buffer = noiseBuffer(ctx, 0.25);
  const bFilter = ctx.createBiquadFilter();
  bFilter.type = "lowpass";
  bFilter.frequency.value = 3000;
  const bNoiseG = ctx.createGain();
  decay(bNoiseG, bangT, master * 0.7, 0.25);
  bSrc.connect(bFilter);
  bFilter.connect(bNoiseG);
  bNoiseG.connect(ctx.destination);
  bSrc.start(bangT);
  bSrc.stop(bangT + 0.3);
}

/** Warble Rocket — vibrato-modulated whistle rising 500→1800Hz over
 *  700ms (6Hz LFO adds ±40Hz wobble), then a bright pop. That
 *  characteristic old-film-reel "warble" firework sound — playful,
 *  slightly cartoonish. ~900ms.
 *
 *  Vibrato pattern: base pitch is scheduled with
 *  exponentialRampToValueAtTime; a 6Hz LFO is routed through a
 *  gain node to `osc.frequency` and ADDS to the base (Web Audio
 *  routing convention). The vibrato depth is ±40Hz, subtle enough
 *  not to sound sea-sick but loud enough to read as wobble. */
function synthWarbleRocket(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("cracker");

  // Base carrier: exponential rise 500 → 1800Hz
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(500, now);
  osc.frequency.exponentialRampToValueAtTime(1800, now + 0.7);

  // LFO for the vibrato: 6Hz sine at ±40Hz depth
  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 6;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 40;
  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(master * 0.3, now + 0.05);
  g.gain.setValueAtTime(master * 0.3, now + 0.65);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.72);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.75);
  lfo.start(now);
  lfo.stop(now + 0.75);

  // Bright pop at peak
  const popT = now + 0.7;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 0.15);
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 3800;
  filter.Q.value = 1.0;
  const popG = ctx.createGain();
  decay(popG, popT, master * 0.65, 0.14);
  src.connect(filter);
  filter.connect(popG);
  popG.connect(ctx.destination);
  src.start(popT);
  src.stop(popT + 0.18);
}

/** Whistle & Chain — whistle rise (700ms, 400→2000Hz) triggers a
 *  chain of 4 rapid pops at ascending pitches. Feels like the
 *  whistle unlocks a firecracker string that then rips through.
 *  ~1300ms total. */
function synthWhistleChain(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("cracker");

  // Whistle rise
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(400, now);
  osc.frequency.exponentialRampToValueAtTime(2000, now + 0.7);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(master * 0.3, now + 0.05);
  g.gain.setValueAtTime(master * 0.3, now + 0.65);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.72);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.75);

  // Chain of 4 pops at t=0.7, 0.82, 0.95, 1.10 (accelerating)
  const chainStart = now + 0.7;
  const pops = [
    { at: 0.0, freq: 900 },
    { at: 0.12, freq: 1200 },
    { at: 0.25, freq: 1500 },
    { at: 0.4, freq: 1800 },
  ];
  for (const p of pops) {
    const t = chainStart + p.at;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 0.12);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = p.freq;
    filter.Q.value = 1.5;
    const popG = ctx.createGain();
    decay(popG, t, master * 0.55, 0.1);
    src.connect(filter);
    filter.connect(popG);
    popG.connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.13);

    // Bright sting on each pop for extra sparkle
    const sting = ctx.createOscillator();
    sting.type = "sine";
    sting.frequency.setValueAtTime(p.freq * 1.4, t);
    const stingG = ctx.createGain();
    decay(stingG, t, master * 0.25, 0.06);
    sting.connect(stingG);
    stingG.connect(ctx.destination);
    sting.start(t);
    sting.stop(t + 0.08);
  }
}

/** Bottle Rocket Chain — three sequential whistle+pop pairs at
 *  ascending pitches. Each rocket's whistle sweeps up over 350ms
 *  and pops at its peak, next one launches ~100ms later. Feels
 *  like a chain of bottle rockets going off in sequence.
 *  ~1400ms total. */
function synthBottleRocketChain(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("cracker");

  const rockets = [
    { at: 0.0, fromFreq: 300, toFreq: 1400 },
    { at: 0.45, fromFreq: 500, toFreq: 1800 },
    { at: 0.9, fromFreq: 700, toFreq: 2200 },
  ];
  for (const r of rockets) {
    const startT = now + r.at;
    // Whistle segment
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(r.fromFreq, startT);
    osc.frequency.exponentialRampToValueAtTime(r.toFreq, startT + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, startT);
    g.gain.exponentialRampToValueAtTime(master * 0.22, startT + 0.03);
    g.gain.setValueAtTime(master * 0.22, startT + 0.32);
    g.gain.exponentialRampToValueAtTime(0.0001, startT + 0.38);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(startT);
    osc.stop(startT + 0.4);

    // Pop at whistle peak — bandpass tuned above the whistle's top
    // freq so each rocket ends on a distinctly higher note
    const popT = startT + 0.35;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 0.1);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = r.toFreq * 1.4;
    filter.Q.value = 1.2;
    const popG = ctx.createGain();
    decay(popG, popT, master * 0.55, 0.08);
    src.connect(filter);
    filter.connect(popG);
    popG.connect(ctx.destination);
    src.start(popT);
    src.stop(popT + 0.12);
  }
}

/** Champagne Cork — muted low "thok" + long fizzy pink-noise hiss.
 *  Cork release + bubbles. ~1400ms. */
function synthChampagneCork(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("cracker");

  // Thok: resonant sine 180→80Hz, 100ms decay
  const thok = ctx.createOscillator();
  thok.type = "sine";
  thok.frequency.setValueAtTime(180, now);
  thok.frequency.exponentialRampToValueAtTime(80, now + 0.1);
  const thokG = ctx.createGain();
  decay(thokG, now, master * 0.9, 0.1);
  thok.connect(thokG);
  thokG.connect(ctx.destination);
  thok.start(now);
  thok.stop(now + 0.12);

  // Fizz: lowpassed noise (feels warmer than pure white noise),
  // slow decay across 1.3s
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 1.3);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 4000;
  filter.Q.value = 0.7;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(master * 0.25, now + 0.08);
  g.gain.setValueAtTime(master * 0.25, now + 0.15);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 1.3);
  src.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  src.start(now + 0.05);
  src.stop(now + 1.4);
}

/** Party Cannon — deep sub-bass thump + rising three-note bell
 *  shimmer (G6-B6-E7). The "boom + confetti sparkle" combo — the
 *  DEFAULT variant because it hits the widest audience and pairs
 *  most naturally with a multi-color confetti Lottie. ~800ms. */
function synthPartyCannon(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("cracker");

  // Thump: 100→40Hz sine, 300ms
  const thump = ctx.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(100, now);
  thump.frequency.exponentialRampToValueAtTime(40, now + 0.3);
  const thumpG = ctx.createGain();
  decay(thumpG, now, master * 1.0, 0.3);
  thump.connect(thumpG);
  thumpG.connect(ctx.destination);
  thump.start(now);
  thump.stop(now + 0.32);

  // Shimmer: three chime notes staggered — major triad ascending
  const chimes = [
    { freq: 1568, at: 0.05, dur: 0.4 }, // G6
    { freq: 1975, at: 0.12, dur: 0.4 }, // B6
    { freq: 2637, at: 0.2, dur: 0.5 }, // E7
  ];
  for (const c of chimes) {
    scheduleNote(ctx, now + c.at, {
      freq: c.freq,
      volume: master * 0.4,
      dur: c.dur,
    });
  }
}

/** Firework Cascade — four staggered pops with ascending pitch.
 *  Rapid-fire chain of small fireworks. ~600ms. */
function synthFireworkCascade(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("cracker");

  const pops = [
    { at: 0.0, freq: 800 },
    { at: 0.12, freq: 1100 },
    { at: 0.28, freq: 1400 },
    { at: 0.48, freq: 1700 },
  ];
  for (const p of pops) {
    const t = now + p.at;
    // Pop body: bandpass noise burst
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 0.15);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = p.freq;
    filter.Q.value = 1.5;
    const g = ctx.createGain();
    decay(g, t, master * 0.65, 0.12);
    src.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.15);

    // Sting: sine at 1.5× the pop's pitch, quick decay
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(p.freq * 1.5, t);
    const stingG = ctx.createGain();
    decay(stingG, t, master * 0.28, 0.08);
    osc.connect(stingG);
    stingG.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.09);
  }
}

/** Cinema Boom — sub-bass drop (30→120→35Hz) + broadband impact.
 *  Trailer-style. Absolutely thumps on decent speakers, may feel
 *  thin on phone speakers with weak bass response. ~900ms. */
function synthCinemaBoom(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("cracker");

  const bass = ctx.createOscillator();
  bass.type = "sine";
  bass.frequency.setValueAtTime(30, now);
  bass.frequency.exponentialRampToValueAtTime(120, now + 0.3);
  bass.frequency.exponentialRampToValueAtTime(35, now + 0.9);
  const bassG = ctx.createGain();
  bassG.gain.setValueAtTime(0.0001, now);
  bassG.gain.exponentialRampToValueAtTime(master * 1.2, now + 0.25);
  bassG.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
  bass.connect(bassG);
  bassG.connect(ctx.destination);
  bass.start(now);
  bass.stop(now + 0.95);

  // Impact at t=0.3: lowpassed broadband noise
  const impactT = now + 0.3;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 0.25);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 3000;
  const impactG = ctx.createGain();
  decay(impactG, impactT, master * 0.6, 0.25);
  src.connect(filter);
  filter.connect(impactG);
  impactG.connect(ctx.destination);
  src.start(impactT);
  src.stop(impactT + 0.3);
}

/** Sparkler Sizzle — continuous highpass noise with a gentle
 *  swelling filter sweep. The evenly-hissing sparkler stick (not a
 *  firework). Longest variant at 2000ms; still fits inside the
 *  2670ms Lottie window. */
function synthSparklerSizzle(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("cracker");
  const dur = 2.0;

  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, dur);
  const filter = ctx.createBiquadFilter();
  filter.type = "highpass";
  filter.Q.value = 0.8;
  // Filter frequency modulates for shimmer variation — starts at 6kHz,
  // rises to 9kHz mid-way, settles back at 6.5kHz.
  filter.frequency.setValueAtTime(6000, now);
  filter.frequency.linearRampToValueAtTime(9000, now + 1.0);
  filter.frequency.linearRampToValueAtTime(6500, now + dur);

  const g = ctx.createGain();
  // Gentle swell: attack → peak → gradual decay
  g.gain.setValueAtTime(0.0001, now);
  g.gain.linearRampToValueAtTime(master * 0.4, now + 0.2);
  g.gain.linearRampToValueAtTime(master * 0.35, now + 1.5);
  g.gain.linearRampToValueAtTime(0.0001, now + dur);

  src.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  src.start(now);
  src.stop(now + dur + 0.05);
}

/** Success Chime — bright bell chord (C6 + E6 + G6, C-major triad)
 *  with a bandpass noise shimmer tail. Musical, unambiguously
 *  positive. ~900ms. */
function synthSuccessChime(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("cracker");

  // Bell chord: three sines at C6, E6, G6
  const notes = [
    { freq: 1046.5, vol: master * 0.5 }, // C6
    { freq: 1318.5, vol: master * 0.4 }, // E6
    { freq: 1568.0, vol: master * 0.35 }, // G6
  ];
  for (const n of notes) {
    scheduleNote(ctx, now, {
      freq: n.freq,
      volume: n.vol,
      dur: 0.7,
    });
  }

  // Shimmer tail: bandpass 6kHz noise starting 100ms after the chord
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 0.5);
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 6000;
  filter.Q.value = 2;
  const g = ctx.createGain();
  decay(g, now + 0.1, master * 0.15, 0.5);
  src.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  src.start(now + 0.1);
  src.stop(now + 0.65);
}

/** Fanfare — three ascending sawtooth notes (C5-E5-G5) with a
 *  brass-like bandpass filter. The universal "achievement unlocked"
 *  musical phrase. ~800ms. */
function synthFanfare(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = defaultVolume("cracker");

  const notes = [
    { freq: 523.25, at: 0.0, dur: 0.35 }, // C5
    { freq: 659.25, at: 0.18, dur: 0.35 }, // E5
    { freq: 783.99, at: 0.36, dur: 0.55 }, // G5
  ];
  for (const n of notes) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(n.freq, now + n.at);
    // Bandpass filter around 2kHz gives sawtooths a brass-like
    // formant, warmer than a raw sawtooth's harsh top end.
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 2000;
    filter.Q.value = 1.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now + n.at);
    g.gain.exponentialRampToValueAtTime(master * 0.35, now + n.at + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, now + n.at + n.dur);
    osc.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);
    osc.start(now + n.at);
    osc.stop(now + n.at + n.dur + 0.05);
  }
}

/** Registry keyed by ID. Insertion order = display order in the
 *  /studio/sounds picker UI. Whistle→burst family is listed first
 *  (7 variants) because that's the sky-cracker archetype the user
 *  landed on for the video recording aesthetic. Other flavours
 *  follow for contrast. */
const CRACKER_VARIANTS: Record<
  CrackerVariantId,
  CrackerVariantMeta & { synth: (ctx: Ctx) => void }
> = {
  // ── Whistle → burst family (7) ────────────────────────────
  rocket_whistle: {
    id: "rocket_whistle",
    name: "Rocket Whistle",
    description:
      "Rising sine sweep (400→2200Hz) capped with a bright noise pop. Bottle-rocket \"PSSSHHH… POP!\". The default.",
    synth: synthRocketWhistle,
  },
  whistle_bomb: {
    id: "whistle_bomb",
    name: "Whistle Bomb",
    description:
      "Whistle (375ms, 400→1600Hz) → BIG sub-bass boom. Shooting-star Diwali rocket with real payload.",
    synth: synthWhistleBomb,
  },
  screamer: {
    id: "screamer",
    name: "Screamer",
    description:
      "Fast wild rise (600ms, 200→3500Hz) with a sharp bright pop + high-freq sting. Chaotic screamer-firework vibe.",
    synth: synthScreamer,
  },
  fuse_bang: {
    id: "fuse_bang",
    name: "Fuse & Bang",
    description:
      "Sputtering noise fuse (700ms) then a sudden bomb burst. Cartoon TNT-with-lit-fuse.",
    synth: synthFuseBang,
  },
  warble_rocket: {
    id: "warble_rocket",
    name: "Warble Rocket",
    description:
      "Vibrato-modulated whistle (6Hz wobble, 500→1800Hz) + bright pop. Old-film-reel firework vibe.",
    synth: synthWarbleRocket,
  },
  whistle_chain: {
    id: "whistle_chain",
    name: "Whistle & Chain",
    description:
      "Whistle rise then a chain of 4 rapid ascending pops. Whistle unlocks a firecracker string.",
    synth: synthWhistleChain,
  },
  bottle_rocket_chain: {
    id: "bottle_rocket_chain",
    name: "Bottle Rocket Chain",
    description:
      "Three sequential whistle+pop pairs at ascending pitches. Chain of bottle rockets going off in sequence.",
    synth: synthBottleRocketChain,
  },
  // ── Other flavours (9) ────────────────────────────────────
  party_cannon: {
    id: "party_cannon",
    name: "Party Cannon",
    description:
      "Deep thump + ascending three-bell shimmer. Safe match for a multi-color confetti Lottie.",
    synth: synthPartyCannon,
  },
  firework_cascade: {
    id: "firework_cascade",
    name: "Firework Cascade",
    description:
      "Four staggered pops with ascending pitch. Rapid chain of small fireworks (no whistle).",
    synth: synthFireworkCascade,
  },
  diwali_bomb: {
    id: "diwali_bomb",
    name: "Diwali Bomb",
    description:
      "Cinematic firework — sub-bass boom followed by 1.2s of randomised highpass crackle.",
    synth: synthDiwaliBomb,
  },
  classic_pop: {
    id: "classic_pop",
    name: "Classic Pop",
    description:
      "Sharp party-popper crack. Square-wave chirp + short bandpass noise tail.",
    synth: synthClassicPop,
  },
  champagne_cork: {
    id: "champagne_cork",
    name: "Champagne Cork",
    description: "Muted thok + long fizzy hiss. Cork release and bubbles.",
    synth: synthChampagneCork,
  },
  cinema_boom: {
    id: "cinema_boom",
    name: "Cinema Boom",
    description:
      "Trailer-style sub-bass drop + broadband impact. Best on speakers with decent low end.",
    synth: synthCinemaBoom,
  },
  sparkler_sizzle: {
    id: "sparkler_sizzle",
    name: "Sparkler Sizzle",
    description:
      "Continuous highpass hiss with a gentle swell. The sparkler stick, not a firework.",
    synth: synthSparklerSizzle,
  },
  success_chime: {
    id: "success_chime",
    name: "Success Chime",
    description:
      "Bright C-major bell chord + shimmer tail. Musical, clean, unambiguously positive.",
    synth: synthSuccessChime,
  },
  fanfare: {
    id: "fanfare",
    name: "Fanfare",
    description:
      "Three ascending brass-filtered sawtooth notes. Achievement-unlocked musical phrase.",
    synth: synthFanfare,
  },
};

/** Ordered list for iteration in the picker UI. */
export const CRACKER_VARIANT_LIST: readonly CrackerVariantMeta[] =
  Object.values(CRACKER_VARIANTS).map(({ id, name, description }) => ({
    id,
    name,
    description,
  }));

// ── SWOOSH ───────────────────────────────────────────────────────
// Aligned to chart line-draw. Filtered noise sweep from low to high
// frequency, with a NATURAL decay envelope across the full duration
// — no plateau. The visual and audio finish together, and there's
// no sustained "hold" that reads as the swoosh being stuck.
//
// COUPLING NOTE
// ─────────────
// Duration is hardcoded to match STUDIO_TIMING.CHART_DURATION
// (currently 1700ms in components/studio/RevealDashboard.tsx).
// Importing that constant from a React component into a pure lib
// module would create a bad dependency shape (lib depending on
// components). Kept as a hardcoded number with a comment; keep the
// two in sync manually — if you change CHART_DURATION, update
// SWOOSH_DURATION here too. In practice these change together
// during animation tuning.
const SWOOSH_DURATION = 1.7;

function synthSwoosh(ctx: Ctx): void {
  const now = ctx.currentTime;
  const dur = SWOOSH_DURATION;

  const bufferSize = Math.floor(ctx.sampleRate * dur);
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buffer;

  // Bandpass sweep — filter frequency rises smoothly across the
  // full duration, giving the "rising" character. Q kept modest
  // so the sweep is heard as movement, not a resonance sting.
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 1.4;
  filter.frequency.setValueAtTime(200, now);
  filter.frequency.exponentialRampToValueAtTime(3200, now + dur);

  // Envelope — LINEAR ramps to keep audibility present across the
  // full 1700ms so the swoosh actually accompanies the chart draw.
  //
  // Previous iteration used exponentialRampToValueAtTime for the
  // decay: on paper the buffer played for 1700ms, but the exp curve
  // decays fast-then-slow, so by t≈500ms the amplitude was already
  // at ~1.5% of peak and inaudible for the remaining ~1.2s. Result:
  // the swoosh "ended early" from the listener's perspective even
  // though the sample was still playing.
  //
  // Linear ramps stay audible throughout — at the midpoint of the
  // taper the gain is still ~70% of peak, so the swoosh is genuinely
  // present as the curve continues drawing. A quick 120ms fade at
  // the very end lands the sound with the chart's final draw frame.
  const gain = ctx.createGain();
  const peak = defaultVolume("swoosh") * 1.15;
  gain.gain.setValueAtTime(0.0001, now);
  // Attack — 80ms linear rise to peak.
  gain.gain.linearRampToValueAtTime(peak, now + 0.08);
  // Sustain-decay — slow LINEAR taper from peak to 40% of peak
  // across the middle ~1500ms of the sound. Feels like "still there,
  // gradually settling" throughout the chart draw.
  gain.gain.linearRampToValueAtTime(peak * 0.4, now + dur - 0.12);
  // Release — final 120ms fade to silence, landing with the last
  // frame of the chart draw.
  gain.gain.linearRampToValueAtTime(0, now + dur);

  src.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);

  src.start(now);
  src.stop(now + dur + 0.05);
}

// ── VERDICT ──────────────────────────────────────────────────────
// Sign-tiered reactive coda that lands after the last stats tile
// settles. Fires exactly once per reveal cycle, calibrated to the
// 1D change tier:
//
//   • big-green (>+1%)  → 6-note ascending C-major over 3 octaves
//                          (celebratory chime, ~1.15s)
//   • green      (>0)   → 3-note C-major arpeggio (bell cheer,
//                          ~0.5s)
//   • flat  (|Δ|~0)     → silence
//   • red        (<0)   → 5-note descending D-minor with passing
//                          tone (weighted ack, ~1.30s)
//
// Design intent — "celebrate wins loudly, acknowledge losses
// gently, ignore noise". Verdict is a coda, not a headline event:
// the rollup ding at ~4030ms is the primary audio climax; verdict
// arrives at ~5500ms as a small "the app has an opinion on your
// day" moment. Master gains are 0.11-0.17 (quieter than the ding's
// 0.22) so the verdict feels like a coda rather than another beat.
//
// The red tier deliberately avoids anything punitive — markets are
// red ~40% of days, so a punishing sound would train a small
// daily flinch. Descending D-minor with a lowpass softener is
// quiet acknowledgement, not consolation. All losses share the
// same tier now (no big-red split): three iterations of trying to
// scale small-loss vs big-loss reactions kept pushing the small
// one toward the big one, so the tier collapsed. Wins still scale
// though — big-green vs green stays split.

/** Classification of the day's 1D move for verdict-sound selection.
 *  Ordered from most-celebratory to most-somber; "flat" is
 *  deliberately silent (no false verdict on rounding-noise days).
 *
 *  Note: this is a 4-tier taxonomy. An earlier V1 iteration had
 *  a 5th "big-red" tier for large losses; it was collapsed into
 *  the single "red" tier after calibration sessions on
 *  /studio/verdict. */
export type VerdictTier = "big-green" | "green" | "flat" | "red";

/** Classify a 1D move into a verdict tier. Combines an INR floor
 *  (|Δ| < ₹1 = flat, blocks the "+₹0" edge case caused by rounding)
 *  with a percentage floor (|%| < 0.05% is treated as noise) and a
 *  percentage ceiling (|%| ≥ 1% is a "big" GAIN). Percentage wins
 *  when the two disagree so a small-portfolio big-swing gain day
 *  (e.g. ₹1L portfolio, +₹1200 = +1.2%) still triggers the
 *  big-green celebration, while a huge-portfolio small-tick day
 *  (₹10Cr, +₹5000 = +0.005%) stays classified as flat. Nullable
 *  inputs degrade to `flat` — no verdict is safer than a wrong one.
 *
 *  Losses always classify as `red` regardless of magnitude —
 *  there's no big-red anymore. */
export function resolveVerdictTier(
  oneDayInr: number | null | undefined,
  oneDayPct: number | null | undefined
): VerdictTier {
  if (oneDayInr == null || Math.abs(oneDayInr) < 1) return "flat";
  const absPct = oneDayPct != null ? Math.abs(oneDayPct) : 0;
  if (absPct > 0 && absPct < 0.0005) return "flat";
  if (oneDayInr < 0) return "red";
  return absPct >= 0.01 ? "big-green" : "green";
}

/** Green — 3-note C-major arpeggio (C5, E5, G5) on sine + octave
 *  overtone bell timbre. ~500ms total. Master gain 0.14, tuned to
 *  sit ~35% quieter than the rollup ding so it lands as a coda
 *  rather than a competing headline sound.
 *
 *  Character intentionally compact: a small daily win is a "small
 *  yes", not a fanfare. The green tile's visual duration (1.5s)
 *  is longer than the audio — the ~1s of silent visual tail lets
 *  the halo pulse land as a coda without acoustic interference. */
function synthChimeUp(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.14;
  const notes: Array<{ freq: number; at: number; dur: number }> = [
    { freq: 523.25, at: 0.0, dur: 0.42 }, // C5
    { freq: 659.25, at: 0.08, dur: 0.42 }, // E5
    { freq: 783.99, at: 0.16, dur: 0.5 }, // G5
  ];
  for (const n of notes) {
    scheduleNote(ctx, now + n.at, {
      freq: n.freq,
      volume: master,
      dur: n.dur,
    });
    // Octave overtone at 0.3× volume — adds bell shimmer without
    // making the tile feel too bright/toy-like.
    scheduleNote(ctx, now + n.at, {
      freq: n.freq * 2,
      volume: master * 0.3,
      dur: n.dur * 0.6,
    });
  }
}

/** Big-green — 6-note ascending C-major over 3 octaves
 *  (C5, E5, G5, C6, E6, G6). Extends the plain-green triad with
 *  three more notes climbing the octave above, so days above +1%
 *  get a triumphant finish without escalating to the full sky-
 *  cracker (which is reserved for the celebration Lottie at
 *  submit — this stays a coda). ~1.15s.
 *
 *  Volume master 0.16 (a hair below what a 4-note version could
 *  sustain, since the extra notes add perceptual density that
 *  would push a higher master into "too loud" territory). */
function synthChimeUpBig(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.16;
  const notes: Array<{ freq: number; at: number; dur: number }> = [
    { freq: 523.25, at: 0.0, dur: 0.5 }, // C5
    { freq: 659.25, at: 0.14, dur: 0.5 }, // E5
    { freq: 783.99, at: 0.28, dur: 0.5 }, // G5
    { freq: 1046.5, at: 0.42, dur: 0.5 }, // C6
    { freq: 1318.51, at: 0.58, dur: 0.5 }, // E6
    { freq: 1567.98, at: 0.72, dur: 0.65 }, // G6 (final landing)
  ];
  for (const n of notes) {
    scheduleNote(ctx, now + n.at, {
      freq: n.freq,
      volume: master,
      dur: n.dur,
    });
    // Octave overtone at 0.3× volume — bell shimmer. At E6/G6
    // the overtones (2637Hz/3136Hz) enter the bright range;
    // scheduleNote's envelope caps them so they don't peak
    // painfully.
    scheduleNote(ctx, now + n.at, {
      freq: n.freq * 2,
      volume: master * 0.3,
      dur: n.dur * 0.6,
    });
  }
}

/** Red — 5-note descending D-minor run (F5, D5, C5, Bb4, A4).
 *  F5 starts the fall from above; Bb4 is a passing tone between
 *  C5 and A4; A4 lands as the tonic-below.
 *
 *  Soft sine + 1600Hz lowpass keeps the timbre warm and muted —
 *  extending the melody must not amp the emotional weight, so
 *  softness stays. Master gain 0.12 (quiet by design; losses
 *  aren't shouted).
 *
 *  ~1.30s. Used for ANY negative-move day regardless of
 *  magnitude — the sole loss synth after the 4-tier collapse
 *  removed the old big-red split. */
function synthMinorDescend(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.12;
  const notes: Array<{ freq: number; at: number; dur: number }> = [
    { freq: 698.46, at: 0.0, dur: 0.4 }, // F5
    { freq: 587.33, at: 0.22, dur: 0.4 }, // D5
    { freq: 523.25, at: 0.44, dur: 0.4 }, // C5
    { freq: 466.16, at: 0.66, dur: 0.42 }, // Bb4 (passing tone)
    { freq: 440.0, at: 0.9, dur: 0.5 }, // A4 (tonic landing)
  ];
  for (const n of notes) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(n.freq, now + n.at);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now + n.at);
    g.gain.exponentialRampToValueAtTime(master, now + n.at + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, now + n.at + n.dur);
    osc.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);
    osc.start(now + n.at);
    osc.stop(now + n.at + n.dur + 0.02);
  }
}

// ── VERDICT VARIANT SYNTHS (green pairs) ─────────────────────────
//
// Each green variant defines TWO synth functions:
//   • synth<Name>Green    — compact chime for the `green` tier
//                            (small daily win, ~0.4-0.7s)
//   • synth<Name>BigGreen — extended chime for the `big-green`
//                            tier (+1% day or better, ~1.0-1.5s)
//
// Both fire off the same user selection (see VERDICT_GREEN_VARIANTS
// registry below). The variant defines a musical STYLE; the tier
// determines HOW MUCH of that style plays. Big-green is always a
// richer/longer version of the same variant, never a different
// style — so users only pick one green choice, not two.
//
// Design constraint: master gains 0.11-0.17. Verdict is a coda,
// not a headline event, so all variants stay quieter than the
// rollup ding (0.22). Big variants sit slightly louder than their
// small counterparts because the extra notes add perceptual
// density that needs headroom, but the ceiling stays 0.17.
//
// #1 major_bell: uses the existing synthChimeUp / synthChimeUpBig
// defined above. It's the default. All other #2-#18 are new below.

// ── #2 music_box ─────────────────────────────────────────────────
/** Music box — tinkling wound-spring feel. Pentatonic in the C6+
 *  register (higher than major_bell) so the timbre reads as
 *  delicate tinsel rather than solid bell. Sine + subtle vibrato
 *  via detuned second oscillator. */
function synthMusicBoxGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.13;
  const notes: Array<{ freq: number; at: number; dur: number }> = [
    { freq: 1046.5, at: 0.0, dur: 0.4 }, // C6
    { freq: 1318.51, at: 0.09, dur: 0.4 }, // E6
    { freq: 1567.98, at: 0.18, dur: 0.5 }, // G6
  ];
  for (const n of notes) {
    scheduleNote(ctx, now + n.at, { freq: n.freq, volume: master, dur: n.dur });
    scheduleNote(ctx, now + n.at, {
      freq: n.freq * 1.005, // slight detune for wound-spring shimmer
      volume: master * 0.4,
      dur: n.dur * 0.7,
    });
  }
}
function synthMusicBoxBigGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.15;
  const notes: Array<{ freq: number; at: number; dur: number }> = [
    { freq: 1046.5, at: 0.0, dur: 0.45 }, // C6
    { freq: 1318.51, at: 0.13, dur: 0.45 }, // E6
    { freq: 1567.98, at: 0.26, dur: 0.45 }, // G6
    { freq: 2093.0, at: 0.4, dur: 0.5 }, // C7
    { freq: 2637.02, at: 0.55, dur: 0.6 }, // E7 (bright landing)
  ];
  for (const n of notes) {
    scheduleNote(ctx, now + n.at, { freq: n.freq, volume: master, dur: n.dur });
    scheduleNote(ctx, now + n.at, {
      freq: n.freq * 1.005,
      volume: master * 0.4,
      dur: n.dur * 0.7,
    });
  }
}

// ── #3 marimba ───────────────────────────────────────────────────
/** Marimba — warm wooden mallet. Lower register (G4-D5) with
 *  strong 3rd harmonic and quick natural decay. Sine + triangle
 *  layer for the wooden body character. */
function synthMarimbaGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.15;
  const notes = [
    { freq: 392.0, at: 0.0, dur: 0.45 }, // G4
    { freq: 493.88, at: 0.1, dur: 0.45 }, // B4
    { freq: 587.33, at: 0.2, dur: 0.55 }, // D5
  ];
  for (const n of notes) {
    const t = now + n.at;
    // Fundamental (sine, main body)
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = n.freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(master, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
    // Third harmonic (triangle, adds wood character)
    const h = ctx.createOscillator();
    h.type = "triangle";
    h.frequency.value = n.freq * 3;
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0.0001, t);
    hg.gain.exponentialRampToValueAtTime(master * 0.15, t + 0.005);
    hg.gain.exponentialRampToValueAtTime(0.0001, t + n.dur * 0.5);
    h.connect(hg);
    hg.connect(ctx.destination);
    h.start(t);
    h.stop(t + n.dur * 0.5 + 0.02);
  }
}
function synthMarimbaBigGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.16;
  const notes = [
    { freq: 392.0, at: 0.0, dur: 0.45 }, // G4
    { freq: 493.88, at: 0.13, dur: 0.45 }, // B4
    { freq: 587.33, at: 0.26, dur: 0.45 }, // D5
    { freq: 783.99, at: 0.42, dur: 0.45 }, // G5
    { freq: 987.77, at: 0.58, dur: 0.6 }, // B5 (bright landing)
  ];
  for (const n of notes) {
    const t = now + n.at;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = n.freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(master, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
    const h = ctx.createOscillator();
    h.type = "triangle";
    h.frequency.value = n.freq * 3;
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0.0001, t);
    hg.gain.exponentialRampToValueAtTime(master * 0.15, t + 0.005);
    hg.gain.exponentialRampToValueAtTime(0.0001, t + n.dur * 0.5);
    h.connect(hg);
    hg.connect(ctx.destination);
    h.start(t);
    h.stop(t + n.dur * 0.5 + 0.02);
  }
}

// ── #4 xylophone ─────────────────────────────────────────────────
/** Xylophone — hard-mallet metal bar. Triangle wave for the sharp
 *  hard-attack character, sine layer for pitched body, very short
 *  decay so each note reads as a distinct "ping". Higher register
 *  than marimba (C6+) for the classic xylophone brightness. */
function synthXylophoneGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.12;
  const notes = [
    { freq: 1046.5, at: 0.0, dur: 0.25 }, // C6
    { freq: 1318.51, at: 0.07, dur: 0.25 }, // E6
    { freq: 1567.98, at: 0.14, dur: 0.35 }, // G6
  ];
  for (const n of notes) {
    const t = now + n.at;
    for (const type of ["sine", "triangle"] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = n.freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(
        type === "sine" ? master : master * 0.35,
        t + 0.002
      );
      g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + n.dur + 0.02);
    }
  }
}
function synthXylophoneBigGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.14;
  const notes = [
    { freq: 1046.5, at: 0.0, dur: 0.22 },
    { freq: 1174.66, at: 0.1, dur: 0.22 }, // D6
    { freq: 1318.51, at: 0.2, dur: 0.22 },
    { freq: 1567.98, at: 0.32, dur: 0.22 },
    { freq: 1760.0, at: 0.44, dur: 0.22 }, // A6
    { freq: 2093.0, at: 0.56, dur: 0.4 }, // C7
  ];
  for (const n of notes) {
    const t = now + n.at;
    for (const type of ["sine", "triangle"] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = n.freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(
        type === "sine" ? master : master * 0.35,
        t + 0.002
      );
      g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + n.dur + 0.02);
    }
  }
}

// ── #5 kalimba ───────────────────────────────────────────────────
/** Kalimba — African thumb piano. Soft plucky attack with a tiny
 *  noise transient at the start (thumbnail flick against tine),
 *  sine body with gentle harmonic. Mid register. */
function synthKalimbaGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.14;
  const notes = [
    { freq: 659.25, at: 0.0, dur: 0.5 }, // E5
    { freq: 783.99, at: 0.09, dur: 0.5 }, // G5
    { freq: 987.77, at: 0.18, dur: 0.6 }, // B5
  ];
  for (const n of notes) {
    const t = now + n.at;
    // Noise transient (10ms) for thumbnail flick
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 1.5);
    const nf = ctx.createBiquadFilter();
    nf.type = "highpass";
    nf.frequency.value = n.freq;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(master * 0.25, t + 0.002);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
    src.connect(nf);
    nf.connect(ng);
    ng.connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.04);
    // Sine body + soft 2nd harmonic
    scheduleNote(ctx, t, { freq: n.freq, volume: master, dur: n.dur });
    scheduleNote(ctx, t, {
      freq: n.freq * 2,
      volume: master * 0.2,
      dur: n.dur * 0.5,
    });
  }
}
function synthKalimbaBigGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.15;
  const notes = [
    { freq: 659.25, at: 0.0, dur: 0.5 }, // E5
    { freq: 783.99, at: 0.12, dur: 0.5 }, // G5
    { freq: 987.77, at: 0.24, dur: 0.5 }, // B5
    { freq: 1318.51, at: 0.4, dur: 0.5 }, // E6
    { freq: 1567.98, at: 0.55, dur: 0.65 }, // G6 (landing)
  ];
  for (const n of notes) {
    const t = now + n.at;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 1.5);
    const nf = ctx.createBiquadFilter();
    nf.type = "highpass";
    nf.frequency.value = n.freq;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(master * 0.25, t + 0.002);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
    src.connect(nf);
    nf.connect(ng);
    ng.connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.04);
    scheduleNote(ctx, t, { freq: n.freq, volume: master, dur: n.dur });
    scheduleNote(ctx, t, {
      freq: n.freq * 2,
      volume: master * 0.2,
      dur: n.dur * 0.5,
    });
  }
}

// ── #6 wind_chime ────────────────────────────────────────────────
/** Wind chime — pentatonic C major (C, D, E, G, A) with random
 *  note order and slight timing jitter. Reads as breezy /
 *  serendipitous rather than composed. */
function synthWindChimeGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.12;
  const pool = [1046.5, 1174.66, 1318.51, 1567.98, 1760.0]; // C6-A6 pentatonic
  const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, 3);
  shuffled.forEach((freq, i) => {
    const at = i * 0.08 + Math.random() * 0.03; // 30ms jitter
    scheduleNote(ctx, now + at, { freq, volume: master, dur: 0.6 });
    scheduleNote(ctx, now + at, {
      freq: freq * 2,
      volume: master * 0.25,
      dur: 0.4,
    });
  });
}
function synthWindChimeBigGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.14;
  const pool = [1046.5, 1174.66, 1318.51, 1567.98, 1760.0, 2093.0]; // C6-C7 pentatonic
  // Big version uses 6 notes with more jitter for a fuller breeze
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  shuffled.forEach((freq, i) => {
    const at = i * 0.11 + Math.random() * 0.05;
    scheduleNote(ctx, now + at, { freq, volume: master, dur: 0.65 });
    scheduleNote(ctx, now + at, {
      freq: freq * 2,
      volume: master * 0.25,
      dur: 0.4,
    });
  });
}

// ── #7 glass_ping ────────────────────────────────────────────────
/** Glass ping — pure high sines with a shimmer noise transient.
 *  Ethereal, cold, crystalline. Very high register (G6+). */
function synthGlassPingGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.1;
  const notes = [
    { freq: 1567.98, at: 0.0, dur: 0.4 }, // G6
    { freq: 1975.53, at: 0.08, dur: 0.4 }, // B6
    { freq: 2349.32, at: 0.16, dur: 0.55 }, // D7
  ];
  for (const n of notes) {
    const t = now + n.at;
    // Shimmer noise (~15ms)
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 1.5);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = n.freq * 2;
    bp.Q.value = 3;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(master * 0.4, t + 0.002);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    src.connect(bp);
    bp.connect(ng);
    ng.connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.05);
    scheduleNote(ctx, t, { freq: n.freq, volume: master, dur: n.dur });
  }
}
function synthGlassPingBigGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.11;
  const notes = [
    { freq: 1567.98, at: 0.0, dur: 0.45 },
    { freq: 1975.53, at: 0.12, dur: 0.45 },
    { freq: 2349.32, at: 0.24, dur: 0.45 },
    { freq: 2793.83, at: 0.38, dur: 0.45 }, // F7
    { freq: 3135.96, at: 0.52, dur: 0.6 }, // G7 (piercing landing)
  ];
  for (const n of notes) {
    const t = now + n.at;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 1.5);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = n.freq * 2;
    bp.Q.value = 3;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(master * 0.4, t + 0.002);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    src.connect(bp);
    bp.connect(ng);
    ng.connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.05);
    scheduleNote(ctx, t, { freq: n.freq, volume: master, dur: n.dur });
  }
}

// ── #8 handpan ───────────────────────────────────────────────────
/** Handpan — warm hang drum. Low register (E4-B4), deep resonant
 *  sine with a subtle metallic ring (5th harmonic). Notes played
 *  slower than the mallet variants to let each note breathe. */
function synthHandpanGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.16;
  const notes = [
    { freq: 329.63, at: 0.0, dur: 0.7 }, // E4
    { freq: 440.0, at: 0.13, dur: 0.7 }, // A4
    { freq: 493.88, at: 0.26, dur: 0.85 }, // B4
  ];
  for (const n of notes) {
    scheduleNote(ctx, now + n.at, { freq: n.freq, volume: master, dur: n.dur });
    scheduleNote(ctx, now + n.at, {
      freq: n.freq * 5,
      volume: master * 0.08,
      dur: n.dur * 0.7,
    });
  }
}
function synthHandpanBigGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.17;
  const notes = [
    { freq: 329.63, at: 0.0, dur: 0.7 }, // E4
    { freq: 440.0, at: 0.15, dur: 0.7 }, // A4
    { freq: 493.88, at: 0.3, dur: 0.7 }, // B4
    { freq: 554.37, at: 0.48, dur: 0.7 }, // C#5
    { freq: 659.25, at: 0.66, dur: 0.9 }, // E5 (landing)
  ];
  for (const n of notes) {
    scheduleNote(ctx, now + n.at, { freq: n.freq, volume: master, dur: n.dur });
    scheduleNote(ctx, now + n.at, {
      freq: n.freq * 5,
      volume: master * 0.08,
      dur: n.dur * 0.7,
    });
  }
}

// ── #9 celesta ───────────────────────────────────────────────────
/** Celesta — Sugar Plum Fairy bells. Sine + strong 2× overtone
 *  layer for glassy metallic character. Bright and bell-like but
 *  softer than xylophone. G major arpeggio. */
function synthCelestaGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.13;
  const notes = [
    { freq: 783.99, at: 0.0, dur: 0.4 }, // G5
    { freq: 987.77, at: 0.08, dur: 0.4 }, // B5
    { freq: 1174.66, at: 0.16, dur: 0.5 }, // D6
  ];
  for (const n of notes) {
    scheduleNote(ctx, now + n.at, { freq: n.freq, volume: master, dur: n.dur });
    scheduleNote(ctx, now + n.at, {
      freq: n.freq * 2,
      volume: master * 0.5,
      dur: n.dur * 0.75,
    });
  }
}
function synthCelestaBigGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.14;
  const notes = [
    { freq: 783.99, at: 0.0, dur: 0.45 }, // G5
    { freq: 987.77, at: 0.12, dur: 0.45 }, // B5
    { freq: 1174.66, at: 0.24, dur: 0.45 }, // D6
    { freq: 1567.98, at: 0.4, dur: 0.45 }, // G6
    { freq: 1975.53, at: 0.55, dur: 0.6 }, // B6 (landing)
  ];
  for (const n of notes) {
    scheduleNote(ctx, now + n.at, { freq: n.freq, volume: master, dur: n.dur });
    scheduleNote(ctx, now + n.at, {
      freq: n.freq * 2,
      volume: master * 0.5,
      dur: n.dur * 0.75,
    });
  }
}

// ── #10 vibraphone ───────────────────────────────────────────────
/** Vibraphone — jazzy metallic with tremolo (LFO on gain). Sine
 *  fundamental + soft 2nd harmonic. F major arpeggio, mid register.
 *  Tremolo depth 20% at 5Hz — the signature vibraphone shimmer. */
function synthVibraphoneGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.14;
  const notes = [
    { freq: 698.46, at: 0.0, dur: 0.55 }, // F5
    { freq: 880.0, at: 0.1, dur: 0.55 }, // A5
    { freq: 1046.5, at: 0.2, dur: 0.7 }, // C6
  ];
  for (const n of notes) {
    const t = now + n.at;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = n.freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(master, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    // 5Hz tremolo LFO on gain — vibraphone signature
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = master * 0.2;
    lfo.connect(lfoGain);
    lfoGain.connect(g.gain);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
    lfo.start(t);
    lfo.stop(t + n.dur + 0.02);
  }
}
function synthVibraphoneBigGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.15;
  const notes = [
    { freq: 698.46, at: 0.0, dur: 0.55 }, // F5
    { freq: 880.0, at: 0.13, dur: 0.55 }, // A5
    { freq: 1046.5, at: 0.26, dur: 0.55 }, // C6
    { freq: 1396.91, at: 0.42, dur: 0.55 }, // F6
    { freq: 1760.0, at: 0.58, dur: 0.75 }, // A6 (landing)
  ];
  for (const n of notes) {
    const t = now + n.at;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = n.freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(master, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = master * 0.2;
    lfo.connect(lfoGain);
    lfoGain.connect(g.gain);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
    lfo.start(t);
    lfo.stop(t + n.dur + 0.02);
  }
}

// ── #11 sine_sparkle ─────────────────────────────────────────────
/** Sine sparkle — pure sine waves with a shimmer overtone at
 *  perfect fifth interval. A minor register for a slightly
 *  ambiguous / dreamy character (rather than the standard C major
 *  cheer). */
function synthSineSparkleGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.12;
  const notes = [
    { freq: 880.0, at: 0.0, dur: 0.5 }, // A5
    { freq: 1046.5, at: 0.09, dur: 0.5 }, // C6
    { freq: 1318.51, at: 0.18, dur: 0.65 }, // E6
  ];
  for (const n of notes) {
    scheduleNote(ctx, now + n.at, { freq: n.freq, volume: master, dur: n.dur });
    scheduleNote(ctx, now + n.at, {
      freq: n.freq * 1.5, // perfect fifth shimmer
      volume: master * 0.25,
      dur: n.dur * 0.7,
    });
  }
}
function synthSineSparkleBigGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.13;
  const notes = [
    { freq: 880.0, at: 0.0, dur: 0.5 }, // A5
    { freq: 1046.5, at: 0.13, dur: 0.5 }, // C6
    { freq: 1318.51, at: 0.26, dur: 0.5 }, // E6
    { freq: 1760.0, at: 0.42, dur: 0.5 }, // A6
    { freq: 2093.0, at: 0.58, dur: 0.65 }, // C7
  ];
  for (const n of notes) {
    scheduleNote(ctx, now + n.at, { freq: n.freq, volume: master, dur: n.dur });
    scheduleNote(ctx, now + n.at, {
      freq: n.freq * 1.5,
      volume: master * 0.25,
      dur: n.dur * 0.7,
    });
  }
}

// ── #12 chiptune ─────────────────────────────────────────────────
/** Chiptune — 8-bit square wave arpeggio. Iconic retro game feel.
 *  Slightly staccato with hard attacks. C major. */
function synthChiptuneGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.09;
  const notes = [
    { freq: 523.25, at: 0.0, dur: 0.08 }, // C5
    { freq: 659.25, at: 0.09, dur: 0.08 }, // E5
    { freq: 783.99, at: 0.18, dur: 0.2 }, // G5 (held)
  ];
  for (const n of notes) {
    const t = now + n.at;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = n.freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(master, t + 0.002);
    g.gain.setValueAtTime(master, t + n.dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
  }
}
function synthChiptuneBigGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.1;
  const notes = [
    { freq: 523.25, at: 0.0, dur: 0.07 },
    { freq: 659.25, at: 0.08, dur: 0.07 },
    { freq: 783.99, at: 0.16, dur: 0.07 },
    { freq: 1046.5, at: 0.24, dur: 0.07 },
    { freq: 1318.51, at: 0.32, dur: 0.07 },
    { freq: 1567.98, at: 0.4, dur: 0.35 }, // G6 held finale
  ];
  for (const n of notes) {
    const t = now + n.at;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = n.freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(master, t + 0.002);
    g.gain.setValueAtTime(master, t + n.dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
  }
}

// ── #13 coin_get ─────────────────────────────────────────────────
/** Coin get — classic Mario coin two-tone pip. B5 → E6 (rising
 *  perfect fourth). Very short (~250ms), staccato square wave. */
function synthCoinGetGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.1;
  const notes = [
    { freq: 987.77, at: 0.0, dur: 0.09 }, // B5
    { freq: 1318.51, at: 0.09, dur: 0.2 }, // E6 held
  ];
  for (const n of notes) {
    const t = now + n.at;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = n.freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(master, t + 0.002);
    g.gain.setValueAtTime(master, t + n.dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
  }
}
function synthCoinGetBigGreen(ctx: Ctx): void {
  // Double-pip: two full coin-get iterations back-to-back, second
  // one an octave higher for the "big win = bigger coin" feel.
  const now = ctx.currentTime;
  const master = 0.11;
  const notes = [
    { freq: 987.77, at: 0.0, dur: 0.09 }, // B5
    { freq: 1318.51, at: 0.09, dur: 0.18 }, // E6
    { freq: 1975.53, at: 0.32, dur: 0.09 }, // B6 (octave up)
    { freq: 2637.02, at: 0.41, dur: 0.28 }, // E7 held finale
  ];
  for (const n of notes) {
    const t = now + n.at;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = n.freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(master, t + 0.002);
    g.gain.setValueAtTime(master, t + n.dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
  }
}

// ── #14 level_up ─────────────────────────────────────────────────
/** Level up — fast RPG-style ascending trill. C major scale played
 *  as a rapid run (~40ms per note) with a held finale. Triangle
 *  wave for a mid-fidelity retro character (softer than chiptune). */
function synthLevelUpGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.11;
  const scale = [523.25, 587.33, 659.25, 698.46, 783.99]; // C5 D E F G
  scale.forEach((freq, i) => {
    const t = now + i * 0.045;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(master, t + 0.003);
    g.gain.exponentialRampToValueAtTime(
      0.0001,
      t + (i === scale.length - 1 ? 0.25 : 0.07)
    );
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + (i === scale.length - 1 ? 0.27 : 0.09));
  });
}
function synthLevelUpBigGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.12;
  const scale = [
    523.25, 587.33, 659.25, 698.46, 783.99, 880.0, 987.77, 1046.5,
  ]; // Full C major octave
  scale.forEach((freq, i) => {
    const t = now + i * 0.05;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(master, t + 0.003);
    g.gain.exponentialRampToValueAtTime(
      0.0001,
      t + (i === scale.length - 1 ? 0.4 : 0.08)
    );
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + (i === scale.length - 1 ? 0.42 : 0.1));
  });
}

// ── #15 notification ─────────────────────────────────────────────
/** Notification — modern iOS/Android-style two-tone chime. Sine
 *  fundamental + subtle 3rd harmonic. Higher note first (slight
 *  drop pattern for "here's something" rather than rising cheer).
 *  E5 → A4 (down a fifth). */
function synthNotificationGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.13;
  const notes = [
    { freq: 659.25, at: 0.0, dur: 0.35 }, // E5
    { freq: 880.0, at: 0.11, dur: 0.5 }, // A5 (up)
  ];
  for (const n of notes) {
    scheduleNote(ctx, now + n.at, { freq: n.freq, volume: master, dur: n.dur });
    scheduleNote(ctx, now + n.at, {
      freq: n.freq * 3,
      volume: master * 0.1,
      dur: n.dur * 0.5,
    });
  }
}
function synthNotificationBigGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.14;
  const notes = [
    { freq: 659.25, at: 0.0, dur: 0.35 }, // E5
    { freq: 880.0, at: 0.11, dur: 0.35 }, // A5
    { freq: 1318.51, at: 0.28, dur: 0.55 }, // E6 (octave landing)
  ];
  for (const n of notes) {
    scheduleNote(ctx, now + n.at, { freq: n.freq, volume: master, dur: n.dur });
    scheduleNote(ctx, now + n.at, {
      freq: n.freq * 3,
      volume: master * 0.1,
      dur: n.dur * 0.5,
    });
  }
}

// ── #16 trumpet_fanfare ──────────────────────────────────────────
/** Trumpet fanfare — brassy triumphant. Sawtooth with lowpass
 *  filter (softens the buzz), G major triad rising. Slower attack
 *  than the mallets for a "held" horn feel. */
function synthTrumpetFanfareGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.11;
  const notes = [
    { freq: 392.0, at: 0.0, dur: 0.35 }, // G4
    { freq: 523.25, at: 0.13, dur: 0.35 }, // C5
    { freq: 659.25, at: 0.26, dur: 0.5 }, // E5 held
  ];
  for (const n of notes) {
    const t = now + n.at;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = n.freq;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1800; // soften brass buzz
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(master, t + 0.02);
    g.gain.setValueAtTime(master, t + n.dur * 0.65);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    osc.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
  }
}
function synthTrumpetFanfareBigGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.12;
  const notes = [
    { freq: 392.0, at: 0.0, dur: 0.3 }, // G4
    { freq: 523.25, at: 0.12, dur: 0.3 }, // C5
    { freq: 659.25, at: 0.24, dur: 0.3 }, // E5
    { freq: 783.99, at: 0.36, dur: 0.3 }, // G5
    { freq: 1046.5, at: 0.5, dur: 0.6 }, // C6 held finale
  ];
  for (const n of notes) {
    const t = now + n.at;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = n.freq;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(master, t + 0.02);
    g.gain.setValueAtTime(master, t + n.dur * 0.65);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    osc.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
  }
}

// ── #17 steel_drum ───────────────────────────────────────────────
/** Steel drum — Caribbean warmth. Sine + 5th harmonic layer for
 *  the characteristic metallic ring. Slight pitch bend at attack
 *  gives the "struck metal" character. F major pentatonic. */
function synthSteelDrumGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.14;
  const notes = [
    { freq: 698.46, at: 0.0, dur: 0.45 }, // F5
    { freq: 880.0, at: 0.1, dur: 0.45 }, // A5
    { freq: 1046.5, at: 0.2, dur: 0.6 }, // C6
  ];
  for (const n of notes) {
    const t = now + n.at;
    // Fundamental with slight pitch dip at attack
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(n.freq * 1.03, t);
    osc.frequency.exponentialRampToValueAtTime(n.freq, t + 0.03);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(master, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
    // 5th harmonic (metallic ring)
    scheduleNote(ctx, t, {
      freq: n.freq * 5,
      volume: master * 0.12,
      dur: n.dur * 0.5,
    });
  }
}
function synthSteelDrumBigGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.15;
  const notes = [
    { freq: 698.46, at: 0.0, dur: 0.45 }, // F5
    { freq: 880.0, at: 0.13, dur: 0.45 }, // A5
    { freq: 1046.5, at: 0.26, dur: 0.45 }, // C6
    { freq: 1396.91, at: 0.42, dur: 0.45 }, // F6
    { freq: 1760.0, at: 0.56, dur: 0.6 }, // A6 (landing)
  ];
  for (const n of notes) {
    const t = now + n.at;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(n.freq * 1.03, t);
    osc.frequency.exponentialRampToValueAtTime(n.freq, t + 0.03);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(master, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
    scheduleNote(ctx, t, {
      freq: n.freq * 5,
      volume: master * 0.12,
      dur: n.dur * 0.5,
    });
  }
}

// ── #18 harp_gliss ───────────────────────────────────────────────
/** Harp glissando — fast rising scale with each note softly
 *  overlapping the next. Triangle wave for a plucked-string
 *  character. C major scale run. */
function synthHarpGlissGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.11;
  const scale = [523.25, 587.33, 659.25, 698.46, 783.99]; // C5-G5
  scale.forEach((freq, i) => {
    const t = now + i * 0.05;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(master, t + 0.005);
    g.gain.exponentialRampToValueAtTime(
      0.0001,
      t + (i === scale.length - 1 ? 0.55 : 0.25)
    );
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + (i === scale.length - 1 ? 0.57 : 0.27));
  });
}
function synthHarpGlissBigGreen(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.12;
  const scale = [
    523.25, 587.33, 659.25, 698.46, 783.99, 880.0, 987.77, 1046.5,
  ]; // Full octave
  scale.forEach((freq, i) => {
    const t = now + i * 0.06;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(master, t + 0.005);
    g.gain.exponentialRampToValueAtTime(
      0.0001,
      t + (i === scale.length - 1 ? 0.7 : 0.3)
    );
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + (i === scale.length - 1 ? 0.72 : 0.32));
  });
}

// ── VERDICT VARIANT SYNTHS (red) ─────────────────────────────────
//
// 17 additional red variants (plus synthMinorDescend above = 18
// total). Each is ONE synth function (red is single-tier — no
// small/big split). Design constraint from VerdictReactive
// docstring: nothing punitive. Every variant here has a warm,
// muted, quiet character; master gains sit 0.09-0.13. Differences
// are timbre and gesture, not intensity.

// ── #2 soft_bend ─────────────────────────────────────────────────
/** Soft bend — the shipped-day-one gentle A4 → G♯4 semitone bend
 *  with a lowpass softener. Non-punitive by design: acknowledges
 *  the loss without rubbing it in. ~450ms. */
function synthSoftBendRed(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.11;
  const dur = 0.45;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(440, now); // A4
  osc.frequency.exponentialRampToValueAtTime(415.3, now + 0.3); // G♯4
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1200;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(master, now + 0.05);
  g.gain.setValueAtTime(master, now + 0.22);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

// ── #3 doorbell_low ──────────────────────────────────────────────
/** Doorbell descending — the classic two-note doorbell pattern but
 *  reversed (high → low, not low → high). E5 → C5 major-third
 *  drop. Sine + soft 2nd harmonic. ~650ms. */
function synthDoorbellLowRed(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.11;
  const notes = [
    { freq: 659.25, at: 0.0, dur: 0.4 }, // E5
    { freq: 523.25, at: 0.3, dur: 0.55 }, // C5
  ];
  for (const n of notes) {
    scheduleNote(ctx, now + n.at, { freq: n.freq, volume: master, dur: n.dur });
    scheduleNote(ctx, now + n.at, {
      freq: n.freq * 2,
      volume: master * 0.2,
      dur: n.dur * 0.6,
    });
  }
}

// ── #4 reverse_chime ─────────────────────────────────────────────
/** Reverse chime — descending A-minor triad with an "inhaled"
 *  envelope (long slow attack, quick decay) reading as reversed.
 *  Sine + subtle high overtone. E5 → C5 → A4. ~900ms. */
function synthReverseChimeRed(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.1;
  const notes = [
    { freq: 659.25, at: 0.0, dur: 0.5 }, // E5
    { freq: 523.25, at: 0.25, dur: 0.5 }, // C5
    { freq: 440.0, at: 0.5, dur: 0.55 }, // A4
  ];
  for (const n of notes) {
    const t = now + n.at;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = n.freq;
    const g = ctx.createGain();
    // Reversed envelope: slow rise, quick fall
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(master, t + n.dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
  }
}

// ── #5 piano_minor ───────────────────────────────────────────────
/** Piano minor — D minor triad (D+F+A) struck simultaneously with
 *  piano-like sharp attack + long decay. Triangle + sine layer for
 *  the woody piano body. Held ~1.2s so the chord rings out. */
function synthPianoMinorRed(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.09;
  const chord = [293.66, 349.23, 440.0]; // D4 F4 A4
  for (const freq of chord) {
    // Triangle fundamental (piano body)
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(master, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 1.22);
    // Sine 2nd harmonic (brightness)
    const h = ctx.createOscillator();
    h.type = "sine";
    h.frequency.value = freq * 2;
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0.0001, now);
    hg.gain.exponentialRampToValueAtTime(master * 0.2, now + 0.005);
    hg.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    h.connect(hg);
    hg.connect(ctx.destination);
    h.start(now);
    h.stop(now + 0.52);
  }
}

// ── #6 music_box_minor ───────────────────────────────────────────
/** Music box in minor — slow, wound-down music box in A minor.
 *  Sine + slight detune + higher octave overtone. A5 → C6 → E6
 *  (rising minor triad, slower than green music_box). ~1s. */
function synthMusicBoxMinorRed(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.1;
  const notes = [
    { freq: 880.0, at: 0.0, dur: 0.45 }, // A5
    { freq: 1046.5, at: 0.28, dur: 0.45 }, // C6
    { freq: 1318.51, at: 0.56, dur: 0.55 }, // E6
  ];
  for (const n of notes) {
    scheduleNote(ctx, now + n.at, { freq: n.freq, volume: master, dur: n.dur });
    scheduleNote(ctx, now + n.at, {
      freq: n.freq * 1.005,
      volume: master * 0.3,
      dur: n.dur * 0.7,
    });
  }
}

// ── #7 detuned_bell ──────────────────────────────────────────────
/** Detuned bell — single bell strike with a wobbling overtone
 *  that's slightly out of tune. Sine at 440Hz + sine at 445Hz
 *  creates a slow ~5Hz beat frequency for the "off" character.
 *  Warm lowpass keeps it soft. ~1s. */
function synthDetunedBellRed(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.12;
  const dur = 1.0;
  for (const freq of [440, 445]) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(master, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }
}

// ── #8 bell_toll ─────────────────────────────────────────────────
/** Bell toll — single deep low bell with long decay. A3 (very
 *  low) with a soft 2nd harmonic. Reads as a distant tower bell.
 *  ~1.5s. */
function synthBellTollRed(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.13;
  const freq = 220; // A3
  const dur = 1.5;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(master, now + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
  // Soft 2nd harmonic for bell character
  scheduleNote(ctx, now, {
    freq: freq * 2,
    volume: master * 0.35,
    dur: dur * 0.5,
  });
  // Very quiet 3rd harmonic for shimmer
  scheduleNote(ctx, now, {
    freq: freq * 3,
    volume: master * 0.1,
    dur: dur * 0.3,
  });
}

// ── #9 low_thud ──────────────────────────────────────────────────
/** Low thud — a single soft muted thud. Very low sine (~110Hz)
 *  with a lowpass-filtered noise burst at the attack for the
 *  "muted" character. Reads as understated / defeated posture.
 *  ~500ms. */
function synthLowThudRed(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.15;
  const dur = 0.5;
  // Low sine body
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(140, now);
  osc.frequency.exponentialRampToValueAtTime(110, now + 0.15);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(master, now + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
  // Muted noise burst at attack
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 1.5);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 400;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, now);
  ng.gain.exponentialRampToValueAtTime(master * 0.5, now + 0.005);
  ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
  src.connect(lp);
  lp.connect(ng);
  ng.connect(ctx.destination);
  src.start(now);
  src.stop(now + 0.1);
}

// ── #10 cello_dip ────────────────────────────────────────────────
/** Cello dip — sustained low cello-like note that swells in and
 *  fades. Sawtooth + lowpass gives the bowed-string character. G3
 *  (below middle A) with slow attack and slow release. ~1.5s. */
function synthCelloDipRed(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.09;
  const dur = 1.5;
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = 196; // G3
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 900;
  filter.Q.value = 1.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.linearRampToValueAtTime(master, now + 0.4);
  g.gain.setValueAtTime(master, now + 0.9);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

// ── #11 muted_trombone ───────────────────────────────────────────
/** Muted trombone — the classic "wah wah wah" of comedic
 *  disappointment, but muted (not comedic — losing money isn't
 *  funny). Sawtooth + LFO on lowpass frequency creates the "wah",
 *  descending pitch adds the "sad slide down". ~1.3s. */
function synthMutedTromboneRed(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.11;
  const dur = 1.3;
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(349.23, now); // F4
  osc.frequency.exponentialRampToValueAtTime(261.63, now + dur * 0.8); // slide to C4
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 700;
  filter.Q.value = 3;
  // LFO on filter frequency creates the "wah" effect
  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 4; // 4Hz wah rate
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 300; // filter freq mod depth
  lfo.connect(lfoGain);
  lfoGain.connect(filter.frequency);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.linearRampToValueAtTime(master, now + 0.05);
  g.gain.setValueAtTime(master, now + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
  lfo.start(now);
  lfo.stop(now + dur + 0.02);
}

// ── #12 reed_sigh ────────────────────────────────────────────────
/** Reed sigh — clarinet-like reed with soft breath character.
 *  Triangle + subtle noise + gentle pitch descent D4 → C4. Reads
 *  as a small exhale. ~1s. */
function synthReedSighRed(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.11;
  const dur = 1.0;
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(293.66, now); // D4
  osc.frequency.exponentialRampToValueAtTime(261.63, now + dur * 0.7); // C4
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.linearRampToValueAtTime(master, now + 0.15);
  g.gain.setValueAtTime(master, now + 0.6);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
  // Subtle breath noise
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 1.5);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 800;
  bp.Q.value = 1;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, now);
  ng.gain.linearRampToValueAtTime(master * 0.15, now + 0.15);
  ng.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  src.connect(bp);
  bp.connect(ng);
  ng.connect(ctx.destination);
  src.start(now);
  src.stop(now + dur + 0.02);
}

// ── #13 sigh ─────────────────────────────────────────────────────
/** Sigh — breath-based, no oscillator. Bandpass-filtered noise
 *  swept from a higher band down to a lower band, with a subtle
 *  low sine tone underneath for pitched context. Reads as a soft
 *  human exhale. ~1s. */
function synthSighRed(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.11;
  const dur = 1.0;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 1.5);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(1200, now);
  bp.frequency.exponentialRampToValueAtTime(500, now + dur * 0.8);
  bp.Q.value = 2;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, now);
  ng.gain.linearRampToValueAtTime(master * 0.6, now + 0.1);
  ng.gain.setValueAtTime(master * 0.6, now + 0.5);
  ng.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  src.connect(bp);
  bp.connect(ng);
  ng.connect(ctx.destination);
  src.start(now);
  src.stop(now + dur + 0.02);
  // Subtle pitched sub for tonal grounding
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = 174.61; // F3
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, now);
  og.gain.linearRampToValueAtTime(master * 0.3, now + 0.15);
  og.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(og);
  og.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

// ── #14 rain_patter ──────────────────────────────────────────────
/** Rain patter — 5-6 short filtered-noise ticks (raindrops)
 *  layered over a very low sustained tone. Random timing, random
 *  pitch. Reads as gentle rain outside. ~1s. */
function synthRainPatterRed(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.1;
  const dur = 1.0;
  // Low sustained drone
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = 146.83; // D3
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, now);
  og.gain.linearRampToValueAtTime(master * 0.35, now + 0.15);
  og.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(og);
  og.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
  // 6 rain-drop ticks
  for (let i = 0; i < 6; i++) {
    const t = now + 0.05 + Math.random() * 0.8;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 1.5);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1500 + Math.random() * 1500; // 1.5-3kHz
    bp.Q.value = 5;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(master * 0.4, t + 0.003);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    src.connect(bp);
    bp.connect(ng);
    ng.connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.06);
  }
}

// ── #15 deflate ──────────────────────────────────────────────────
/** Deflate — a pitch-dropping noise release. Filtered noise +
 *  descending pitch of a subtle sine underneath. Reads as air
 *  slowly escaping (balloon deflating). ~1s. */
function synthDeflateRed(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.11;
  const dur = 1.0;
  // Noise (the "hiss" of escaping air) with lowpass sweep
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 1.5);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(2000, now);
  lp.frequency.exponentialRampToValueAtTime(300, now + dur);
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, now);
  ng.gain.linearRampToValueAtTime(master * 0.5, now + 0.05);
  ng.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  src.connect(lp);
  lp.connect(ng);
  ng.connect(ctx.destination);
  src.start(now);
  src.stop(now + dur + 0.02);
  // Descending pitched sine for tonal grounding
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(349.23, now); // F4
  osc.frequency.exponentialRampToValueAtTime(146.83, now + dur); // D3
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, now);
  og.gain.linearRampToValueAtTime(master * 0.4, now + 0.05);
  og.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(og);
  og.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

// ── #16 analog_fade ──────────────────────────────────────────────
/** Analog fade — a synth pad with a slowly-closing lowpass filter.
 *  Sawtooth + strong lowpass creates the "closing curtain" feel.
 *  D minor triad (D+F+A) held with the filter frequency dropping
 *  from 1500Hz to 300Hz over ~1.5s. */
function synthAnalogFadeRed(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.08;
  const dur = 1.5;
  const chord = [293.66, 349.23, 440.0]; // D4 F4 A4
  for (const freq of chord) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1500, now);
    filter.frequency.exponentialRampToValueAtTime(300, now + dur);
    filter.Q.value = 1.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(master, now + 0.15);
    g.gain.setValueAtTime(master, now + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }
}

// ── #17 coin_drop ────────────────────────────────────────────────
/** Coin drop — inverse of the green coin_get. Two-tone dropping
 *  (E6 → B5), staccato square wave, plus a subtle "roll to rest"
 *  fade at the end. ~450ms. */
function synthCoinDropRed(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.09;
  const notes = [
    { freq: 1318.51, at: 0.0, dur: 0.08 }, // E6
    { freq: 987.77, at: 0.09, dur: 0.28 }, // B5 held (settling)
  ];
  for (const n of notes) {
    const t = now + n.at;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = n.freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(master, t + 0.002);
    g.gain.setValueAtTime(master, t + n.dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
  }
  // Final "settle" ping (very quiet, very short)
  const t2 = now + 0.4;
  scheduleNote(ctx, t2, { freq: 880, volume: master * 0.4, dur: 0.06 });
}

// ── #18 minor_swell ──────────────────────────────────────────────
/** Minor swell — D minor triad that swells in slowly and fades.
 *  Sine + slight detune per note for a lush chorus effect. No
 *  attack transient (the swell is the character). ~1.5s. */
function synthMinorSwellRed(ctx: Ctx): void {
  const now = ctx.currentTime;
  const master = 0.09;
  const dur = 1.5;
  const chord = [293.66, 349.23, 440.0]; // D4 F4 A4
  for (const freq of chord) {
    for (const detune of [1.0, 1.007]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq * detune;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(master, now + dur * 0.5);
      g.gain.setValueAtTime(master, now + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + dur + 0.02);
    }
  }
}

// ── VERDICT VARIANT REGISTRIES ───────────────────────────────────
//
// Green variants: 18 entries, each with .synthGreen and
// .synthBigGreen pointers.
// Red variants: 18 entries, each with a single .synth pointer.
//
// The first entry in each registry is the default variant (the
// initial-shipped sound). If the user hasn't chosen a variant,
// getActiveVerdict*Variant() returns this default's ID.

export const VERDICT_GREEN_VARIANTS: Record<
  VerdictGreenVariantId,
  VerdictGreenVariantMeta & {
    synthGreen: (ctx: Ctx) => void;
    synthBigGreen: (ctx: Ctx) => void;
  }
> = {
  major_bell: {
    id: "major_bell",
    name: "Major Bell",
    description:
      "Bright C-major arpeggio bell chime (C-E-G small, C-E-G-C-E-G big across 3 octaves). Default.",
    synthGreen: synthChimeUp,
    synthBigGreen: synthChimeUpBig,
  },
  music_box: {
    id: "music_box",
    name: "Music Box",
    description:
      "Tinkling wound music box in the high register with a delicate wound-spring shimmer.",
    synthGreen: synthMusicBoxGreen,
    synthBigGreen: synthMusicBoxBigGreen,
  },
  marimba: {
    id: "marimba",
    name: "Marimba",
    description:
      "Warm wooden mallet in a mid-low register. Rich body with a soft harmonic overtone.",
    synthGreen: synthMarimbaGreen,
    synthBigGreen: synthMarimbaBigGreen,
  },
  xylophone: {
    id: "xylophone",
    name: "Xylophone",
    description:
      "Bright hard-mallet metal bars. Sharp attack, quick decay, glassy top-end.",
    synthGreen: synthXylophoneGreen,
    synthBigGreen: synthXylophoneBigGreen,
  },
  kalimba: {
    id: "kalimba",
    name: "Kalimba",
    description:
      "African thumb piano — soft plucky attack with a tiny thumbnail transient, warm sine body.",
    synthGreen: synthKalimbaGreen,
    synthBigGreen: synthKalimbaBigGreen,
  },
  wind_chime: {
    id: "wind_chime",
    name: "Wind Chime",
    description:
      "Pentatonic notes in a random order with slight timing jitter — breezy, serendipitous.",
    synthGreen: synthWindChimeGreen,
    synthBigGreen: synthWindChimeBigGreen,
  },
  glass_ping: {
    id: "glass_ping",
    name: "Glass Ping",
    description:
      "Very high pure sines with a shimmer transient. Ethereal, cold, crystalline.",
    synthGreen: synthGlassPingGreen,
    synthBigGreen: synthGlassPingBigGreen,
  },
  handpan: {
    id: "handpan",
    name: "Handpan",
    description:
      "Warm hang drum in a low register — deep resonant sine with a subtle metallic ring.",
    synthGreen: synthHandpanGreen,
    synthBigGreen: synthHandpanBigGreen,
  },
  celesta: {
    id: "celesta",
    name: "Celesta",
    description:
      "Sugar Plum Fairy bells — sine + strong 2× overtone for glassy metallic character. G major.",
    synthGreen: synthCelestaGreen,
    synthBigGreen: synthCelestaBigGreen,
  },
  vibraphone: {
    id: "vibraphone",
    name: "Vibraphone",
    description:
      "Jazzy metallic with a 5Hz tremolo shimmer on the gain envelope. F major.",
    synthGreen: synthVibraphoneGreen,
    synthBigGreen: synthVibraphoneBigGreen,
  },
  sine_sparkle: {
    id: "sine_sparkle",
    name: "Sine Sparkle",
    description:
      "Pure sine waves in A minor with a perfect-fifth shimmer overtone. Dreamy, ambiguous.",
    synthGreen: synthSineSparkleGreen,
    synthBigGreen: synthSineSparkleBigGreen,
  },
  chiptune: {
    id: "chiptune",
    name: "Chiptune",
    description:
      "8-bit square wave arpeggio. Iconic retro game feel — quick, staccato, unmistakable.",
    synthGreen: synthChiptuneGreen,
    synthBigGreen: synthChiptuneBigGreen,
  },
  coin_get: {
    id: "coin_get",
    name: "Coin Get",
    description:
      "Classic Mario coin two-tone pip (B5 → E6). Big version doubles up an octave higher.",
    synthGreen: synthCoinGetGreen,
    synthBigGreen: synthCoinGetBigGreen,
  },
  level_up: {
    id: "level_up",
    name: "Level Up",
    description:
      "Fast RPG-style ascending scale trill with a held finale. Triangle wave, mid-fi retro.",
    synthGreen: synthLevelUpGreen,
    synthBigGreen: synthLevelUpBigGreen,
  },
  notification: {
    id: "notification",
    name: "Notification",
    description:
      "Modern iOS/Android-style two-tone chime (E5 → A5). Big version adds an octave landing.",
    synthGreen: synthNotificationGreen,
    synthBigGreen: synthNotificationBigGreen,
  },
  trumpet_fanfare: {
    id: "trumpet_fanfare",
    name: "Trumpet Fanfare",
    description:
      "Brassy triumphant — sawtooth + lowpass for a softened horn feel. G major rising.",
    synthGreen: synthTrumpetFanfareGreen,
    synthBigGreen: synthTrumpetFanfareBigGreen,
  },
  steel_drum: {
    id: "steel_drum",
    name: "Steel Drum",
    description:
      "Caribbean warmth — sine + 5th harmonic for metallic ring. Slight pitch bend at attack.",
    synthGreen: synthSteelDrumGreen,
    synthBigGreen: synthSteelDrumBigGreen,
  },
  harp_gliss: {
    id: "harp_gliss",
    name: "Harp Glissando",
    description:
      "Fast rising scale with softly overlapping notes — plucked triangle character. C major.",
    synthGreen: synthHarpGlissGreen,
    synthBigGreen: synthHarpGlissBigGreen,
  },
};

/** Ordered list for /studio/sounds picker UI iteration. Insertion
 *  order defines the display order — keep the default at the top,
 *  then family groupings (bell/mallet, then synthetic, then wind/
 *  brass) for a discoverable browsing experience. */
export const VERDICT_GREEN_VARIANT_LIST: readonly VerdictGreenVariantMeta[] =
  Object.values(VERDICT_GREEN_VARIANTS).map(({ id, name, description }) => ({
    id,
    name,
    description,
  }));

export const VERDICT_RED_VARIANTS: Record<
  VerdictRedVariantId,
  VerdictRedVariantMeta & { synth: (ctx: Ctx) => void }
> = {
  minor_descent: {
    id: "minor_descent",
    name: "Minor Descent",
    description:
      "5-note D-minor descending run (F5-D5-C5-Bb4-A4) on soft sine + lowpass. Default.",
    synth: synthMinorDescend,
  },
  soft_bend: {
    id: "soft_bend",
    name: "Soft Bend",
    description:
      "Single sine tone gliding A4 → G♯4 (semitone bend) with a warm lowpass. Gentle, brief.",
    synth: synthSoftBendRed,
  },
  doorbell_low: {
    id: "doorbell_low",
    name: "Doorbell Descending",
    description:
      "Two-note doorbell pattern reversed — E5 → C5 major third drop. Warm, understated.",
    synth: synthDoorbellLowRed,
  },
  reverse_chime: {
    id: "reverse_chime",
    name: "Reverse Chime",
    description:
      "Descending A-minor triad with slow-attack / quick-decay envelopes for a reversed feel.",
    synth: synthReverseChimeRed,
  },
  piano_minor: {
    id: "piano_minor",
    name: "Piano Minor",
    description:
      "D-minor triad struck simultaneously — triangle body + sine harmonic. Rings out ~1.2s.",
    synth: synthPianoMinorRed,
  },
  music_box_minor: {
    id: "music_box_minor",
    name: "Music Box Minor",
    description:
      "Slow music box in A minor, wound down. Rising triad A5-C6-E6 with wound-spring shimmer.",
    synth: synthMusicBoxMinorRed,
  },
  detuned_bell: {
    id: "detuned_bell",
    name: "Detuned Bell",
    description:
      "Single sustained bell with a ~5Hz beat frequency (two slightly out-of-tune sines).",
    synth: synthDetunedBellRed,
  },
  bell_toll: {
    id: "bell_toll",
    name: "Bell Toll",
    description:
      "Single deep low tower bell (A3) with a long decay and soft harmonic overtones.",
    synth: synthBellTollRed,
  },
  low_thud: {
    id: "low_thud",
    name: "Low Thud",
    description:
      "Very low soft muted thud with a lowpass-filtered noise burst — understated, defeated.",
    synth: synthLowThudRed,
  },
  cello_dip: {
    id: "cello_dip",
    name: "Cello Dip",
    description:
      "Sustained bowed low note (G3) — sawtooth + lowpass, slow swell in and out. ~1.5s.",
    synth: synthCelloDipRed,
  },
  muted_trombone: {
    id: "muted_trombone",
    name: "Muted Trombone",
    description:
      'Softened "wah wah wah" — sawtooth with LFO on lowpass. Sad slide from F4 down to C4.',
    synth: synthMutedTromboneRed,
  },
  reed_sigh: {
    id: "reed_sigh",
    name: "Reed Sigh",
    description:
      "Clarinet-like reed — triangle + subtle breath noise. Gentle D4 → C4 descent, ~1s.",
    synth: synthReedSighRed,
  },
  sigh: {
    id: "sigh",
    name: "Sigh",
    description:
      "Bandpass-filtered noise swept downward + subtle low sine underneath. Human exhale.",
    synth: synthSighRed,
  },
  rain_patter: {
    id: "rain_patter",
    name: "Rain Patter",
    description:
      "6 random raindrop ticks (filtered noise) layered over a low sustained drone tone.",
    synth: synthRainPatterRed,
  },
  deflate: {
    id: "deflate",
    name: "Deflate",
    description:
      "Air-escaping hiss (lowpass-swept noise) + descending pitched sine. Balloon deflating.",
    synth: synthDeflateRed,
  },
  analog_fade: {
    id: "analog_fade",
    name: "Analog Fade",
    description:
      "Sawtooth D-minor triad with a lowpass closing from 1.5kHz to 300Hz — closing curtain.",
    synth: synthAnalogFadeRed,
  },
  coin_drop: {
    id: "coin_drop",
    name: "Coin Drop",
    description:
      "Inverse of coin-get — two-tone dropping (E6 → B5) square wave + a settle ping.",
    synth: synthCoinDropRed,
  },
  minor_swell: {
    id: "minor_swell",
    name: "Minor Swell",
    description:
      "D-minor triad swells in slowly and fades — chorus-detuned sines, no attack transient.",
    synth: synthMinorSwellRed,
  },
};

export const VERDICT_RED_VARIANT_LIST: readonly VerdictRedVariantMeta[] =
  Object.values(VERDICT_RED_VARIANTS).map(({ id, name, description }) => ({
    id,
    name,
    description,
  }));

// ── VERDICT VARIANT PREVIEW FUNCTIONS ─────────────────────────────
//
// Fire a specific variant WITHOUT changing the active selection.
// Used by /studio/sounds row-level Play buttons so the user can
// audition a variant before committing.
//
// Symmetric with playClickVariant / playRollupVariant / playCracker
// Variant — same signature (ID) and same fire-and-forget semantics.
// Green has TWO preview functions (small tier vs big tier) so the
// picker UI can offer both to the user; red has one.

/** Play a specific green variant's compact (small-win) synth
 *  without changing the active selection. */
export function playVerdictGreenVariant(id: VerdictGreenVariantId): void {
  if (typeof window === "undefined") return;
  if (!shouldPlay()) return;
  const variant = VERDICT_GREEN_VARIANTS[id];
  if (!variant) return;
  void unlockAudio().then(() => {
    if (!audioCtx) return;
    try {
      variant.synthGreen(audioCtx);
    } catch (err) {
      console.debug(`[studio.sounds] verdict-green ${id} synth failed`, err);
    }
  });
}

/** Play a specific green variant's extended (big-win) synth without
 *  changing the active selection. Same variant ID as
 *  playVerdictGreenVariant — the difference is which of the two
 *  paired synths in the registry gets called. */
export function playVerdictGreenBigVariant(id: VerdictGreenVariantId): void {
  if (typeof window === "undefined") return;
  if (!shouldPlay()) return;
  const variant = VERDICT_GREEN_VARIANTS[id];
  if (!variant) return;
  void unlockAudio().then(() => {
    if (!audioCtx) return;
    try {
      variant.synthBigGreen(audioCtx);
    } catch (err) {
      console.debug(`[studio.sounds] verdict-green-big ${id} synth failed`, err);
    }
  });
}

/** Play a specific red variant without changing the active
 *  selection. */
export function playVerdictRedVariant(id: VerdictRedVariantId): void {
  if (typeof window === "undefined") return;
  if (!shouldPlay()) return;
  const variant = VERDICT_RED_VARIANTS[id];
  if (!variant) return;
  void unlockAudio().then(() => {
    if (!audioCtx) return;
    try {
      variant.synth(audioCtx);
    } catch (err) {
      console.debug(`[studio.sounds] verdict-red ${id} synth failed`, err);
    }
  });
}

// ── DING ─────────────────────────────────────────────────────────

function synthDing(ctx: Ctx): void {
  const now = ctx.currentTime;
  const dur = 0.75;

  const notes: Array<{ freq: number; vol: number; decay: number }> = [
    { freq: 1046.5, vol: 0.6, decay: dur },
    { freq: 2093.0, vol: 0.35, decay: dur * 0.6 },
    { freq: 2637.0, vol: 0.25, decay: dur * 0.4 },
  ];

  const bus = ctx.createGain();
  bus.gain.value = defaultVolume("ding");

  const softener = ctx.createBiquadFilter();
  softener.type = "lowpass";
  softener.frequency.value = 4500;
  bus.connect(softener);
  softener.connect(ctx.destination);

  for (const n of notes) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(n.freq, now);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(n.vol, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + n.decay);
    osc.connect(g);
    g.connect(bus);
    osc.start(now);
    osc.stop(now + n.decay + 0.05);
  }
}

// ── Public API ───────────────────────────────────────────────────

if (typeof window !== "undefined") {
  startMp3Probe();
}

export function playClick(): void {
  void play("click");
}

export function playSwoosh(): void {
  void play("swoosh");
}

export function playDing(): void {
  void play("ding");
}

export function playRollup(): void {
  void play("rollup");
}

/**
 * Reveal-ceremony counter ASMR — always the duration-synced
 * slot_machine, ignoring the /studio/sounds lab selection.
 *
 * Why not playRollup()?
 * The lab lets you audition 15 variants; several are deliberately
 * short (~0.8–1.5s). If that preference leaked into the reveal,
 * the ticks would die while the Total Orders tile was still
 * rolling (or worse, with the chart pill). This helper keeps the
 * recording surface locked to the choreography in STUDIO_TIMING
 * regardless of what the tester last clicked in the sound lab.
 */
export function playRollupForReveal(): void {
  void playRollupVariant("slot_machine");
}

export function playCracker(): void {
  void play("cracker");
}

/** Play the verdict coda for the day's 1D move. Silent on flat
 *  days (resolveVerdictTier returns "flat"). Fire-and-forget —
 *  no return, no promise, no dedup: the caller in RevealDashboard
 *  guards against double-firing via its setTimeout lifecycle,
 *  and this module stays dumb about who's calling.
 *
 *  Not routed through the play() dispatcher because verdict is
 *  data-driven (tier from 1D move), not a fixed synth per name.
 *  Also, the verdict has TWO user-selectable variants (green +
 *  red) that get resolved per tier, so plumbing this through
 *  play(name) would need special-case handling anyway.
 *
 *  Variant resolution: `big-green` and `green` both look up the
 *  active green variant (via getActiveVerdictGreenVariant), then
 *  call its .synthGreen or .synthBigGreen respectively. `red`
 *  looks up the active red variant and calls its .synth. */
export function playVerdict(
  oneDayInr: number | null | undefined,
  oneDayPct: number | null | undefined
): void {
  if (typeof window === "undefined") return;
  if (!shouldPlay()) return;
  const tier = resolveVerdictTier(oneDayInr, oneDayPct);
  if (tier === "flat") return;
  void unlockAudio().then(() => {
    if (!audioCtx) return;
    try {
      switch (tier) {
        case "big-green": {
          const greenVariant = VERDICT_GREEN_VARIANTS[getActiveVerdictGreenVariant()];
          greenVariant.synthBigGreen(audioCtx);
          break;
        }
        case "green": {
          const greenVariant = VERDICT_GREEN_VARIANTS[getActiveVerdictGreenVariant()];
          greenVariant.synthGreen(audioCtx);
          break;
        }
        case "red": {
          const redVariant = VERDICT_RED_VARIANTS[getActiveVerdictRedVariant()];
          redVariant.synth(audioCtx);
          break;
        }
      }
    } catch (err) {
      console.debug("[studio.sounds] verdict synth failed", err);
    }
  });
}

