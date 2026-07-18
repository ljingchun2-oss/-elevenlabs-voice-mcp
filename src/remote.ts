import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "..", ".env") });

const { app } = await import("./app.js");

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`elevenlabs-voice-mcp remote server listening on port ${PORT}`);
});
