# FreeLLMAPI на Railway — чек-лист

Как поднять FreeLLMAPI рядом с ботом и переключить бот на него. Всё, что касается
самого FreeLLMAPI (образ, переменные, пути, порт, первый аккаунт), взято из его
[`docker/README.md`](https://github.com/tashfeenahmed/freellmapi/blob/main/docker/README.md),
[`docs/en/install/01-install.md`](https://github.com/tashfeenahmed/freellmapi/blob/main/docs/en/install/01-install.md)
и [`docs/en/env/02-security-and-keys.md`](https://github.com/tashfeenahmed/freellmapi/blob/main/docs/en/env/02-security-and-keys.md).

## 1. Сервис из Docker-образа
- [ ] В проекте бота: **New → Docker Image** → `ghcr.io/tashfeenahmed/freellmapi:latest`.
- [ ] Имя сервиса, например `freellmapi` — оно попадёт во внутренний адрес (шаг 7).

## 2. `ENCRYPTION_KEY`
- [ ] Сгенерировать один раз: `openssl rand -hex 32` (64 hex-символа).
- [ ] Переменные сервиса: `ENCRYPTION_KEY=<ключ>`, `PORT=3001`.
- [ ] **Не менять после первого старта**: ключи провайдеров хранятся зашифрованными
      этим ключом, с другим ключом их не расшифровать. Сохранить ключ в менеджер паролей.

`PORT=3001` задаётся явно: сервер слушает порт из `PORT` (по умолчанию 3001), и
внутренний адрес бота из шага 7 рассчитан на 3001.

## 3. Volume
- [ ] Подключить Volume к сервису с mount path **`/app/server/data`** — там SQLite
      (`freellmapi.db`) с ключами, моделями и настройками.
- [ ] Volume и `ENCRYPTION_KEY` переживают обновления образа только вместе: новый
      volume = пустая база, новый ключ = нерасшифровываемые ключи.
- Опционально: зашифрованный бэкап базы — `FREEAPI_DB_BACKUP_URL` (+ `FREEAPI_DB_BACKUP_TOKEN`)
  или `FREEAPI_DB_BACKUP_PATH`, ключ — `FREEAPI_DB_BACKUP_KEY` (по умолчанию `ENCRYPTION_KEY`).

## 4. Первый аккаунт, потом убрать публичный домен
- [ ] Settings → Networking → **Generate Domain**, открыть дашборд.
- [ ] Сразу создать аккаунт (email + пароль). Сервер доступен не только с той же
      машины, поэтому форма попросит **одноразовый setup code** — он печатается в
      логах деплоя, пока нет ни одного аккаунта. Пока аккаунт не создан, его может
      занять любой, кто нашёл домен.
      Альтернатива без этого окна: переменная `FREEAPI_CONFIG_JSON` с
      `{"admin": {"email": "...", "password": "минимум 8 символов"}}` — аккаунт
      создаётся до старта HTTP. После первого запуска переменную лучше удалить:
      в ней пароль открытым текстом.
- [ ] После настройки (шаги 5–6) **удалить публичный домен**. API защищён только
      unified-ключом, а боту домен не нужен — он ходит по внутренней сети.
- Цена: без домена нет ни дашборда, ни локальных `scripts/llm-smoke.js` /
  `llm-compare.js`. Для настройки домен можно временно вернуть.
- Забыл пароль: на логине **Forgot password? → Send reset code**, код (15 минут) — в логах.

## 5. Ключи провайдеров
- [ ] Дашборд → **Keys**: добавить ключи Google AI Studio, Groq, OpenRouter, Mistral.
- [ ] Скопировать **unified-ключ** из шапки страницы Keys (`freellmapi-…`) — это
      `LLM_API_KEY` бота. Ключ провайдера (например, `AIza…`) туда не подходит:
      роутер ответит `401 Invalid API key`.
- [ ] Проверить порядок **Fallback Chain** (профиль по умолчанию = `LLM_MODEL=auto`):
      лучшие модели — первыми. В сравнении 2026-10-06, когда минутная квота
      `gemini-3.5-flash` кончалась, текст уходил на `nemotron-3-super-120b` (OpenRouter):
      медленнее в 2–4 раза, один раз вернул автора без названия (бот это теперь
      ловит и уходит на Gemini).

## 6. Vision-профиль
- [ ] Создать профиль (fallback chain) **только из моделей с поддержкой картинок**,
      в ручном порядке (первой — Gemini 3.5 Flash).
- [ ] Бот: `LLM_VISION_MODEL=auto:<имя профиля>` (сейчас `auto:vision`).
- Модель без поддержки картинок отвечает 400 — бот тогда уходит на Gemini, но лучше,
  чтобы таких моделей в профиле не было.
- Бот шлёт для обложки `reasoning_effort: minimal` (у Gemini это `thinkingBudget: 0`).
  Модель, которая так не умеет, отвечает 400, и роутер молча берёт следующую модель
  цепочки. Если в `GEMINI_DEBUG` обложки обслуживает не та модель — попробовать
  `LLM_COVER_REASONING_EFFORT=` (пусто, параметр не отправляется).

## 7. Переменные бота
- [ ] В сервисе бота:
  ```
  LLM_PROVIDER=freellmapi_with_fallback
  LLM_BASE_URL=http://freellmapi.railway.internal:3001/v1
  LLM_API_KEY=freellmapi-...
  LLM_MODEL=auto
  LLM_VISION_MODEL=auto:vision
  ```
  `freellmapi` в адресе — имя сервиса из шага 1. `GEMINI_API_KEY` оставить: это фолбэк.
- `LLM_BASE_URL` должен заканчиваться на **`/v1`**: без него роутер отдаёт HTML
  дашборда (бот это распознаёт и уходит на Gemini, но роутер тогда не используется).
- Внутренняя сеть Railway: сервер FreeLLMAPI по умолчанию слушает `::` (IPv4 и IPv6),
  так что `*.railway.internal` доступен без доп. настроек.
- Таймауты по умолчанию: текст 12 с (`LLM_TIMEOUT_MS`), картинки 25 с (`LLM_VISION_TIMEOUT_MS`).

## 8. Проверка после деплоя
- [ ] Логи бота при старте: нет строк `[llm] ... using direct Gemini only` и
      `LLM_BASE_URL path is ...`.
- [ ] С `GEMINI_DEBUG=1` отправить боту текст и фото (как владелец): в ответе
      `via=freellmapi model=google/...`, а не `via=direct`.
- [ ] Во время работы следить за `[llm] ... -> direct Gemini: <причина>` — так видно,
      когда и почему роутер не справился (401 — ключ, 404 — адрес, 429 — квоты, timeout).
