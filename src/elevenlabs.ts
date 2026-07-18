export interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
}

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 20000;

export async function textToSpeech(
  apiKey: string,
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
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text,
            model_id: modelId,
            voice_settings: voiceSettings,
          }),
          signal: controller.signal,
        }
      );
      clearTimeout(timeout);

      if (!res.ok) {
        const errText = await res.text();
        // Retrying won't fix auth/validation errors, only transient server-side ones.
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
            `Network error reaching ElevenLabs after ${attempt} attempt(s) (${cause ?? (err as Error).name}). ` +
              `Connection to api.elevenlabs.io appears unstable — retry in a moment.`
          );
        }
        throw err;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function listVoices(apiKey: string): Promise<string> {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs API error (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { voices: { voice_id: string; name: string }[] };
  return data.voices.map((v) => `${v.name}: ${v.voice_id}`).join("\n");
}

export const SPEAK_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    text: {
      type: "string",
      description:
        "The text to speak, written for natural speech (pauses via punctuation, optional [tag] emotion/delivery markers).",
    },
    voice_id: {
      type: "string",
      description: "ElevenLabs voice ID to use. Defaults to the configured voice if omitted.",
    },
    model_id: {
      type: "string",
      description:
        "ElevenLabs model id. eleven_v3 supports emotion tags and sounds most natural; eleven_multilingual_v2 is more literal/stable but flatter.",
      default: "eleven_v3",
    },
    stability: {
      type: "number",
      description:
        "0-1. Lower = more expressive and varied delivery (less monotone), higher = more consistent/flat. Default favors natural variation over consistency.",
      default: 0.4,
    },
    similarity_boost: {
      type: "number",
      description: "0-1. How closely to stick to the cloned voice's timbre.",
      default: 0.8,
    },
    style: {
      type: "number",
      description:
        "0-1. Emotional exaggeration / style intensity. Higher = more dramatic and emotive, 0 = neutral narration.",
      default: 0.45,
    },
  },
  required: ["text"],
};

export const SPEAK_DESCRIPTION_PREFIX =
  "Convert text to speech using a cloned ElevenLabs voice. Use this when the user asks you to say something out loud or reply with voice.\n\n" +
  "For natural, expressive delivery: write the text the way a person would actually speak it, not like formal written prose. Use commas, ellipses (…) and em dashes for breathing pauses; keep sentences short-ish; vary rhythm. " +
  "The default model (eleven_v3) understands inline emotion/delivery tags in square brackets placed right before the words they affect, e.g. [laughs], [sighs], [whispers], [excited], [curious], [sarcastic], [pause]. Use them sparingly where they'd naturally fit — don't overdo it.";

export function readVoiceSettings(args: Record<string, unknown> | undefined): VoiceSettings {
  return {
    stability: typeof args?.stability === "number" ? args.stability : 0.4,
    similarity_boost:
      typeof args?.similarity_boost === "number" ? args.similarity_boost : 0.8,
    style: typeof args?.style === "number" ? args.style : 0.45,
    use_speaker_boost: true,
  };
}
