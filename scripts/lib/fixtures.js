// Cover photos from fixtures/, loaded the way the bot receives them:
// Telegram delivers a photo as a JPEG scaled to 1280px on the longest side,
// so PNG screenshots and full-size camera shots are converted first
// (macOS `sips`) - otherwise the router/Gemini would see a 4032px original
// that the bot never gets.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const FIXTURES_DIR = fileURLToPath(new URL("../../fixtures/", import.meta.url));

const IMAGE_EXT = /\.(jpe?g|png|webp|heic)$/i;
const TELEGRAM_MAX_SIDE = 1280;

export function listCoverFixtures() {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => IMAGE_EXT.test(f))
    .sort()
    .map((f) => path.join(FIXTURES_DIR, f));
}

export function loadAsTelegramPhoto(file) {
  const out = path.join(os.tmpdir(), "tg-books-finder-fixtures", `${path.basename(file)}.jpg`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    execFileSync(
      "sips",
      ["-s", "format", "jpeg", "-s", "formatOptions", "85", "-Z", String(TELEGRAM_MAX_SIDE), file, "--out", out],
      { stdio: "ignore" }
    );
    return fs.readFileSync(out);
  } catch {
    console.warn(`[fixtures] sips failed or missing - sending ${path.basename(file)} unconverted`);
    return fs.readFileSync(file);
  }
}
