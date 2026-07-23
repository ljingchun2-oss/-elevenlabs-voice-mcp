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
  "Before calling this tool, act as a voice-performance script transliterator: rewrite the plain text you want spoken into a script eleven_v3 can perform, not something that sounds read aloud from a page.\n\n" +
  "Core principle: a 'living' feel comes from imperfection, not from piling on emotion. The goal is to sound like someone thinking out loud in the moment, not someone reading text that was already written.\n\n" +
  "Required techniques:\n" +
  "1. Real speech-flow imperfections (the most important one): self-interruption/addition with an em dash —; a thinking pause with an ellipsis … placed right before the word being weighed, not at the end of a sentence; a mid-sentence correction, e.g. \"我觉得这个…不对，应该说是\"; keep filler/connective words like 那个、就是、其实、反正 and incomplete clauses. 2-4 of these per passage is enough — more than that reads as stammering.\n" +
  "2. Sparse emotion/delivery tags in square brackets: one every 2-4 sentences, several tag-free sentences in a row is normal and correct. Place a tag right before the sentence it affects. Only add one where the emotion actually shifts, never where it's just continuing. Never stack more than 2 tags together. Available tags — emotion: [curious] [excited] [hesitant] [sarcastic] [warm] [tired]; delivery: [whispers] [shouts] [rushed] [slowly]; reactions: [laughs] [sighs] [clears throat] [exhales]. Tags must fit the voice's character (don't give a serious voice [giggles], don't give a calm voice [shouts]).\n" +
  "3. Design an emotional arc across the whole passage — opening, a turn partway through, and a landing — with three genuinely different emotional beats. One flat emotion the whole way through immediately reads as a machine.\n" +
  "4. Chinese-specific emphasis (Chinese has no capitalization to lean on): broken-up emphasis like \"这个、真的、不行\"; ending particles like 啊/吧/嘛/欸/呢; repeating the key word, e.g. \"很难，是真的很难\"; short rapid-fire sentences for urgency, longer sentences to relax the pace.\n\n" +
  "Hard constraints: the text you pass to this tool should be at least ~250 characters — v3 gets unstable on very short inputs, so if the user's original line is short, naturally expand it (more hesitation, particles, pauses) while keeping the original meaning, rather than robotically repeating it. Do not use SSML break tags — control pacing only through punctuation and sentence structure.";

export function readVoiceSettings(args: Record<string, unknown> | undefined): VoiceSettings {
  return {
    stability: typeof args?.stability === "number" ? args.stability : 0.4,
    similarity_boost:
      typeof args?.similarity_boost === "number" ? args.similarity_boost : 0.8,
    style: typeof args?.style === "number" ? args.style : 0.45,
    use_speaker_boost: true,
  };
}
