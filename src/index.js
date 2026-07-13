import "dotenv/config";
import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { openDb } from "./storage/db.js";
import { createBoundedCache } from "./core/cache.js";
import { addAllowed } from "./storage/accessRepo.js";
import { registerCommands } from "./bot/commands.js";
import { registerActions } from "./bot/actions.js";
import { registerTextHandler } from "./bot/textHandler.js";
import { registerPhotoHandler } from "./bot/photoHandler.js";

const bot = new Telegraf(config.BOT_TOKEN);
const db = openDb(config);
const cache = createBoundedCache(500);

if (config.OWNER_ID) {
  addAllowed(db, config.OWNER_ID);
}

registerCommands(bot, db, cache);
registerActions(bot, db);
registerTextHandler(bot, db, cache);
registerPhotoHandler(bot, db, cache);

bot.catch((err, ctx) => {
  console.error("Unhandled bot error:", err);
  ctx.reply?.("Что-то пошло не так.").catch(() => {});
});

bot.telegram
  .setMyCommands([
    { command: "find", description: "Найти книгу по описанию" },
    { command: "users", description: "Список доступов (owner)" },
    { command: "allow", description: "Выдать доступ (owner)" },
    { command: "deny", description: "Забрать доступ (owner)" },
    { command: "smtp_test", description: "Проверка SMTP (owner)" },
  ])
  .catch((e) => console.error("setMyCommands failed:", e?.message || e));

bot.launch().catch((e) => {
  console.error("bot.launch() failed:", e?.message || e);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
