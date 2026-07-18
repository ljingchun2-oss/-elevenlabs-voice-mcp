import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { exec } from "node:child_process";
import {
  textToSpeech,
  listVoices,
  readVoiceSettings,
  SPEAK_INPUT_SCHEMA,
  SPEAK_DESCRIPTION_PREFIX,
} from "./elevenlabs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "..", ".env") });

const API_KEY = process.env.ELEVENLABS_API_KEY;
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
const OUTPUT_DIR = path.join(__dirname, "..", "output");
const AUTO_PLAY = process.env.AUTO_PLAY !== "false";

if (!API_KEY) {
  console.error("ELEVENLABS_API_KEY is not set in .env");
  process.exit(1);
}

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function playAudio(filePath: string) {
  exec(`cmd /c start "" "${filePath}"`, (err) => {
    if (err) console.error("Failed to play audio:", err);
  });
}

const server = new Server(
  { name: "elevenlabs-voice-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "speak",
      description:
        SPEAK_DESCRIPTION_PREFIX +
        "\n\nThe generated audio is saved as an mp3 file and played out loud on the user's machine.",
      inputSchema: {
        ...SPEAK_INPUT_SCHEMA,
        properties: {
          ...SPEAK_INPUT_SCHEMA.properties,
          play: {
            type: "boolean",
            description: "Whether to auto-play the generated audio.",
            default: true,
          },
        },
      },
    },
    {
      name: "list_voices",
      description: "List available ElevenLabs voices and their voice IDs.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "list_voices") {
    const voices = await listVoices(API_KEY as string);
    return { content: [{ type: "text", text: voices }] };
  }

  if (name === "speak") {
    const text = String(args?.text ?? "");
    const voiceId = String(args?.voice_id ?? DEFAULT_VOICE_ID);
    const modelId = String(args?.model_id ?? "eleven_v3");
    const shouldPlay = args?.play !== false && AUTO_PLAY;
    const voiceSettings = readVoiceSettings(args);

    if (!text) throw new Error("text is required");
    if (!voiceId)
      throw new Error(
        "No voice_id provided and no ELEVENLABS_VOICE_ID set in .env"
      );

    const audio = await textToSpeech(
      API_KEY as string,
      text,
      voiceId,
      modelId,
      voiceSettings
    );
    const fileName = `speech-${Date.now()}.mp3`;
    const filePath = path.join(OUTPUT_DIR, fileName);
    fs.writeFileSync(filePath, audio);

    if (shouldPlay) playAudio(filePath);

    return {
      content: [
        {
          type: "text",
          text: `Spoke "${text}" using voice ${voiceId}. Saved to ${filePath}${
            shouldPlay ? " and played it." : "."
          }`,
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("elevenlabs-voice-mcp server running on stdio");
