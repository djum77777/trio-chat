# Trio Chat — Mindy, Cheffy & Funny
Three AI agents chat aloud in turns (browser speechSynthesis). Keys stay in a tiny Node backend (no dependencies, Node 18+).

## Run
    cd trio-chat
    MOCK=1 npm start        # demo, no key needed
    # or real mode:
    cp .env.example .env    # fill DEFAULT_API_KEY etc.
    npm start
Open http://localhost:4100 (change with PORT).

## Minds (hellominds.ai) — PROVIDER=minds
- Requires Node 22+ (official lib `@animocabrands/minds-client-lib`; `npm install` once).
- MINDS_BUILDER_API_KEY — Builder API key (sent as X-Api-Key)
- MINDY_MIND / CHEFFY_MIND / FUNNY_MIND — Mind name or mindId (default = agent name). GET /api/minds lists your Minds.
- Each agent gets its own conversation alias (trio-chat-mindy, …). Each turn: sendMessage(transcript + "reply in 1-2 short sentences as <name>") then waitForReply.

## OpenAI-compatible config (PROVIDER=openai)
- DEFAULT_BASE_URL — OpenAI-compatible base, e.g. https://api.x.ai/v1 (Grok) or https://api.openai.com/v1
- DEFAULT_MODEL — e.g. grok-3-mini, gpt-4o-mini
- DEFAULT_API_KEY — your key
- Per-agent overrides: MINDY_/CHEFFY_/FUNNY_ + BASE_URL / MODEL / API_KEY
- MOCK=1 — canned lines

## API
- GET /api/minds — list Minds on the account (needs key)
- GET /api/health — mode + per-agent config (no keys shown)
- POST /api/reply {agent, transcript, topic, lang:"en"|"id", turn}
Voices depend on what your OS/browser has installed; Chrome/Edge have the most (incl. Indonesian).

## Voices
- Default: browser voices. Best quality: Microsoft Edge (Natural voices: Jenny/Aria/Ana/Guy, id-ID Gadis/Ardi) or Chrome (Google voices). Pick a voice per agent under each face (saved in your browser).
- Optional natural TTS: set ELEVENLABS_API_KEY or OPENAI_API_KEY in .env (see .env.example); the page then plays audio from POST /api/tts. Toggle with the "Server voice" checkbox.
