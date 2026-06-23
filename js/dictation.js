import { elements, state, lastNarrationSelection, setLastNarrationSelection } from "./state.js";
import { refreshActionAvailability, renderPreview, saveSettings, setStatus } from "./ui.js";
import { getActiveTab, validateActiveTab } from "./capture.js";
import { getTranscriptionProvider } from "./settings.js";
import {
  isWhisperConfigured,
  startWhisperRecording,
  stopWhisperRecordingAndTranscribe
} from "./transcription.js";

const DICTATION_RESULT_MESSAGE_TYPE = "heracles-dictation-result";
const DICTATION_ERROR_MESSAGE_TYPE = "heracles-dictation-error";
const MIC_PERMISSION_MESSAGE_TYPE = "heracles-mic-permission";
const ENGINE_STORAGE_KEY = "dictationEngine";
const RESTART_DELAY_MS = 250;
const RAPID_RESTART_WINDOW_MS = 1500;
const MAX_RAPID_RESTARTS = 3;

const SPOKEN_COMMANDS = [
  [/\bnew paragraph\b/gi, "\n\n"],
  [/\bnew line\b/gi, "\n"],
  [/\bfull stop\b/gi, "."],
  [/\bperiod\b/gi, "."],
  [/\bcomma\b/gi, ","],
  [/\bquestion mark\b/gi, "?"],
  [/\bexclamation (?:mark|point)\b/gi, "!"],
  [/\bsemicolon\b/gi, ";"],
  [/\bcolon\b/gi, ":"]
];

const dictationState = {
  active: false,
  engine: "",
  recognition: null,
  recordedTabId: null,
  stopRequested: false,
  hadResult: false,
  persistedEngine: false,
  pendingStartAfterPermission: false,
  lastStartAt: 0,
  rapidRestarts: 0,
  interimText: "",
  transcribing: false
};

let dictateButton = null;
let interimElement = null;
let dictationSink = null;

export function initDictation() {
  dictateButton = document.getElementById("dictateButton");
  interimElement = document.getElementById("dictationInterim");

  if (!dictateButton || !interimElement) {
    console.warn("Dictation UI elements are missing; voice dictation is unavailable.");
    return;
  }

  dictateButton.addEventListener("click", () => {
    void toggleDictation();
  });

  chrome.runtime.onMessage.addListener(handleDictationMessage);
  updateDictationUi();
}

export async function toggleDictation() {
  // While a Whisper upload is in flight the button is disabled, but guard here
  // too so a stray click can never double-fire the stop/transcribe path.
  if (dictationState.transcribing) {
    return;
  }

  if (dictationState.active) {
    if (dictationState.engine === "whisper") {
      await stopWhisperDictation();
      return;
    }

    await stopDictation("Dictation stopped.");
    return;
  }

  await startDictation();
}

export async function startRoutedDictation(sink) {
  dictationSink = typeof sink === "function" ? sink : null;

  // Whisper is batch-only and gives no per-click interim, so auto-capture voice
  // routing always uses the browser engine. Flag forces browser mode below.
  if (getTranscriptionProvider() === "openai") {
    setStatus("Voice routing uses the browser engine; Whisper applies to the Dictate button.");
  }

  await startDictation();
}

export async function stopRoutedDictation() {
  if (!dictationSink) {
    return;
  }

  dictationSink = null;

  if (dictationState.active) {
    await stopDictation("Voice capture stopped with auto-capture.");
  }
}

async function startDictation() {
  if (dictationState.active) {
    return;
  }

  if (state.busy) {
    setStatus("Wait for the current action to finish before starting dictation.", "warn");
    return;
  }

  // Manual Dictate with the Whisper provider records audio for batch upload.
  // Routed auto-capture voice (dictationSink set) always uses the browser
  // engine instead, since Whisper has no per-click interim.
  if (!dictationSink) {
    if (isWhisperConfigured()) {
      await startWhisperDictation();
      return;
    }

    // Provider is Whisper but no key is set: fall back to the browser engine.
    if (getTranscriptionProvider() === "openai") {
      setStatus("Add an OpenAI API key in Settings to use Whisper; using the browser engine for now.");
    }
  }

  const stored = await chrome.storage.local.get({ [ENGINE_STORAGE_KEY]: "" });
  const preferredEngine = stored[ENGINE_STORAGE_KEY];

  if (preferredEngine === "page" || !supportsPanelRecognition()) {
    await startPageEngine();
    return;
  }

  const micState = await queryMicPermissionState();

  if (micState === "prompt") {
    requestMicPermission();
    return;
  }

  if (micState === "denied") {
    await startPageEngine("Microphone is blocked for the extension, so dictation runs through the page instead.");
    return;
  }

  startPanelEngine();
}

async function startWhisperDictation() {
  // Reuse the same one-time permission gate as the browser engine: if Chrome
  // has not yet been asked for the mic, send the user through permission.html
  // (which calls getUserMedia in a normal tab) and resume once granted.
  const micState = await queryMicPermissionState();

  if (micState === "prompt") {
    requestMicPermission();
    return;
  }

  if (micState === "denied") {
    setStatus("Microphone access is blocked for the extension, so Whisper transcription cannot record.", "warn");
    return;
  }

  try {
    await startWhisperRecording();
  } catch (error) {
    setStatus(error.message || "Unable to start Whisper recording.", "warn");
    return;
  }

  dictationState.engine = "whisper";
  dictationState.active = true;
  dictationState.stopRequested = false;
  dictationState.hadResult = false;
  dictationState.interimText = "";
  dictationState.transcribing = false;

  updateDictationUi();
  setStatus("Recording for Whisper transcription. Click Stop Dictation when you are done.", "success");
}

async function stopWhisperDictation() {
  if (dictationState.engine !== "whisper" || dictationState.transcribing) {
    return;
  }

  // Keep "active" true through the request so the toggle reads as a stop, but
  // mark transcribing so the button is disabled and a second click is a no-op.
  dictationState.transcribing = true;
  dictationState.interimText = "";
  updateDictationUi();
  setStatus("Transcribing with Whisper...");

  let transcript = "";

  try {
    transcript = await stopWhisperRecordingAndTranscribe();
  } catch (error) {
    finishWhisperDictation();
    setStatus(error.message || "Whisper transcription failed.", "warn");
    return;
  }

  finishWhisperDictation();

  if (transcript) {
    insertDictatedText(transcript);
    setStatus("Transcription inserted at your cursor.", "success");
  } else {
    setStatus("Whisper returned no speech, so nothing was inserted.", "warn");
  }
}

function finishWhisperDictation() {
  dictationState.active = false;
  dictationState.transcribing = false;
  dictationState.engine = "";
  dictationState.interimText = "";
  dictationState.stopRequested = true;
  updateDictationUi();
}

export async function stopDictation(message, tone = "info") {
  dictationSink = null;
  dictationState.active = false;
  dictationState.stopRequested = true;
  dictationState.interimText = "";
  dictationState.transcribing = false;

  if (dictationState.recognition) {
    const recognition = dictationState.recognition;
    dictationState.recognition = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;

    try {
      recognition.stop();
    } catch (error) {
      // The recognizer may already be stopped.
    }
  }

  if (dictationState.engine === "page") {
    chrome.tabs.onUpdated.removeListener(handleDictationTabUpdated);
    chrome.tabs.onRemoved.removeListener(handleDictationTabRemoved);

    const tabId = dictationState.recordedTabId;
    dictationState.recordedTabId = null;

    if (typeof tabId === "number") {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: dictationStopInPage
        });
      } catch (error) {
        console.warn("Could not disable the in-page dictation listener (the tab may be gone).", error);
      }
    }
  }

  dictationState.engine = "";
  updateDictationUi();

  if (message) {
    setStatus(message, tone);
  }
}

function supportsPanelRecognition() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

async function queryMicPermissionState() {
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    return status.state;
  } catch (error) {
    return "unknown";
  }
}

function requestMicPermission() {
  dictationState.pendingStartAfterPermission = true;

  void chrome.tabs.create({
    url: chrome.runtime.getURL("permission.html")
  });

  setStatus("Grant microphone access in the tab that just opened, then dictation starts automatically.");
}

function startPanelEngine() {
  const recognition = createPanelRecognition();

  if (!recognition) {
    void startPageEngine();
    return;
  }

  dictationState.engine = "panel";
  dictationState.recognition = recognition;
  dictationState.active = true;
  dictationState.stopRequested = false;
  dictationState.hadResult = false;
  dictationState.rapidRestarts = 0;
  dictationState.interimText = "";

  try {
    dictationState.lastStartAt = Date.now();
    recognition.start();
  } catch (error) {
    dictationState.active = false;
    dictationState.recognition = null;
    void startPageEngine("Side panel dictation could not start, so it runs through the page instead.");
    return;
  }

  updateDictationUi();
  setStatus("Dictation listening. Speak, and the words land at your cursor in the narration.", "success");
}

function createPanelRecognition() {
  const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!RecognitionCtor) {
    return null;
  }

  const recognition = new RecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";

  recognition.onresult = (event) => {
    const items = [];

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      items.push({
        text: result[0] ? result[0].transcript : "",
        isFinal: Boolean(result.isFinal)
      });
    }

    processRecognitionItems(items);
  };

  recognition.onerror = (event) => {
    handlePanelRecognitionError(event.error || "");
  };

  recognition.onend = () => {
    if (!dictationState.active || dictationState.engine !== "panel" || dictationState.stopRequested) {
      return;
    }

    if (Date.now() - dictationState.lastStartAt < RAPID_RESTART_WINDOW_MS) {
      dictationState.rapidRestarts += 1;
    } else {
      dictationState.rapidRestarts = 0;
    }

    if (dictationState.rapidRestarts >= MAX_RAPID_RESTARTS) {
      void stopDictation("Dictation kept disconnecting and was stopped. Try again, or check the microphone.", "warn");
      return;
    }

    window.setTimeout(() => {
      if (!dictationState.active || dictationState.engine !== "panel" || !dictationState.recognition) {
        return;
      }

      try {
        dictationState.lastStartAt = Date.now();
        dictationState.recognition.start();
      } catch (error) {
        void stopDictation("Dictation could not reconnect and was stopped.", "warn");
      }
    }, RESTART_DELAY_MS);
  };

  return recognition;
}

function handlePanelRecognitionError(code) {
  if (code === "no-speech" || code === "aborted") {
    return;
  }

  const blockedInContext = ["network", "service-not-allowed", "not-allowed", "language-not-supported"].includes(code);

  if (blockedInContext && !dictationState.hadResult) {
    teardownPanelRecognition();
    void chrome.storage.local.set({ [ENGINE_STORAGE_KEY]: "page" });
    void startPageEngine("Chrome blocks speech recognition inside the side panel, so dictation runs through the page instead.");
    return;
  }

  if (code === "audio-capture") {
    void stopDictation("No microphone was found, so dictation stopped.", "warn");
    return;
  }

  if (code === "not-allowed" || code === "service-not-allowed") {
    void stopDictation("Microphone access was blocked, so dictation stopped.", "warn");
  }
}

function teardownPanelRecognition() {
  dictationState.active = false;

  if (dictationState.recognition) {
    const recognition = dictationState.recognition;
    dictationState.recognition = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;

    try {
      recognition.abort();
    } catch (error) {
      // Ignore teardown failures.
    }
  }
}

async function startPageEngine(notice) {
  try {
    const tab = await getActiveTab();
    validateActiveTab(tab);

    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: dictationStartInPage,
      args: [navigator.language || "en-US"]
    });

    const result = injection?.result;

    if (!result?.ok) {
      throw new Error(result?.error || "Could not start speech recognition in the page.");
    }

    dictationState.engine = "page";
    dictationState.recordedTabId = tab.id;
    dictationState.active = true;
    dictationState.stopRequested = false;
    dictationState.hadResult = false;
    dictationState.interimText = "";

    chrome.tabs.onUpdated.addListener(handleDictationTabUpdated);
    chrome.tabs.onRemoved.addListener(handleDictationTabRemoved);

    updateDictationUi();
    setStatus(
      notice || "Dictation listening through the page. Allow the microphone there if Chrome asks.",
      "success"
    );
  } catch (error) {
    dictationState.active = false;
    dictationState.engine = "";
    updateDictationUi();
    setStatus(error.message || "Unable to start dictation.", "warn");
  }
}

function handleDictationTabUpdated(tabId, changeInfo, tab) {
  if (
    !dictationState.active ||
    dictationState.engine !== "page" ||
    tabId !== dictationState.recordedTabId ||
    changeInfo.status !== "complete"
  ) {
    return;
  }

  if (!/^https?:/i.test(tab?.url || "")) {
    return;
  }

  chrome.scripting
    .executeScript({
      target: { tabId },
      func: dictationStartInPage,
      args: [navigator.language || "en-US"]
    })
    .catch((error) => {
      console.warn("Unable to re-arm dictation after navigation.", error);
    });
}

function handleDictationTabRemoved(tabId) {
  if (!dictationState.active || dictationState.engine !== "page" || tabId !== dictationState.recordedTabId) {
    return;
  }

  dictationState.recordedTabId = null;
  void stopDictation("Dictation stopped: the recorded tab was closed.");
}

function handleDictationMessage(message, sender) {
  if (message?.type === MIC_PERMISSION_MESSAGE_TYPE) {
    if (message.granted && dictationState.pendingStartAfterPermission) {
      dictationState.pendingStartAfterPermission = false;
      void startDictation();
    } else if (!message.granted) {
      dictationState.pendingStartAfterPermission = false;
      setStatus("Microphone access was not granted, so dictation stays off.", "warn");
    }

    return undefined;
  }

  if (message?.type !== DICTATION_RESULT_MESSAGE_TYPE && message?.type !== DICTATION_ERROR_MESSAGE_TYPE) {
    return undefined;
  }

  if (!dictationState.active || dictationState.engine !== "page" || sender.tab?.id !== dictationState.recordedTabId) {
    return undefined;
  }

  if (message.type === DICTATION_ERROR_MESSAGE_TYPE) {
    const error = String(message.error || "");

    if (error === "not-allowed" || error === "service-not-allowed") {
      void stopDictation("The page blocked microphone access. Allow the microphone for that site and start again.", "warn");
    } else if (error === "audio-capture") {
      void stopDictation("No microphone was found, so dictation stopped.", "warn");
    } else if (error === "restart-loop") {
      void stopDictation("Dictation kept disconnecting and was stopped. Try again, or check the microphone.", "warn");
    } else {
      void stopDictation(`Dictation stopped (${error || "unknown error"}).`, "warn");
    }

    return undefined;
  }

  processRecognitionItems(Array.isArray(message.items) ? message.items : []);
  return undefined;
}

function processRecognitionItems(items) {
  let interimText = "";

  for (const item of items) {
    if (!item || typeof item.text !== "string") {
      continue;
    }

    if (item.isFinal) {
      if (dictationSink) {
        try {
          dictationSink(item.text);
        } catch (error) {
          console.error("Routed dictation sink failed; inserting at the cursor instead.", error);
          insertDictatedText(item.text);
        }
      } else {
        insertDictatedText(item.text);
      }

      markEngineWorking();
    } else {
      interimText += item.text;
    }
  }

  dictationState.interimText = interimText.trim();
  updateDictationUi();
}

function markEngineWorking() {
  dictationState.hadResult = true;

  if (!dictationState.persistedEngine && dictationState.engine) {
    dictationState.persistedEngine = true;
    void chrome.storage.local.set({ [ENGINE_STORAGE_KEY]: dictationState.engine });
  }
}

export function prepareDictatedChunk(before, rawText) {
  let chunk = applySpokenCommands(String(rawText || ""));

  if (!chunk.trim()) {
    return /\n/.test(chunk) ? chunk.replace(/[^\n]/g, "") : "";
  }

  chunk = chunk.trim();

  if (before.length > 0 && !/\s$/.test(before) && !/^[.,!?;:\n]/.test(chunk)) {
    chunk = ` ${chunk}`;
  }

  if (shouldCapitalizeAfter(before)) {
    chunk = capitalizeFirstLetter(chunk);
  }

  return chunk;
}

function insertDictatedText(rawText) {
  const currentValue = elements.narrationInput.value;
  const selectionStart = clampSelection(lastNarrationSelection.start, currentValue.length);
  const selectionEnd = clampSelection(lastNarrationSelection.end, currentValue.length);
  const before = currentValue.slice(0, selectionStart);
  const after = currentValue.slice(selectionEnd);
  const chunk = prepareDictatedChunk(before, rawText);

  if (!chunk) {
    return;
  }

  const updatedValue = `${before}${chunk}${after}`;
  const cursorPosition = (before + chunk).length;

  elements.narrationInput.value = updatedValue;
  elements.narrationInput.selectionStart = cursorPosition;
  elements.narrationInput.selectionEnd = cursorPosition;
  setLastNarrationSelection({ start: cursorPosition, end: cursorPosition });

  renderPreview();
  refreshActionAvailability();
  void saveSettings();
}

function applySpokenCommands(text) {
  let output = text;

  SPOKEN_COMMANDS.forEach(([pattern, replacement]) => {
    output = output.replace(pattern, replacement);
  });

  output = output.replace(/[ \t]+/g, " ");
  output = output.replace(/ ([.,!?;:])/g, "$1");
  output = output.replace(/ *\n */g, "\n");

  return output;
}

function shouldCapitalizeAfter(before) {
  if (!before.trim()) {
    return true;
  }

  return /[.!?]["')\]]?\s*$/.test(before) || /\n\s*$/.test(before);
}

function capitalizeFirstLetter(text) {
  const match = text.match(/[a-z]/i);

  if (!match || match[0] !== match[0].toLowerCase()) {
    return text;
  }

  const index = match.index;
  return `${text.slice(0, index)}${text[index].toUpperCase()}${text.slice(index + 1)}`;
}

function clampSelection(value, max) {
  if (!Number.isFinite(value)) {
    return max;
  }

  return Math.max(0, Math.min(value, max));
}

function updateDictationUi() {
  if (!dictateButton || !interimElement) {
    return;
  }

  if (dictationState.active) {
    dictateButton.classList.add("button-recording");
    interimElement.classList.remove("hidden");

    if (dictationState.engine === "whisper") {
      // Disable the toggle while the batch upload is in flight so a second
      // click cannot double-fire the stop/transcribe path.
      dictateButton.disabled = dictationState.transcribing;
      dictateButton.textContent = dictationState.transcribing ? "Transcribing..." : "Stop Dictation";
      interimElement.textContent = dictationState.transcribing
        ? "Transcribing..."
        : "Recording for transcription...";
      return;
    }

    dictateButton.disabled = false;
    dictateButton.textContent = "Stop Dictation";

    if (dictationState.interimText) {
      interimElement.textContent = dictationState.interimText;
    } else {
      interimElement.textContent =
        dictationState.engine === "page" ? "Listening through the page..." : "Listening...";
    }

    return;
  }

  dictateButton.disabled = false;
  dictateButton.textContent = "Dictate";
  dictateButton.classList.remove("button-recording");
  interimElement.textContent = "";
  interimElement.classList.add("hidden");
}

function dictationStartInPage(lang) {
  if (window.__heraclesDictationActive) {
    return { ok: true, alreadyRunning: true };
  }

  const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!RecognitionCtor) {
    return { ok: false, error: "Speech recognition is not available in this page." };
  }

  window.__heraclesDictationActive = true;

  let lastStartAt = 0;
  let rapidRestarts = 0;

  const send = (payload) => {
    try {
      chrome.runtime.sendMessage(payload);
    } catch (error) {
      window.__heraclesDictationActive = false;
    }
  };

  const recognition = new RecognitionCtor();
  window.__heraclesDictationRecognition = recognition;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = lang || "en-US";

  recognition.onresult = (event) => {
    const items = [];

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      items.push({
        text: result[0] ? result[0].transcript : "",
        isFinal: Boolean(result.isFinal)
      });
    }

    send({ type: "heracles-dictation-result", items });
  };

  recognition.onerror = (event) => {
    const code = event.error || "";

    if (code === "no-speech" || code === "aborted") {
      return;
    }

    window.__heraclesDictationActive = false;
    send({ type: "heracles-dictation-error", error: code });
  };

  recognition.onend = () => {
    if (!window.__heraclesDictationActive) {
      return;
    }

    if (Date.now() - lastStartAt < 1500) {
      rapidRestarts += 1;
    } else {
      rapidRestarts = 0;
    }

    if (rapidRestarts >= 3) {
      window.__heraclesDictationActive = false;
      send({ type: "heracles-dictation-error", error: "restart-loop" });
      return;
    }

    setTimeout(() => {
      if (!window.__heraclesDictationActive) {
        return;
      }

      try {
        lastStartAt = Date.now();
        recognition.start();
      } catch (error) {
        window.__heraclesDictationActive = false;
        send({ type: "heracles-dictation-error", error: "restart-failed" });
      }
    }, 250);
  };

  try {
    lastStartAt = Date.now();
    recognition.start();
  } catch (error) {
    window.__heraclesDictationActive = false;
    window.__heraclesDictationRecognition = null;
    return { ok: false, error: "Could not start speech recognition in the page." };
  }

  return { ok: true };
}

function dictationStopInPage() {
  window.__heraclesDictationActive = false;

  const recognition = window.__heraclesDictationRecognition;
  window.__heraclesDictationRecognition = null;

  if (recognition) {
    try {
      recognition.stop();
    } catch (error) {
      // The recognizer may already be stopped.
    }
  }

  return true;
}
