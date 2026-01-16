// =========================
// npm install ws mic node-fetch
// =========================

const WebSocket = require("ws");
const mic = require("mic");
const querystring = require("querystring");
const { exec, spawn } = require("child_process");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ================= CONFIG =================
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

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

let ws;
let micInstance;
let micEnabled = true;

let isProcessing = false;
let isSpeaking = false;

// ================= MEMORY =================
const conversation = [];

// ================= VISION INTENT =================
const VISION_TRIGGERS = [
  "look at me",
  "look at this",
  "can you see me",
  "what do you see"
];

function needsVision(text) {
  return VISION_TRIGGERS.some(t => text.toLowerCase().includes(t));
}

// ================= VOICE SANITIZER =================
function sanitizeForSpeech(text) {
  return text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[*_~`>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ================= MISTRAL =================
async function askMistral(messages) {
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
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
You are SaRA, a calm, grounded voice assistant.
You can receive visual descriptions from a camera when the user asks you to look.
Treat visual descriptions as perception, not imagination.
Do not mention limitations unless asked.
Respond briefly in spoken English.
          `
        },
        ...messages
      ]
    })
  });

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "I didn't catch that.";
}

// ================= VISION =================
function runVision() {
  return new Promise((resolve, reject) => {
    const py = spawn("python3", ["app.py"]);
    let output = "";
    let error = "";

    py.stdout.on("data", d => (output += d.toString()));
    py.stderr.on("data", d => (error += d.toString()));

    py.on("close", code => {
      if (code !== 0 || error) reject(error || "Vision failed");
      else resolve(output.trim());
    });
  });
}

// ================= TTS =================
function speak(text) {
  return new Promise(resolve => {
    isSpeaking = true;
    micEnabled = false; // 🔒 gate mic

    exec(`say -v Samantha -r 175 "${text.replace(/"/g, "")}"`, () => {
      // tail-echo guard
      setTimeout(() => {
        micEnabled = true;
        isSpeaking = false;
        resolve();
      }, 600);
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

  stream.on("data", data => {
    if (!micEnabled) return;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  micInstance.start();
  console.log("🎙 Speak...");
}

// ================= FINAL HANDLER =================
async function handleFinalTranscript(text) {
  if (!text) return;
  if (isProcessing) return;

  // drop single-word / garbage turns
  if (text.trim().split(" ").length < 2) return;

  isProcessing = true;
  console.log(`👤 You: ${text}`);

  try {
    let userMessage = text;

    if (needsVision(text)) {
      console.log("👁 SaRA is looking...");
      const vision = await runVision();
      console.log("👁 Vision:", vision);

      userMessage = `
User said: "${text}"
Camera perception: ${vision}
      `;
    }

    conversation.push({ role: "user", content: userMessage });

    const reply = await askMistral(conversation.slice(-20));

    conversation.push({ role: "assistant", content: reply });

    const spoken = sanitizeForSpeech(reply);
    console.log(`🤖 SaRA: ${spoken}`);
    await speak(spoken);

  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    isProcessing = false;
  }
}

// ================= MAIN =================
function run() {
  ws = new WebSocket(API_ENDPOINT, {
    headers: { Authorization: ASSEMBLYAI_API_KEY }
  });

  ws.on("open", startMicrophone);

  ws.on("message", msg => {
    const data = JSON.parse(msg);
    if (data.type !== "Turn") return;

    if (data.confidence !== undefined && data.confidence < 0.85) return;

    const transcript = (data.transcript || "").trim();
    if (data.end_of_turn === true) {
      handleFinalTranscript(transcript);
    }
  });

  ws.on("close", () => console.log("🔌 WS closed"));
  ws.on("error", err => console.error("❌ WS error", err));
}

run();
