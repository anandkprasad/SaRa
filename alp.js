// =========================
// npm install ws mic
// =========================

const WebSocket = require("ws");
const mic = require("mic");
const querystring = require("querystring");
const fs = require("fs");
const { exec } = require("child_process");

// ================= CONFIG =================
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;

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
let stopRequested = false;
let isProcessing = false;
let isSpeaking = false; // 🔑 KEY FLAG

let lastTranscript = "";
let silenceTimer = null;
let recordedFrames = [];

// ================= MISTRAL =================
async function askMistral(userText) {
  console.log("📨 Calling Mistral...");

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
          content:
            "You are SaRA, a concise, calm, and friendly voice assistant."
        },
        { role: "user", content: userText }
      ]
    })
  });

  const data = await response.json();
  return data.choices[0].message.content;
}

// ================= macOS TTS (Female Voice) =================
function speak(text) {
  return new Promise((resolve) => {
    isSpeaking = true;

    const safeText = text.replace(/"/g, "");
    const command = `say -v Samantha -r 175 "${safeText}"`;

    exec(command, () => {
      isSpeaking = false;
      resolve();
    });
  });
}

// ================= AUDIO HELPERS =================
function clearLine() {
  process.stdout.write("\r" + " ".repeat(120) + "\r");
}

function createWavHeader(sampleRate, channels, dataLength) {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

function saveWavFile() {
  if (!recordedFrames.length) return;
  const audioData = Buffer.concat(recordedFrames);
  const header = createWavHeader(SAMPLE_RATE, CHANNELS, audioData.length);
  fs.writeFileSync(
    `recorded_audio_${Date.now()}.wav`,
    Buffer.concat([header, audioData])
  );
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
    // 🔕 IGNORE MIC INPUT WHILE SaRA IS SPEAKING
    if (isSpeaking) return;

    if (ws && ws.readyState === WebSocket.OPEN && !stopRequested) {
      recordedFrames.push(Buffer.from(data));
      ws.send(data);
    }
  });

  stream.on("error", (err) => {
    console.error("Microphone error:", err);
    cleanup();
  });

  micInstance.start();
  console.log("🎙 Speak into your microphone...");
}

// ================= MAIN =================
function run() {
  console.log("🔥 SaRA voice assistant running 🔥");

  ws = new WebSocket(API_ENDPOINT, {
    headers: { Authorization: ASSEMBLYAI_API_KEY }
  });

  ws.on("open", () => {
    console.log("✅ Connected to AssemblyAI");
    startMicrophone();
  });

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.type === "Begin") {
      console.log("🟢 Session started");
      return;
    }

    if (data.type === "Turn") {
      const transcript = (data.transcript || "").trim();
      const formatted = data.turn_is_formatted;

      if (!formatted) {
        lastTranscript = transcript;
        process.stdout.write(`\r…listening: ${transcript}`);

        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          handleFinalTranscript(lastTranscript);
        }, 900);

        return;
      }

      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }

      handleFinalTranscript(transcript);
    }
  });

  ws.on("error", cleanup);
  ws.on("close", cleanup);
}

// ================= FINAL HANDLER =================
async function handleFinalTranscript(text) {
  if (!text || isProcessing || isSpeaking) return;

  console.log("✅ FINAL TRANSCRIPT TRIGGERED");
  clearLine();
  console.log(`👤 You: ${text}`);

  isProcessing = true;
  try {
    const reply = await askMistral(text);
    console.log(`🤖 SaRA: ${reply}\n`);
    await speak(reply); // 🔊 SPEAK RESPONSE
  } catch (err) {
    console.error("Error:", err);
  } finally {
    isProcessing = false;
    lastTranscript = "";
  }
}

// ================= CLEANUP =================
function cleanup() {
  stopRequested = true;
  saveWavFile();

  if (micInstance) micInstance.stop();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "Terminate" }));
    ws.close();
  }

  console.log("🛑 Session ended");
  process.exit(0);
}

process.on("SIGINT", cleanup);

// ================= START =================
run();
