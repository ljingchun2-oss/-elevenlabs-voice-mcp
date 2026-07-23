import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import crypto from "node:crypto";

const API_KEY = process.env.ELEVENLABS_API_KEY;
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
const PATH_TOKEN = process.env.MCP_PATH_TOKEN;

if (!API_KEY) throw new Error("ELEVENLABS_API_KEY is not set");
if (!PATH_TOKEN) throw new Error("MCP_PATH_TOKEN is not set — refusing to start without a URL secret");

interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
}

const MAX_ATTEMPTS = 2;
const REQUEST_TIMEOUT_MS = 120000;

async function textToSpeech(
  text: string,
  voiceId: string,
  modelId: string,
  voiceSettings: VoiceSettings
): Promise<Buffer> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: {
          "xi-api-key": API_KEY as string,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({ text, model_id: modelId, voice_settings: voiceSettings }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const errText = await res.text();
        if (res.status < 500 || attempt === MAX_ATTEMPTS) {
          throw new Error(`ElevenLabs API error (${res.status}): ${errText}`);
        }
        lastError = new Error(`ElevenLabs API error (${res.status}): ${errText}`);
        continue;
      }

      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;
      const cause = (err as { cause?: { code?: string } })?.cause?.code;
      const isNetworkError =
        cause === "UND_ERR_CONNECT_TIMEOUT" ||
        cause === "ECONNRESET" ||
        cause === "ETIMEDOUT" ||
        (err as Error)?.name === "AbortError";
      if (!isNetworkError || attempt === MAX_ATTEMPTS) {
        if (isNetworkError) {
          throw new Error(
            `Network error reaching ElevenLabs after ${attempt} attempt(s) (${cause ?? (err as Error).name}). Retry in a moment.`
          );
        }
        throw err;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function listVoices(): Promise<string> {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": API_KEY as string },
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs API error (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { voices: { voice_id: string; name: string }[] };
  return data.voices.map((v) => `${v.name}: ${v.voice_id}`).join("\n");
}

async function storeAudio(audio: Buffer): Promise<string> {
  const fileName = `speech-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp3`;
  const { put } = await import("@vercel/blob");
  const blob = await put(fileName, audio, {
    access: "public",
    contentType: "audio/mpeg",
    addRandomSuffix: true,
  });
  return blob.url;
}

const SPEAK_DESCRIPTION =
  "Convert text to speech using a cloned ElevenLabs voice. Use this when the user asks you to say something out loud or reply with voice.\n\n" +
  "Before calling this tool, act as a voice-performance script transliterator: rewrite the plain text you want spoken into a script eleven_v3 can perform, not something that sounds read aloud from a page.\n\n" +
  "Core principle: a 'living' feel comes from imperfection, not from piling on emotion. The goal is to sound like someone thinking out loud in the moment, not someone reading text that was already written.\n\n" +
  "Required techniques:\n" +
  "1. Real speech-flow imperfections (the most important one): self-interruption/addition with an em dash —; a thinking pause with an ellipsis … placed right before the word being weighed, not at the end of a sentence; a mid-sentence correction, e.g. \"我觉得这个…不对，应该说是\"; keep filler/connective words like 那个、就是、其实、反正 and incomplete clauses. 2-4 of these per passage is enough — more than that reads as stammering.\n" +
  "2. Sparse emotion/delivery tags in square brackets: one every 2-4 sentences, several tag-free sentences in a row is normal and correct. Place a tag right before the sentence it affects. Only add one where the emotion actually shifts, never where it's just continuing. Never stack more than 2 tags together. Available tags — emotion: [curious] [excited] [hesitant] [sarcastic] [warm] [tired]; delivery: [whispers] [shouts] [rushed] [slowly]; reactions: [laughs] [sighs] [clears throat] [exhales]. Tags must fit the voice's character (don't give a serious voice [giggles], don't give a calm voice [shouts]).\n" +
  "3. Design an emotional arc across the whole passage — opening, a turn partway through, and a landing — with three genuinely different emotional beats. One flat emotion the whole way through immediately reads as a machine.\n" +
  "4. Chinese-specific emphasis (Chinese has no capitalization to lean on): broken-up emphasis like \"这个、真的、不行\"; ending particles like 啊/吧/嘛/欸/呢; repeating the key word, e.g. \"很难，是真的很难\"; short rapid-fire sentences for urgency, longer sentences to relax the pace.\n" +
  "5. Segmenting: keep each single call's text to roughly 100-150 Chinese characters. If the content is longer than that, break it at an emotional turning point — not by mechanically chopping at a character count — into 段1, 段2, ... and call this tool once per segment, each segment independently satisfying all of the above (its own complete opening/turn/landing arc).\n\n" +
  "Hard constraints: do not use SSML break tags — control pacing only through punctuation and sentence structure. If the user's original line is very short, it's fine to naturally expand it a little (more hesitation, particles, a pause) to give v3 enough to work with, but don't robotically pad it just to hit a length.\n\n" +
  "This returns a URL to the generated mp3 — tell the user to tap/open the link to hear it, playback does not happen automatically. For multi-segment content, call the tool once per segment and share all the resulting links in order.";

function getServer() {
  const server = new McpServer(
    { name: "elevenlabs-voice-mcp", version: "1.0.0" },
    { capabilities: {} }
  );

  server.registerTool(
    "speak",
    {
      description: SPEAK_DESCRIPTION,
      inputSchema: {
        text: z.string().describe(
          "The text to speak, written for natural speech (pauses via punctuation, optional [tag] emotion/delivery markers)."
        ),
        voice_id: z
          .string()
          .optional()
          .describe("ElevenLabs voice ID to use. Defaults to the configured voice if omitted."),
        model_id: z
          .string()
          .optional()
          .default("eleven_v3")
          .describe(
            "ElevenLabs model id. eleven_v3 supports emotion tags and sounds most natural; eleven_multilingual_v2 is more literal/stable but flatter."
          ),
        stability: z
          .number()
          .optional()
          .default(0.4)
          .describe("0-1. Lower = more expressive/varied, higher = more consistent/flat."),
        similarity_boost: z
          .number()
          .optional()
          .default(0.8)
          .describe("0-1. How closely to stick to the cloned voice's timbre."),
        style: z
          .number()
          .optional()
          .default(0.45)
          .describe("0-1. Emotional exaggeration / style intensity."),
      },
    },
    async ({ text, voice_id, model_id, stability, similarity_boost, style }) => {
      const voiceId = voice_id || DEFAULT_VOICE_ID;
      if (!voiceId) throw new Error("No voice_id provided and no default voice configured");

      const audio = await textToSpeech(text, voiceId, model_id as string, {
        stability: stability as number,
        similarity_boost: similarity_boost as number,
        style: style as number,
        use_speaker_boost: true,
      });

      const url = await storeAudio(audio);

      return {
        content: [
          {
            type: "text",
            text: `Generated speech for "${text}". Open this link to listen: ${url}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "list_voices",
    { description: "List available ElevenLabs voices and their voice IDs.", inputSchema: {} },
    async () => {
      const voices = await listVoices();
      return { content: [{ type: "text", text: voices }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.type("text/plain").send("elevenlabs-voice-mcp is running");
});

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const server = getServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

router.get("/", (_req, res) => {
  res.writeHead(405).end(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null })
  );
});

router.delete("/", (_req, res) => {
  res.writeHead(405).end(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null })
  );
});

app.use(`/mcp/${PATH_TOKEN}`, router);

export default app;
