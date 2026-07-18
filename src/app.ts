import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import crypto from "node:crypto";
import { textToSpeech, listVoices, SPEAK_DESCRIPTION_PREFIX } from "./elevenlabs.js";

const API_KEY = process.env.ELEVENLABS_API_KEY;
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
const PATH_TOKEN = process.env.MCP_PATH_TOKEN;
const AUDIO_TTL_MS = 60 * 60 * 1000; // 1 hour, only used by the in-memory fallback store
const USE_BLOB_STORAGE = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

if (!API_KEY) throw new Error("ELEVENLABS_API_KEY is not set");
if (!PATH_TOKEN) throw new Error("MCP_PATH_TOKEN is not set — refusing to start without a URL secret");

// Fallback store for environments without Vercel Blob (local dev / other hosts).
// Not safe to rely on across serverless invocations that may land on different instances.
interface StoredAudio {
  buffer: Buffer;
  createdAt: number;
}
const audioStore = new Map<string, StoredAudio>();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of audioStore) {
    if (now - entry.createdAt > AUDIO_TTL_MS) audioStore.delete(id);
  }
}, 10 * 60 * 1000).unref();

async function storeAudio(audio: Buffer, baseUrl: string): Promise<string> {
  const fileName = `speech-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp3`;

  if (USE_BLOB_STORAGE) {
    const { put } = await import("@vercel/blob");
    const blob = await put(fileName, audio, {
      access: "public",
      contentType: "audio/mpeg",
      addRandomSuffix: true,
    });
    return blob.url;
  }

  const id = crypto.randomBytes(8).toString("hex");
  audioStore.set(id, { buffer: audio, createdAt: Date.now() });
  return `${baseUrl}/mcp/${PATH_TOKEN}/audio/${id}.mp3`;
}

function getServer(baseUrl: string) {
  const server = new McpServer(
    { name: "elevenlabs-voice-mcp", version: "1.0.0" },
    { capabilities: {} }
  );

  server.registerTool(
    "speak",
    {
      description:
        SPEAK_DESCRIPTION_PREFIX +
        "\n\nThis returns a URL to the generated mp3 — tell the user to tap/open the link to hear it, playback does not happen automatically.",
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

      const audio = await textToSpeech(API_KEY as string, text, voiceId, model_id as string, {
        stability: stability as number,
        similarity_boost: similarity_boost as number,
        style: style as number,
        use_speaker_boost: true,
      });

      const url = await storeAudio(audio, baseUrl);

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
      const voices = await listVoices(API_KEY as string);
      return { content: [{ type: "text", text: voices }] };
    }
  );

  return server;
}

export const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.type("text/plain").send("elevenlabs-voice-mcp is running");
});

const router = express.Router();

router.post("/", async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  try {
    const server = getServer(baseUrl);
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

// Only used when Vercel Blob isn't configured (local dev / other hosts).
router.get("/audio/:file", (req, res) => {
  const id = req.params.file.replace(/\.mp3$/, "");
  const entry = audioStore.get(id);
  if (!entry) {
    res.status(404).type("text/plain").send("Not found or expired");
    return;
  }
  res.set("Content-Type", "audio/mpeg");
  res.set("Content-Disposition", "inline");
  res.send(entry.buffer);
});

app.use(`/mcp/${PATH_TOKEN}`, router);
