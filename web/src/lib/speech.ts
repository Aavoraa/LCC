"use client";

// Browser speech: voice commands in (Web Speech recognition) and read-aloud out (speech synthesis), in English or Tamil.
// Recognition works in Chrome, Edge and Android Chrome. A Tamil read-aloud voice ships with Edge (online voices),
// Android Chrome, and Windows once the Tamil speech pack is installed.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type Lang = "en" | "ta";
export const SPEECH_LANG: Record<Lang, string> = { en: "en-IN", ta: "ta-IN" };
export const LANG_KEY = "lm_voice_lang";

interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const RECOGNITION_ERRORS: Record<string, string> = {
  "not-allowed": "Microphone permission was denied. Allow the microphone for this site and try again.",
  "service-not-allowed": "Speech recognition is blocked in this browser. Use Chrome or Edge.",
  "no-speech": "No speech heard. Tap the microphone and speak again.",
  "audio-capture": "No microphone found.",
  network: "Speech recognition needs an internet connection.",
  "language-not-supported": "This browser cannot recognise the selected language. Use Chrome or Edge.",
};

/** Push-to-talk speech recognition. ``onFinal`` receives the recognised sentence. */
export function useSpeechInput(lang: Lang, onFinal: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<Recognition | null>(null);
  const cbRef = useRef(onFinal);
  cbRef.current = onFinal;

  useEffect(() => setSupported(!!recognitionCtor()), []);
  useEffect(() => () => recRef.current?.abort(), []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setError("Voice commands need Chrome or Edge. Type the command instead.");
      return;
    }
    recRef.current?.abort();
    stopSpeaking(); // keep the read-aloud voice out of the microphone
    const rec = new Ctor();
    rec.lang = SPEECH_LANG[lang];
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    let done = false;
    rec.onresult = (e) => {
      let text = "";
      let final = false;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        final = final || e.results[i].isFinal;
      }
      setInterim(text);
      if (final && !done && text.trim()) {
        done = true;
        cbRef.current(text.trim());
      }
    };
    rec.onerror = (e) => {
      if (e.error !== "aborted") setError(RECOGNITION_ERRORS[e.error] ?? `Speech recognition error: ${e.error}`);
    };
    rec.onend = () => setListening(false);
    setError(null);
    setInterim("");
    try {
      rec.start();
      recRef.current = rec;
      setListening(true);
    } catch (e) {
      setError((e as Error).message || "Could not start the microphone");
    }
  }, [lang]);

  const stop = useCallback(() => recRef.current?.stop(), []);
  return { supported, listening, interim, error, start, stop };
}

// ------------------------------------------------------------------ read aloud
function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

export function stopSpeaking() {
  synth()?.cancel();
}

function useVoices() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const s = synth();
    if (!s) return;
    const load = () => setVoices(s.getVoices());
    load();
    s.addEventListener("voiceschanged", load);
    return () => s.removeEventListener("voiceschanged", load);
  }, []);
  return voices;
}

/** Best installed voice for the language: exact locale first (en-IN / ta-IN), then any voice of that language;
 *  natural / online / Google voices preferred. */
function pickVoice(voices: SpeechSynthesisVoice[], lang: Lang): SpeechSynthesisVoice | undefined {
  const locale = SPEECH_LANG[lang].toLowerCase();
  const tag = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().replace("_", "-");
  const quality = (v: SpeechSynthesisVoice) => (/natural|online|google/i.test(v.name) ? 0 : 1);
  const exact = voices.filter((v) => tag(v) === locale).sort((a, b) => quality(a) - quality(b));
  if (exact.length) return exact[0];
  return voices.filter((v) => tag(v) === lang || tag(v).startsWith(`${lang}-`)).sort((a, b) => quality(a) - quality(b))[0];
}

/** Reads a list of sentences one after another, exposing which one is being read (to highlight report rows). */
export function useSpeaker(lang: Lang, rate = 1) {
  const voices = useVoices();
  const voice = useMemo(() => pickVoice(voices, lang), [voices, lang]);
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [index, setIndex] = useState(-1);
  const runRef = useRef(0);
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null); // held so Chrome does not drop onend

  useEffect(() => setSupported(!!synth()), []);
  useEffect(() => () => {
    runRef.current++;
    stopSpeaking();
  }, []);

  const stop = useCallback(() => {
    runRef.current++;
    stopSpeaking();
    setSpeaking(false);
    setPaused(false);
    setIndex(-1);
  }, []);

  const speak = useCallback((parts: string[]) => {
    const s = synth();
    if (!s || parts.length === 0) return;
    const run = ++runRef.current;
    s.cancel();
    setSpeaking(true);
    setPaused(false);
    const next = (i: number) => {
      if (run !== runRef.current) return;
      if (i >= parts.length) {
        setSpeaking(false);
        setIndex(-1);
        return;
      }
      setIndex(i);
      const u = new SpeechSynthesisUtterance(parts[i]);
      u.lang = SPEECH_LANG[lang];
      if (voice) u.voice = voice;
      u.rate = rate;
      u.onend = () => next(i + 1);
      u.onerror = (e) => {
        if (e.error !== "interrupted" && e.error !== "canceled") next(i + 1);
      };
      utterRef.current = u;
      s.speak(u);
    };
    next(0);
  }, [lang, voice, rate]);

  const pause = useCallback(() => {
    synth()?.pause();
    setPaused(true);
  }, []);
  const resume = useCallback(() => {
    synth()?.resume();
    setPaused(false);
  }, []);

  return { supported, hasVoice: !!voice, voiceName: voice?.name, voicesLoaded: voices.length > 0, speaking, paused, index, speak, stop, pause, resume };
}
