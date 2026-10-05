import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { TalkDock } from "./components/Composer";
import { RateLimitBanner } from "./components/RateLimitBanner";
import { SettingsModal } from "./components/SettingsModal";
import { Stage } from "./components/Stage";
import {
  applyUpdate,
  bootstrap,
  cancelSpeech,
  checkUpdate,
  converse,
  speak,
  transcribe,
  type UpdateOffer,
  type UpdateProgress,
} from "./lib/api";
import { decodeBase64, PcmPlayer, SpeechCapture, type MicLevel } from "./lib/audio";
import { isDesktopShell, toCommandError } from "./lib/errors";
import { blendSkill, estimateSkill, parseDualOutput, speakingBand } from "./lib/parseReply";
import {
  activePersona,
  DEFAULT_PREFERENCES,
  normalizeFontSize,
  normalizeLayout,
  usageTotal,
  type AppLayout,
  type Bootstrap,
  type ChatMessage,
  type CommandError,
  type Phase,
} from "./types";

const QUIET: MicLevel = { level: 0, voiced: false, capturing: false };

const EMPTY_SESSION: Bootstrap = {
  version: "1.2.1",
  groqConfigured: false,
  cartesiaConfigured: false,
  preferences: DEFAULT_PREFERENCES,
  usage: { day: "", promptTokens: 0, completionTokens: 0 },
  warningRatio: 0.8,
  characters: [],
  activeCharacterId: "",
};

export default function App() {
  const desktop = isDesktopShell();
  const [session, setSession] = useState<Bootstrap>(EMPTY_SESSION);
  const [skillRating, setSkillRating] = useState<number | null>(null);
  const [youSaid, setYouSaid] = useState<string | null>(null);
  const [latestNotes, setLatestNotes] = useState<string[]>([]);
  const [earlierNotes, setEarlierNotes] = useState<string[]>([]);
  const [tollySaid, setTollySaid] = useState<string | null>(null);
  const [heardYou, setHeardYou] = useState(false);
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [micOpen, setMicOpen] = useState(false);
  const [reading, setReading] = useState<MicLevel>(QUIET);
  const [notice, setNotice] = useState<string | null>(null);
  const [rateLimit, setRateLimit] = useState<CommandError | null>(null);
  const [budgetNote, setBudgetNote] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appearanceDraft, setAppearanceDraft] = useState<{ fontSize: number; layout: AppLayout } | null>(null);
  const [update, setUpdate] = useState<UpdateOffer | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateReceived, setUpdateReceived] = useState(0);
  const [updateTotal, setUpdateTotal] = useState(0);

  const sessionRef = useRef(session);
  const messagesRef = useRef<ChatMessage[]>([]);
  const latestNotesRef = useRef<string[]>([]);
  const listeningRef = useRef(false);
  const holdingRef = useRef(false);
  const holdWantedRef = useRef(false);
  const lockRef = useRef(false);
  const turnGen = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  const captureRef = useRef<SpeechCapture | null>(null);
  const openingMic = useRef<Promise<SpeechCapture> | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const bargeTimer = useRef<number | null>(null);
  const onUtteranceRef = useRef<(wav: Uint8Array) => void>(() => undefined);
  const onSpeechStartRef = useRef<() => void>(() => undefined);
  const lastCharacterRef = useRef<string | null>(null);
  const persona = activePersona(session.characters, session.activeCharacterId);

  function setPhase(next: Phase): void {
    phaseRef.current = next;
    setPhaseState(next);
  }

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const fontSize = normalizeFontSize(appearanceDraft?.fontSize ?? session.preferences.fontSize);
  const layout = normalizeLayout(appearanceDraft?.layout ?? session.preferences.layout);

  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSize}px`;
  }, [fontSize]);

  useEffect(() => {
    if (!desktop) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const next = await bootstrap();
        if (cancelled) {
          return;
        }
        sessionRef.current = next;
        setSession(next);
        if (usageTotal(next.usage) / next.preferences.dailyTokenBudget >= next.warningRatio) {
          setBudgetNote("You have used most of today's token budget.");
        }
        if (next.preferences.autoListen && next.groqConfigured && next.cartesiaConfigured) {
          // Start listening right away, so the first thing to do is simply talk.
          void startContinuous();
        }
      } catch (error: unknown) {
        if (!cancelled) {
          setNotice(toCommandError(error).message);
        }
      }
      try {
        const offer = await checkUpdate();
        if (!cancelled) {
          setUpdate(offer);
        }
      } catch {
        // A failed check stays quiet until Settings asks again.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  useEffect(() => {
    if (!desktop || !updating) {
      return;
    }
    let unlisten: (() => void) | null = null;
    let closed = false;
    void listen<UpdateProgress>("update-progress", (event) => {
      setUpdateReceived(event.payload.received);
      setUpdateTotal(event.payload.total);
    }).then((stop) => {
      if (closed) {
        stop();
        return;
      }
      unlisten = stop;
    });
    return () => {
      closed = true;
      unlisten?.();
    };
  }, [desktop, updating]);

  const inputDeviceId = session.preferences.inputDeviceId;
  const micSensitivity = session.preferences.micSensitivity;
  useEffect(() => {
    const capture = captureRef.current;
    if (!capture) {
      return;
    }
    capture.setSensitivity(micSensitivity);
    if (capture.deviceId === (inputDeviceId ?? "")) {
      return;
    }
    // A different microphone was chosen. Reopen it, and keep listening if we were.
    const wasListening = listeningRef.current;
    void (async () => {
      await releaseMic();
      if (wasListening) {
        await startContinuous();
      }
    })();
  }, [inputDeviceId, micSensitivity]);

  useEffect(() => {
    playerRef.current?.setOutput(session.preferences.outputDeviceId);
  }, [session.preferences.outputDeviceId]);

  const activeCharacterId = session.activeCharacterId;
  useEffect(() => {
    if (lastCharacterRef.current === null) {
      lastCharacterRef.current = activeCharacterId;
      return;
    }
    if (lastCharacterRef.current === activeCharacterId) {
      return;
    }
    lastCharacterRef.current = activeCharacterId;
    // A different person is talking now. Start the conversation fresh.
    cutAssistant();
    messagesRef.current = [];
    latestNotesRef.current = [];
    setYouSaid(null);
    setTollySaid(null);
    setLatestNotes([]);
    setEarlierNotes([]);
    setHeardYou(false);
    setSkillRating(null);
    setNotice(null);
    if (listeningRef.current) {
      captureRef.current?.setPaused(false);
      setPhase("listening");
    } else {
      setPhase("idle");
    }
  }, [activeCharacterId]);

  useEffect(() => {
    return () => {
      void captureRef.current?.stop();
      playerRef.current?.stop();
      if (bargeTimer.current !== null) {
        window.clearTimeout(bargeTimer.current);
      }
    };
  }, []);

  function player(): PcmPlayer {
    if (!playerRef.current) {
      playerRef.current = new PcmPlayer();
    }
    return playerRef.current;
  }

  function clearBargeTimer(): void {
    if (bargeTimer.current !== null) {
      window.clearTimeout(bargeTimer.current);
      bargeTimer.current = null;
    }
  }

  function showFailure(error: unknown): void {
    const command = toCommandError(error);
    if (command.code === "rate_limited") {
      setRateLimit(command);
      setNotice(null);
      return;
    }
    if (command.code === "budget_exceeded") {
      setBudgetNote(command.message);
    }
    setNotice(command.message);
  }

  function keysReady(): boolean {
    return sessionRef.current.groqConfigured && sessionRef.current.cartesiaConfigured;
  }

  function requireReady(): boolean {
    if (!desktop) {
      setNotice("Open the desktop app to capture speech and call the APIs.");
      return false;
    }
    if (!keysReady()) {
      setSettingsOpen(true);
      setNotice("Add both API keys in Settings first.");
      return false;
    }
    return true;
  }

  function cutAssistant(): void {
    turnGen.current += 1;
    lockRef.current = false;
    clearBargeTimer();
    captureRef.current?.setBargeIn(false);
    void cancelSpeech();
    player().stop();
  }

  function remember(message: ChatMessage): void {
    messagesRef.current = [...messagesRef.current, message].slice(-8);
  }

  async function ensureCapture(): Promise<SpeechCapture> {
    if (captureRef.current) {
      return captureRef.current;
    }
    if (openingMic.current) {
      return openingMic.current;
    }
    const pending = (async () => {
      const capture = new SpeechCapture(
        (wav) => onUtteranceRef.current(wav),
        () => onSpeechStartRef.current(),
        (level) => setReading(level),
        {
          deviceId: sessionRef.current.preferences.inputDeviceId,
          sensitivity: sessionRef.current.preferences.micSensitivity,
        },
      );
      await capture.start();
      captureRef.current = capture;
      return capture;
    })();
    openingMic.current = pending;
    try {
      return await pending;
    } finally {
      openingMic.current = null;
    }
  }

  async function armBarge(generation: number): Promise<void> {
    try {
      const capture = await ensureCapture();
      if (generation !== turnGen.current) {
        return;
      }
      capture.setPaused(false);
      clearBargeTimer();
      bargeTimer.current = window.setTimeout(() => {
        if (generation === turnGen.current) {
          captureRef.current?.setBargeIn(true);
        }
      }, 700);
    } catch {
      // The reply still plays. The button can cut in if the microphone is unavailable.
    }
  }

  function finishListeningState(generation: number): void {
    if (generation !== turnGen.current) {
      return;
    }
    lockRef.current = false;
    clearBargeTimer();
    captureRef.current?.setBargeIn(false);
    if (listeningRef.current) {
      captureRef.current?.setPaused(false);
      setPhase("listening");
      return;
    }
    const capture = captureRef.current;
    captureRef.current = null;
    void capture?.stop();
    if (!holdingRef.current) {
      setPhase("idle");
    }
  }

  async function runTurn(userText: string, generation: number, shown = true): Promise<void> {
    const history = [
      ...messagesRef.current.map((message) => ({
        role: message.role,
        content:
          message.role === "assistant"
            ? JSON.stringify({
                spoken_reply: message.text,
                visual_feedback: [],
                skill_rating: message.skillRating ?? null,
              })
            : message.text,
      })),
      { role: "user" as const, content: userText },
    ];
    if (shown) {
      remember({ id: crypto.randomUUID(), role: "user", text: userText });
    }
    captureRef.current?.setBargeIn(false);
    captureRef.current?.setPaused(true);
    clearBargeTimer();
    setPhase("thinking");
    setNotice(null);
    const result = await converse(history);
    if (generation !== turnGen.current) {
      return;
    }
    const parsed = parseDualOutput(result.rawJson);
    if (shown) {
      const next = parsed.skillRating ?? estimateSkill(parsed.visualFeedback.length);
      setSkillRating((current) => blendSkill(current, next));
      setEarlierNotes((current) => [...latestNotesRef.current, ...current].filter((note) => note.length > 0).slice(0, 6));
      latestNotesRef.current = parsed.visualFeedback;
      setLatestNotes(parsed.visualFeedback);
      setYouSaid(userText);
      setHeardYou(true);
    }
    setTollySaid(parsed.spokenReply);
    remember({
      id: crypto.randomUUID(),
      role: "assistant",
      text: parsed.spokenReply,
      feedback: parsed.visualFeedback,
      skillRating: parsed.skillRating,
    });
    setSession((current) => ({
      ...current,
      usage: {
        ...current.usage,
        promptTokens: current.usage.promptTokens + result.promptTokens,
        completionTokens: current.usage.completionTokens + result.completionTokens,
      },
    }));
    setBudgetNote(result.budgetWarning ? "You have used most of today's token budget." : null);
    setRateLimit(null);

    await sayAloud(parsed.spokenReply, generation);
  }

  async function sayAloud(text: string, generation: number): Promise<void> {
    const turnId = crypto.randomUUID();
    const playback = player();
    playback.setVolume(sessionRef.current.preferences.voiceVolume);
    playback.setOutput(sessionRef.current.preferences.outputDeviceId);
    playback.resume();
    playback.stop();
    setPhase("speaking");
    await armBarge(generation);
    if (generation !== turnGen.current) {
      return;
    }
    await speak(text, turnId, (chunk) => {
      if (generation !== turnGen.current) {
        return;
      }
      playback.enqueue(decodeBase64(chunk.dataBase64), chunk.sampleRate);
    });
    if (generation !== turnGen.current) {
      return;
    }
    await playback.waitUntilDone();
    if (generation !== turnGen.current) {
      return;
    }
    clearBargeTimer();
    captureRef.current?.setBargeIn(false);
  }

  async function replayLast(): Promise<void> {
    const line = tollySaid;
    if (!line || lockRef.current || !requireReady()) {
      return;
    }
    const generation = turnGen.current;
    lockRef.current = true;
    setNotice(null);
    try {
      await sayAloud(line, generation);
    } catch (error: unknown) {
      if (generation === turnGen.current) {
        showFailure(error);
      }
    } finally {
      finishListeningState(generation);
    }
  }

  async function endSession(): Promise<void> {
    setNotice(null);
    cutAssistant();
    await releaseMic();
  }

  onSpeechStartRef.current = () => {
    if (phaseRef.current !== "speaking") {
      return;
    }
    cutAssistant();
    setPhase("listening");
  };

  onUtteranceRef.current = (wav) => {
    if (lockRef.current) {
      return;
    }
    const generation = turnGen.current;
    lockRef.current = true;
    captureRef.current?.setPaused(true);
    captureRef.current?.setBargeIn(false);
    void (async () => {
      try {
        setPhase("transcribing");
        const text = (await transcribe(wav)).trim();
        if (generation !== turnGen.current) {
          return;
        }
        if (!text) {
          setNotice("I couldn't hear any words. Try again.");
          return;
        }
        await runTurn(text, generation);
      } catch (error: unknown) {
        if (generation === turnGen.current) {
          showFailure(error);
        }
      } finally {
        finishListeningState(generation);
      }
    })();
  };

  async function releaseMic(): Promise<void> {
    listeningRef.current = false;
    holdingRef.current = false;
    holdWantedRef.current = false;
    setMicOpen(false);
    const capture = captureRef.current;
    captureRef.current = null;
    await capture?.stop();
    setReading(QUIET);
    if (!lockRef.current) {
      setPhase("idle");
    }
  }

  async function startContinuous(): Promise<void> {
    if (!requireReady()) {
      return;
    }
    try {
      player().resume();
      const capture = await ensureCapture();
      capture.setPaused(false);
      listeningRef.current = true;
      setMicOpen(true);
      setPhase("listening");
    } catch (error: unknown) {
      const name = error instanceof DOMException ? error.name : "";
      setNotice(name === "NotAllowedError" ? "Microphone permission was blocked." : toCommandError(error).message);
      setPhase("idle");
    }
  }

  async function onShortPress(): Promise<void> {
    setNotice(null);
    const busy = phaseRef.current === "speaking" || phaseRef.current === "thinking" || phaseRef.current === "transcribing";
    if (busy) {
      cutAssistant();
    }
    if (listeningRef.current && !busy) {
      await releaseMic();
      return;
    }
    if (!listeningRef.current) {
      await startContinuous();
      return;
    }
    setPhase("listening");
  }

  async function holdStart(): Promise<void> {
    setNotice(null);
    if (holdingRef.current) {
      return;
    }
    const busy = phaseRef.current === "speaking" || phaseRef.current === "thinking" || phaseRef.current === "transcribing";
    if (busy) {
      cutAssistant();
    }
    if (!requireReady()) {
      return;
    }
    holdWantedRef.current = true;
    holdingRef.current = true;
    setPhase("listening");
    try {
      player().resume();
      const capture = await ensureCapture();
      if (!holdWantedRef.current) {
        holdingRef.current = false;
        if (!listeningRef.current) {
          captureRef.current = null;
          await capture.stop();
          setPhase("idle");
        }
        setNotice("Hold the button until you finish the sentence.");
        return;
      }
      capture.beginHold();
    } catch (error: unknown) {
      holdingRef.current = false;
      holdWantedRef.current = false;
      const name = error instanceof DOMException ? error.name : "";
      setNotice(name === "NotAllowedError" ? "Microphone permission was blocked." : toCommandError(error).message);
      setPhase(listeningRef.current ? "listening" : "idle");
    }
  }

  async function holdEnd(): Promise<void> {
    if (!holdingRef.current && !holdWantedRef.current) {
      return;
    }
    holdWantedRef.current = false;
    const capture = captureRef.current;
    const emitted = capture?.endHold() ?? false;
    holdingRef.current = false;
    if (!listeningRef.current && capture) {
      captureRef.current = null;
      await capture.stop();
    }
    if (!emitted && !lockRef.current) {
      setPhase(listeningRef.current ? "listening" : "idle");
    }
  }

  async function startTalking(): Promise<void> {
    if (lockRef.current || messagesRef.current.length > 0) {
      return;
    }
    if (!requireReady()) {
      return;
    }
    const generation = turnGen.current;
    lockRef.current = true;
    try {
      player().resume();
      await runTurn("(just sat down)", generation, false);
    } catch (error: unknown) {
      if (generation === turnGen.current) {
        showFailure(error);
      }
    } finally {
      finishListeningState(generation);
    }
  }

  async function refreshUpdate(): Promise<void> {
    if (!desktop) {
      setUpdateError("Open the desktop app to check GitHub.");
      return;
    }
    setUpdateError(null);
    try {
      setUpdate(await checkUpdate());
    } catch (error: unknown) {
      setUpdateError(toCommandError(error).message);
    }
  }

  async function installUpdate(): Promise<void> {
    if (!desktop) {
      setUpdateError("Open the desktop app to install an update.");
      return;
    }
    setUpdating(true);
    setUpdateError(null);
    setUpdateReceived(0);
    setUpdateTotal(0);
    try {
      await applyUpdate();
    } catch (error: unknown) {
      setUpdating(false);
      setUpdateError(toCommandError(error).message);
    }
  }

  const total = usageTotal(session.usage);
  const budget = session.preferences.dailyTokenBudget;
  const ready = session.groqConfigured && session.cartesiaConfigured;
  const shell = layout === "center" ? "max-w-3xl" : "max-w-5xl";
  const started = heardYou || Boolean(tollySaid);
  const status =
    phase === "speaking"
      ? `${persona.name} is talking. Start speaking to cut in.`
      : phase === "thinking"
        ? "Thinking…"
        : phase === "transcribing"
          ? "Got it, one moment…"
          : phase === "listening"
            ? reading.voiced
              ? "Hearing you…"
              : "Listening…"
            : started
              ? "Your turn whenever you're ready."
              : "Ready when you are.";

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      <header className="px-6 pt-4 pb-2">
        <div className={`mx-auto flex ${shell} items-center justify-between gap-4`}>
          <div className="flex items-center gap-3">
            {persona.emoji && (
              <span className="grid h-8 w-8 place-items-center rounded-full bg-note text-lg" aria-hidden="true">
                {persona.emoji}
              </span>
            )}
            <p className="gradient-text text-lg font-semibold tracking-tight">{persona.name}</p>
            <span className="text-xs text-muted">{persona.id ? `with Tolly v${session.version}` : `v${session.version}`}</span>
          </div>
          <div className="flex items-center gap-2">
            <div
              className="pill flex items-center gap-2 rounded-full px-3 py-1.5"
              aria-label={
                skillRating === null
                  ? "Speaking skill for this conversation is not rated yet"
                  : `Speaking skill for this conversation, ${skillRating}, ${speakingBand(skillRating)}`
              }
            >
              <span className="text-xs text-muted">Speaking</span>
              <span className="text-sm font-semibold text-accent-dark">{skillRating ?? "—"}</span>
              <span className="hidden text-xs text-muted sm:inline">{skillRating === null ? "Not rated yet" : speakingBand(skillRating)}</span>
            </div>
            <button
              type="button"
              className="pill grid h-9 w-9 place-items-center rounded-full text-muted hover:text-ink"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
              </svg>
            </button>
          </div>
        </div>
        {budgetNote && <p className={`mx-auto mt-2 ${shell} text-xs text-accent`}>{budgetNote}</p>}
        {!budgetNote && total > 0 && (
          <p className={`mx-auto mt-1 ${shell} text-right text-[0.65rem] text-muted`}>
            {total.toLocaleString()} / {budget.toLocaleString()} tokens today
          </p>
        )}
        {!desktop && (
          <p className={`mx-auto mt-2 ${shell} rounded-xl bg-note px-3 py-2 text-xs text-muted`}>
            Browser preview. Key storage, Groq, and Cartesia run inside the portable desktop app.
          </p>
        )}
      </header>
      {update?.available && (
        <div className="px-6 py-1">
          <div className={`mx-auto flex ${shell} items-center justify-between gap-3 rounded-xl bg-note px-4 py-2 text-sm`}>
            <p>Version {update.latest} is on GitHub.</p>
            <button
              type="button"
              className="btn-primary rounded-full px-3 py-1 text-sm"
              disabled={updating}
              onClick={() => void installUpdate()}
            >
              {updating ? "Installing…" : "Update"}
            </button>
          </div>
        </div>
      )}
      {rateLimit && <RateLimitBanner error={rateLimit} onDismiss={() => setRateLimit(null)} />}
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className={`mx-auto flex w-full ${shell} flex-col items-center gap-4 px-6 pt-2 pb-8`}>
          <p className="flex items-center gap-2 text-sm text-muted" aria-live="polite">
            <span className={`status-dot is-${phase}`} aria-hidden="true" />
            {status}
          </p>
          <Stage
            layout={layout}
            phase={phase}
            persona={persona}
            youSaid={youSaid}
            notes={latestNotes}
            earlier={earlierNotes}
            tollySaid={tollySaid}
            heardYou={heardYou}
            keysReady={ready}
            onOpenSettings={() => setSettingsOpen(true)}
            onStartTalking={() => void startTalking()}
          />
        </div>
      </main>
      <footer className="border-t border-line bg-paper/95 px-6 pt-2 pb-3">
        <TalkDock
          phase={phase}
          notice={notice}
          micOpen={micOpen}
          reading={reading}
          canReplay={Boolean(tollySaid)}
          onShortPress={() => void onShortPress()}
          onHoldStart={() => void holdStart()}
          onHoldEnd={() => void holdEnd()}
          onEnd={() => void endSession()}
          onReplay={() => void replayLast()}
        />
      </footer>
      {settingsOpen && (
        <SettingsModal
          session={session}
          update={update}
          updateError={updateError}
          updating={updating}
          updateReceived={updateReceived}
          updateTotal={updateTotal}
          onCheckUpdate={() => void refreshUpdate()}
          onApplyUpdate={() => void installUpdate()}
          onClose={() => {
            setAppearanceDraft(null);
            setSettingsOpen(false);
          }}
          onSession={setSession}
          onAppearance={setAppearanceDraft}
        />
      )}
    </div>
  );
}
