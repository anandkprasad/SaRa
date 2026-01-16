// =========================
// npm install ws mic
// =========================

const WebSocket = require("ws");
const mic = require("mic");
const querystring = require("querystring");
const { exec, spawn } = require("child_process");

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

let ws = null;
let micInstance = null;
let isProcessing = false;
let isSpeaking = false;
let silenceTimer = null;

// ================= VISION INTENT =================
const VISION_TRIGGERS = [
  "look at me",
  "look at this",
  "take a look",
  "can you see",
  "what do you see",
  "see this",
  "check this out",
  "look here"
];

function needsVision(text) {
  const lower = text.toLowerCase();
  return VISION_TRIGGERS.some(t => lower.includes(t));
}

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
Respond in plain spoken English.
Do not use emojis or formatting.
Keep answers short and conversational.
          `.trim()
        },
        { role: "user", content: userText }
      ]
    })
  });

  const data = await response.json();
  return data.choices[0].message.content;
}

// ================= VISION PROCESS =================
function runVision() {
  return new Promise((resolve, reject) => {
    const py = spawn("python3", ["app.py"]);

    let output = "";
    let error = "";

    py.stdout.on("data", data => {
      output += data.toString();
    });

    py.stderr.on("data", data => {
      error += data.toString();
    });

    py.on("close", code => {
      if (code !== 0 || error) {
        reject(error || "Vision process failed");
      } else {
        resolve(output.trim());
      }
    });
  });
}

// ================= macOS TTS =================
function speak(text) {
  return new Promise(resolve => {
    isSpeaking = true;
    exec(`say -v Samantha -r 175 "${text.replace(/"/g, "")}"`, () => {
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

  stream.on("data", data => {
    if (!isSpeaking && ws?.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  micInstance.start();
  console.log("🎙 Speak...");
}

// ================= FINAL HANDLER =================
async function handleFinalTranscript(text) {
  if (!text || isProcessing || isSpeaking) return;

  console.log(`👤 You: ${text}`);
  isProcessing = true;

  try {
    let prompt = text;

    if (needsVision(text)) {
      console.log("👁 SaRA is looking...");
      const vision = await runVision();
      console.log("👁 Vision:", vision);

      prompt = `
User said: "${text}"
Camera sees: ${vision}
Respond naturally based on what you see.
      `.trim();
    }

    const reply = await askMistral(prompt);
    const spoken = sanitizeForSpeech(reply);

    console.log(`🤖 SaRA: ${spoken}`);
    await speak(spoken);

  } catch (err) {
    console.error("Error:", err);
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

    const transcript = (data.transcript || "").trim();
    const formatted = data.turn_is_formatted;

    if (!formatted) {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => handleFinalTranscript(transcript), 900);
    } else {
      clearTimeout(silenceTimer);
      handleFinalTranscript(transcript);
    }
  });
}

run();
