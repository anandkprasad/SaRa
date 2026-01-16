// =========================
// npm install ws mic
// =========================

const WebSocket = require("ws");
const mic = require("mic");
const querystring = require("querystring");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// ================= CONFIG =================

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = "pNInz6obpgDQGcFmaJgB"; // Rachel (example)

const AUDIO_DIR = "./audio";
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);

// ================= ASSEMBLYAI =================
const CONNECTION_PARAMS = {
  sampleRate: 16000,
  formatTurns: true,
  endOfTurnConfidenceThreshold: 0.7,
  minEndOfTurnSilenceWhenConfident: 160,
  maxTurnSilence: 2400,
  language: "en"
};

const API_ENDPOINT =
  "wss://streaming.assemblyai.com/v3/ws?" +
  querystring.stringify(CONNECTION_PARAMS);

// =========================================

const SAMPLE_RATE = 16000;
const CHANNELS = 1;

let ws = null;
let micInstance = null;
let isProcessing = false;
let isSpeaking = false;
let silenceTimer = null;

// ================= VOICE SANITIZER =================
function sanitizeForSpeech(text) {
  return text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/www\.\S+/gi, "")
    .replace(/[*_~`>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ================= MISTRAL =================
async function askMistral(userText) {
  const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MISTRAL_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "ministral-14b-2512",
      messages: [
        {
          role: "system",
          content: `
You are SaRA, a calm and friendly voice assistant.

Rules:
- Speak in natural spoken English.
- No emojis, markdown, or formatting.
- No links or URLs.
- Keep replies concise and conversational.
- Your output will be spoken aloud.
          `.trim()
        },
        { role: "user", content: userText }
      ]
    })
  });

  const data = await response.json();
  return data.choices[0].message.content;
}

// ================= ELEVENLABS TTS (REST API) =================
async function speak(text) {
  isSpeaking = true;

  const safeText = sanitizeForSpeech(text);
  const filename = path.join(AUDIO_DIR, `tts_${Date.now()}.mp3`);

  console.log("🔊 Speaking with ElevenLabs...");

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text: safeText,
        model_id: "eleven_turbo_v2_5",
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.8
        }
      })
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    isSpeaking = false;
    throw new Error(`ElevenLabs TTS failed: ${errText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filename, buffer);

  return new Promise((resolve) => {
    const player = spawn("afplay", [filename]);
    player.on("exit", () => {
      fs.unlink(filename, () => {});
      isSpeaking = false;
      resolve();
    });
  });
}


// ================= MICROPHONE =================
function startMicrophone() {
  micInstance = mic({
    rate: SAMPLE_RATE.toString(),
    channels: CHANNELS.toString(),
    debug: false
  });

  const stream = micInstance.getAudioStream();

  stream.on("data", (data) => {
    if (isSpeaking) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  stream.on("error", cleanup);

  micInstance.start();
  console.log("🎙 Speak into your microphone...");
}

// ================= MAIN =================
function run() {
  console.log("🔥 SaRA (ElevenLabs Edition) running 🔥");

  ws = new WebSocket(API_ENDPOINT, {
    headers: { Authorization: ASSEMBLYAI_API_KEY }
  });

  ws.on("open", () => {
    console.log("✅ Connected to AssemblyAI");
    startMicrophone();
  });

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.type !== "Turn") return;

    const transcript = (data.transcript || "").trim();
    const formatted = data.turn_is_formatted;

    if (!formatted) {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        handleFinalTranscript(transcript);
      }, 900);
      return;
    }

    if (silenceTimer) clearTimeout(silenceTimer);
    handleFinalTranscript(transcript);
  });

  ws.on("error", cleanup);
  ws.on("close", cleanup);
}

// ================= FINAL HANDLER =================
async function handleFinalTranscript(text) {
  if (!text || isProcessing || isSpeaking) return;

  console.log(`👤 You: ${text}`);
  isProcessing = true;

  try {
    const reply = await askMistral(text);
    console.log(`🤖 SaRA: ${reply}`);
    await speak(reply);
  } catch (err) {
    console.error("Error:", err);
  } finally {
    isProcessing = false;
  }
}

// ================= CLEANUP =================
function cleanup() {
  if (micInstance) micInstance.stop();
  if (ws) ws.close();
  console.log("🛑 Session ended");
  process.exit(0);
}

process.on("SIGINT", cleanup);

// ================= START =================
run();
