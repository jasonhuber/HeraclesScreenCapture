/*
 * Optional OpenAI Whisper transcription provider.
 *
 * Whisper is BATCH, not streaming: we record audio with MediaRecorder, then
 * after stopping we upload the assembled blob to the OpenAI transcription
 * endpoint and get one transcript back. This module owns the recorder/stream
 * state so dictation.js can drive a clean start/stop/transcribe cycle while
 * keeping the existing browser Web Speech engine untouched.
 */

import { getOpenAiApiKey, getTranscriptionProvider } from "./settings.js";

const TRANSCRIPTION_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const WHISPER_MODEL = "whisper-1";
const RECORDING_MIME_TYPE = "audio/webm";

const recordingState = {
  recorder: null,
  stream: null,
  chunks: []
};

export function isWhisperConfigured() {
  return getTranscriptionProvider() === "openai" && getOpenAiApiKey().length > 0;
}

// Begins MediaRecorder capture from the microphone. Throws a clear Error when
// the required browser APIs are missing or the user blocks the mic.
export async function startWhisperRecording() {
  if (recordingState.recorder) {
    throw new Error("A Whisper recording is already in progress.");
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    throw new Error("Microphone capture is not available in this browser.");
  }

  if (typeof MediaRecorder === "undefined") {
    throw new Error("Audio recording is not available in this browser.");
  }

  let stream;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    throw new Error("Microphone access was blocked, so Whisper transcription cannot record.");
  }

  let recorder;

  try {
    recorder = createRecorder(stream);
  } catch (error) {
    releaseStream(stream);
    throw new Error("Could not start audio recording for Whisper transcription.");
  }

  const chunks = [];

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  });

  recordingState.recorder = recorder;
  recordingState.stream = stream;
  recordingState.chunks = chunks;

  try {
    recorder.start();
  } catch (error) {
    resetRecordingState();
    releaseStream(stream);
    throw new Error("Could not start audio recording for Whisper transcription.");
  }
}

// Stops the recorder, assembles the recorded audio, uploads it to OpenAI, and
// returns the transcript string. Always releases the microphone, even on error.
export async function stopWhisperRecordingAndTranscribe() {
  const recorder = recordingState.recorder;
  const stream = recordingState.stream;
  const chunks = recordingState.chunks;

  if (!recorder) {
    throw new Error("No Whisper recording is in progress.");
  }

  // Detach module state up front so a failure here can't leave a stuck recorder.
  resetRecordingState();

  try {
    await stopRecorder(recorder);
  } finally {
    releaseStream(stream);
  }

  const blob = new Blob(chunks, { type: RECORDING_MIME_TYPE });

  if (blob.size === 0) {
    throw new Error("No audio was captured, so there is nothing to transcribe.");
  }

  return transcribeBlob(blob);
}

function createRecorder(stream) {
  if (typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(RECORDING_MIME_TYPE)) {
    return new MediaRecorder(stream, { mimeType: RECORDING_MIME_TYPE });
  }

  // Fall back to the browser default container; the blob is still labeled webm
  // for upload, which Whisper accepts as an opus/webm payload.
  return new MediaRecorder(stream);
}

function stopRecorder(recorder) {
  return new Promise((resolve) => {
    if (recorder.state === "inactive") {
      resolve();
      return;
    }

    recorder.addEventListener(
      "stop",
      () => {
        resolve();
      },
      { once: true }
    );

    try {
      recorder.stop();
    } catch (error) {
      resolve();
    }
  });
}

async function transcribeBlob(blob) {
  const apiKey = getOpenAiApiKey();

  if (!apiKey) {
    throw new Error("Add an OpenAI API key in Settings to use Whisper transcription.");
  }

  const form = new FormData();
  form.append("file", blob, "audio.webm");
  form.append("model", WHISPER_MODEL);

  let response;

  try {
    response = await fetch(TRANSCRIPTION_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form
    });
  } catch (error) {
    throw new Error("Could not reach OpenAI to transcribe the recording. Check your connection.");
  }

  if (!response.ok) {
    throw new Error(await extractApiError(response));
  }

  let payload;

  try {
    payload = await response.json();
  } catch (error) {
    throw new Error("OpenAI returned an unreadable transcription response.");
  }

  return String(payload?.text || "").trim();
}

async function extractApiError(response) {
  try {
    const data = await response.json();
    const message = data?.error?.message || data?.error || data?.message;

    if (message) {
      return `OpenAI transcription failed: ${message}`;
    }
  } catch (error) {
    // Fall through to the status-based message below.
  }

  return `OpenAI transcription failed (HTTP ${response.status}).`;
}

function releaseStream(stream) {
  if (!stream) {
    return;
  }

  try {
    stream.getTracks().forEach((track) => track.stop());
  } catch (error) {
    // Ignore: the stream may already be released.
  }
}

function resetRecordingState() {
  recordingState.recorder = null;
  recordingState.stream = null;
  recordingState.chunks = [];
}
