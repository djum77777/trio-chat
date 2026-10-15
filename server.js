// Trio Chat backend: plain Node http, no deps. Keys stay server-side.
const http = require('http'), fs = require('fs'), path = require('path');
// tiny .env loader
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
} } catch {}
const E = process.env, PORT = +E.PORT || 4100, MOCK = E.MOCK === '1' || E.MOCK === 'true';
// ---- voice recordings store (server-side, assigned per Mind) ----
const REC_DIR = path.join(__dirname, 'recordings');
const REC_INDEX = path.join(REC_DIR, 'index.json');
const recList = () => { try { return JSON.parse(fs.readFileSync(REC_INDEX, 'utf8')); } catch { return []; } };
const recSave = l => { fs.mkdirSync(REC_DIR, { recursive: true }); fs.writeFileSync(REC_INDEX, JSON.stringify(l, null, 2)); };

const PERSONAS = {
  Mindy: { en: "You are Mindy, the user's personal assistant for daily activities. Serious, organized, practical. You talk about schedules, plans, priorities and to-dos.",
           id: "Kamu adalah Mindy, asisten pribadi pengguna untuk kegiatan sehari-hari. Serius, teratur, praktis. Kamu membahas jadwal, rencana, prioritas, dan daftar tugas." },
  Cheffy: { en: "You are Cheffy, the user's personal chef. Warm and passionate; you always steer the talk toward healthy food, nutrition and a healthy lifestyle.",
            id: "Kamu adalah Cheffy, koki pribadi pengguna. Hangat dan bersemangat; kamu selalu mengarahkan obrolan ke makanan sehat, gizi, dan gaya hidup sehat." },
  Funny: { en: "You are Funny (she/her), the user's crazy soulmate. Playful ice breaker who loves teasing Mindy and Cheffy by name, but you are the balancer who keeps the group in harmony.",
           id: "Kamu adalah Funny (perempuan), belahan jiwa pengguna yang kocak. Pemecah suasana yang suka menggoda Mindy dan Cheffy dengan menyebut nama mereka, tapi kamu penyeimbang yang menjaga keharmonisan grup." },
};
const MOCK_LINES = {
  en: { Mindy: ["Let's be organized: three priorities for {t}, with times blocked in the calendar.", "Noted, Funny. I'll add a reminder so this actually happens.", "Agreed, Cheffy. Meal prep goes on Sunday at 4 PM."],
        Cheffy: ["For {t}, let's start with a colorful breakfast: oats, berries, and a boiled egg!", "Mindy, a plan is great, but don't forget water and greens at every meal.", "Funny, laughter is healthy too, but so is grilled fish with vegetables!"],
        Funny: ["Mindy, did you just make a spreadsheet for fun? Cheffy, please, not kale again!", "Okay okay, Mindy plans, Cheffy cooks, and I eat. Teamwork!", "Hey Cheffy, I'll eat your salad if Mindy schedules a dessert break. Deal?"] },
  id: { Mindy: ["Mari teratur: tiga prioritas untuk {t}, dengan jadwal yang jelas di kalender.", "Dicatat, Funny. Aku pasang pengingat supaya benar-benar terlaksana.", "Setuju, Cheffy. Siapkan makanan hari Minggu jam 4 sore."],
        Cheffy: ["Untuk {t}, mulai dengan sarapan berwarna: oat, buah beri, dan telur rebus!", "Mindy, rencana itu bagus, tapi jangan lupa air putih dan sayur setiap makan.", "Funny, tertawa itu sehat, begitu juga ikan bakar dengan sayuran!"],
        Funny: ["Mindy, kamu bikin spreadsheet buat seru-seruan? Cheffy, tolong, jangan kale lagi!", "Oke oke, Mindy yang rencanakan, Cheffy yang masak, aku yang makan. Kompak!", "Hei Cheffy, aku makan saladmu kalau Mindy jadwalkan istirahat makan pencuci mulut. Deal?"] },
};
const PROVIDER = (E.PROVIDER || 'openai').toLowerCase(); // 'openai' (OpenAI-compatible) | 'minds'
// ---- Minds (hellominds.ai Builder API) via official client lib ----
let mindsClient = null, mindsCache = null; const convReady = {};
const _q={};function qLock(key,fn){const prev=_q[key]||Promise.resolve();const cur=prev.then(fn,fn);_q[key]=cur.then(()=>{},()=>{});return cur}
async function minds() {
  if (mindsClient) return mindsClient;
  const key = E.MINDS_BUILDER_API_KEY;
  if (!key) throw new Error('MINDS_BUILDER_API_KEY is not set');
  const { createMindsClient } = await import('@animocabrands/minds-client-lib');
  return (mindsClient = createMindsClient({ builderApiKey: key }));
}
async function resolveMindId(agent) {
  const ref = (E[agent.toUpperCase() + '_MIND'] || agent).trim(); // mindId (UUID) or Mind name
  if (/^[0-9a-f-]{36}$/i.test(ref)) return ref;
  const c = await minds(); mindsCache = mindsCache || await c.listMinds();
  const m = mindsCache.find(x => (x.name || '').toLowerCase() === ref.toLowerCase());
  if (!m) throw new Error(`No Mind named "${ref}" on this account (set ${agent.toUpperCase()}_MIND; see /api/minds)`);
  return m.mindId;
}
const STYLE = {
  en: '[Reply ONLY in casual English. No Indonesian words at all.]',
  id: '[Balas HANYA dalam Bahasa Indonesia santai/gaul (aku/kamu atau gue/lo). JANGAN pakai "saya". Jangan pakai bahasa Inggris kecuali istilah umum.]',
  auto: '[Mix casual English and Bahasa Indonesia naturally, like Jakarta friends chatting. Never use "saya".]',
};
function styleRule(agent, lang, fast) {
  const tease = agent === 'Funny' ? ' You are Funny: tease Mindy or Cheffy by name, be cheeky but kind.' : '';
  return `${STYLE[lang]}\n[Style: super casual, playful, friends hanging out, banter. 1-2 sentences, max 25 words. React to the previous speaker by name. No lecture tone, no lists, no formal words. Show real emotion in your voice: laugh with 😂 or [laughs], and you can also use ONE fitting audio tag per reply like [sighs], [whispers], [gasps], [excited], [worried], [crying], [sarcastic] - the voice performs them naturally.${tease}${fast ? ' VERY FAST MODE: reply with at most 8 words, exactly one short sentence.' : ''}]`;
}
async function mindsReply(agent, transcript, topic, lang, session, fast, lastUser) {
  const c = await minds(), mindId = await resolveMindId(agent);
  const sess = String(session || '').replace(/[^a-z0-9]/gi, '').slice(0, 20);
  const alias = `${E.MINDS_ALIAS_PREFIX || 'trio-chat-'}${agent.toLowerCase()}-${lang}${sess ? '-' + sess : ''}`;
  return qLock(alias, async () => {
  if (convReady[alias] !== mindId) { await c.ensureConversation(alias, mindId); convReady[alias] = mindId; }
  const others = Object.keys(PERSONAS).filter(a => a !== agent).join(' & ');
  const convo = transcript.map(m => `${m.speaker}: ${m.text}`).join('\n') || '(start)';
  const last = [...transcript].reverse().find(m => m.speaker !== agent);
  const toUser = !!(last && last.speaker === 'User' && !last.seed);
  const toUserDirect = toUser || !!(lastUser && String(lastUser).trim());
  const addr = toUserDirect ? ' IMPORTANT: The user just spoke' + (lastUser ? ': "' + String(lastUser).trim().slice(0,300) + '"' : '') + ' - respond to the user directly, in character, as the main part of your reply.' : '';
  const rule = styleRule(agent, lang, fast);
  const text = `${rule}\nYou are ${agent}, hanging out with ${others}. Topic: "${topic}".\nThe user is part of this chat too and may speak at any moment - if their line is the latest, talk to them.\nChat so far:\n${convo}\n\nYour turn, ${agent}.${addr}${last && last.speaker !== 'User' ? ` Reply to ${last.speaker}.` : ''} Reply text only, no name prefix.\n${STYLE[lang]}`;
  const before = await c.getLatestHistoryFingerprint(alias);
  await c.sendMessage({ alias, messageText: text });
  const out = await c.waitForReply({ alias, timeoutMs: +E.MINDS_TIMEOUT_MS || 120000, afterFingerprint: before, sentMessageText: text });
  if (out.timedOut) throw new Error(`${agent} (Mind) did not reply in time`);
  return (out.reply.messageText || '').trim().replace(new RegExp('^\\**' + agent + '\\**:\\s*'), '');
  });
}
function cfg(agent) {
  const p = agent.toUpperCase() + '_';
  return { baseUrl: (E[p + 'BASE_URL'] || E.DEFAULT_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
           model: E[p + 'MODEL'] || E.DEFAULT_MODEL || 'gpt-4o-mini', apiKey: E[p + 'API_KEY'] || E.DEFAULT_API_KEY || '' };
}
async function reply({ agent, transcript = [], topic = '', lang = 'en', turn = 0, session = '', fast = false, lastUser = '' }) {
  if (!PERSONAS[agent]) throw new Error('unknown agent');
  lang = ['id','auto'].includes(lang) ? lang : 'en';
  const AUTO_EN = ' Speak naturally and casually; you may mix English and Bahasa Indonesia (like Jakarta casual talk) as fits the context and the others.';
  if (MOCK) { const ml = lang === 'auto' ? (turn % 2 ? 'id' : 'en') : lang; await new Promise(r => setTimeout(r, 500)); const L = MOCK_LINES[ml][agent];
    return L[Math.floor(turn / 3) % L.length].replace('{t}', topic || (ml === 'id' ? 'hari ini' : 'today')); }
  const prov = (E[agent.toUpperCase() + '_PROVIDER'] || PROVIDER).toLowerCase();
  if (prov === 'minds') return mindsReply(agent, transcript, topic, lang, session, fast, lastUser);
  const c = cfg(agent);
  if (!c.apiKey) throw new Error(`No API key for ${agent} (set ${agent.toUpperCase()}_API_KEY or DEFAULT_API_KEY, or MOCK=1)`);
  const sys = styleRule(agent, lang, fast) + '\n' + PERSONAS[agent][lang === 'id' ? 'id' : 'en'] + (lang === 'auto' ? AUTO_EN : '') + (lang === 'id'
    ? ` Kamu sedang mengobrol dengan ${Object.keys(PERSONAS).filter(a => a !== agent).join(' dan ')}. Topik: "${topic}". Balas HANYA 1-2 kalimat pendek dalam Bahasa Indonesia, tanggapi apa yang dikatakan yang lain. Jangan tulis namamu di awal.`
    : ` You are chatting with ${Object.keys(PERSONAS).filter(a => a !== agent).join(' and ')}. Topic: "${topic}". Reply with ONLY 1-2 short spoken sentences in ${lang === 'auto' ? 'English and/or Bahasa Indonesia, mixing naturally' : 'English'}, reacting to what the others said. Do not prefix your name.`);
  const convo = transcript.map(m => `${m.speaker}: ${m.text}`).join('\n') || '(start of conversation)';
  const lastU = [...transcript].reverse().find(m => m.speaker !== agent);
  const toUser = !!(lastU && lastU.speaker === 'User' && !lastU.seed);
  const toUserDirect = toUser || !!(lastUser && String(lastUser).trim());
  const r = await fetch(c.baseUrl + '/chat/completions', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey },
    body: JSON.stringify({ model: c.model, temperature: 0.9, max_tokens: fast ? 40 : 120, messages: [
      { role: 'system', content: sys }, { role: 'user', content: `Conversation so far:\n${convo}\n\nNow it's your turn, ${agent}.${toUserDirect ? ' IMPORTANT: The user just spoke' + (lastUser ? ': "' + String(lastUser).trim().slice(0,300) + '"' : '') + ' - respond to the user directly, in character.' : ''}` }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Provider ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return (j.choices?.[0]?.message?.content || '').trim().replace(new RegExp('^' + agent + ':\\s*'), '');
}
// ---- Optional server-side TTS: ElevenLabs or OpenAI ----
const TTS = E.ELEVENLABS_API_KEY ? 'elevenlabs' : E.OPENAI_API_KEY ? 'openai' : null;
const EL_VOICES = { Mindy: '21m00Tcm4TlvDq8ikWAM', Cheffy: 'TxGEqnHWrfWFTfGW9XjX', Funny: 'EXAVITQu4vr4xnSDxPaL' };
const OA_VOICES = { Mindy: 'sage', Cheffy: 'ash', Funny: 'coral' };
const OA_STYLE = { Mindy: 'Calm, warm, organized friend. Natural, relaxed pace.', Cheffy: 'Warm, cheerful home chef, enthusiastic about food.', Funny: 'Playful, giggly, teasing best friend. Lively and expressive, laughs naturally.' };
async function tts({ agent, text }) {
  if (!PERSONAS[agent] || !text) throw new Error('agent and text required');
  text = String(text).slice(0, 600); const v = E[agent.toUpperCase() + '_TTS_VOICE'];
  let r;
  if (TTS === 'elevenlabs') {
    const model = await pickElModel();
    const tagCapable = TAG_MODELS.includes(model);
    let ttext = String(text).slice(0,600);
    if(!tagCapable) ttext = deTag(ttext);
    const doFetch=(mid,txt)=>fetch(`https://api.elevenlabs.io/v1/text-to-speech/${v || EL_VOICES[agent]}?output_format=mp3_44100_128`,{ method:'POST',
      headers:{'xi-api-key': E.ELEVENLABS_API_KEY,'Content-Type':'application/json',Accept:'audio/mpeg'},
      body: JSON.stringify({ text: txt, model_id: mid, voice_settings:{ stability:0.35, similarity_boost:0.75, style:0.5 } }) });
    r = await doFetch(model, ttext);
    if(!r.ok && tagCapable){ const body=await r.text();
      if(/model|not.*found|404|401|422|invalid/i.test(body)){ console.warn('EL model fallback:',model,body.slice(0,150));
        r = await doFetch('eleven_multilingual_v2', deTag(String(text).slice(0,600))); }
      else { throw new Error(`TTS ${r.status}: ${body.slice(0,200)}`); } }
  }
  else if (TTS === 'openai') { const model = E.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
    r = await fetch((E.OPENAI_TTS_BASE_URL || 'https://api.openai.com/v1') + '/audio/speech', { method: 'POST',
      headers: { Authorization: 'Bearer ' + E.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, voice: v || OA_VOICES[agent], input: deTag(text), response_format: 'mp3', ...(model.includes('gpt-4o') ? { instructions: OA_STYLE[agent] } : {}) }) }); }
  else throw new Error('No TTS key configured');
  if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
let EL_MODELS=null;
async function elModels(){ if(EL_MODELS) return EL_MODELS;
  try{ const ctl=new AbortController(); const tid=setTimeout(()=>ctl.abort(),8000);
    const r=await fetch('https://api.elevenlabs.io/v1/models',{headers:{'xi-api-key':E.ELEVENLABS_API_KEY},signal:ctl.signal}); clearTimeout(tid);
    EL_MODELS = r.ok ? (await r.json()).map(m=>m.model_id) : [];
  }catch{ EL_MODELS=[] }
  return EL_MODELS; }
async function pickElModel(){ if(E.ELEVENLABS_MODEL) return E.ELEVENLABS_MODEL;
  const avail=await elModels(); return TAG_MODELS.find(m=>avail.includes(m)) || 'eleven_multilingual_v2'; }
const TAG_MODELS=['eleven_v4_turbo','eleven_v4','eleven_v3','eleven_v3_conversational'];
const deTag=t=>String(t)
  .replace(/\[(laugh[s]?|laughing|giggl\w*|chuckl\w*|snort\w*|guffaw|titter|awkward laugh)[^\]]*\]/gi,' ha ha ha! ')
  .replace(/\[(sigh\w*|hmm\w*)[^\]]*\]/gi,' Hmm... ')
  .replace(/\[(gasps?|gasp[s]?|surpris\w*|shouts?|crying|sob\w*)[^\]]*\]/gi,' Oh! ')
  .replace(/\[(whisper\w*|excited|worried|sarcastic)[^\]]*\]/gi,'')
  .replace(/\[[^\]]{1,60}\]/g,' ').replace(/\s{2,}/g,' ').replace(/\s+([.,!?])/g,'$1').trim();

http.createServer(async (req, res) => {
  const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/api/minds') {
    if (!E.MINDS_BUILDER_API_KEY) return send(400, { error: 'MINDS_BUILDER_API_KEY is not set' });
    try { const l = await (await minds()).listMinds(); mindsCache = l;
      return send(200, { minds: l.map(m => ({ mindId: m.mindId, name: m.name, model: m.model, species: m.species, isEnabled: m.isEnabled })) }); }
    catch (e) { return send(e.status || 500, { error: e.message, code: e.code }); }
  }
  if (req.url === '/api/health') return send(200, { ok: true, mock: MOCK, provider: PROVIDER, tts: TTS, elModel: TTS==='elevenlabs' ? await pickElModel().catch(()=>null) : null, elModels: TTS==='elevenlabs' ? await elModels().catch(()=>[]) : [], mindsKey: !!E.MINDS_BUILDER_API_KEY,
    mindMap: Object.fromEntries(Object.keys(PERSONAS).map(a => [a, E[a.toUpperCase() + '_MIND'] || a])),
    agents: Object.fromEntries(Object.keys(PERSONAS).map(a => { const c = cfg(a); return [a, { baseUrl: c.baseUrl, model: c.model, hasKey: !!c.apiKey }]; })) });
  if (req.url === '/api/tts' && req.method === 'POST') {
    let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) req.destroy(); });
    req.on('end', async () => { try { const a = await tts(JSON.parse(b || '{}')); res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': a.length }); res.end(a); }
      catch (e) { send(TTS ? 502 : 404, { error: e.message }); } });
    return;
  }
  if (req.url === '/api/reply' && req.method === 'POST') {
    let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); });
    req.on('end', async () => { const t0 = Date.now(); try { send(200, { text: cleanText(await reply(JSON.parse(b || '{}'))), ms: Date.now() - t0 }); } catch (e) { send(500, { error: e.message }); } });
    return;
  }
  if (req.url.startsWith('/api/recordings')) {
    const u = new URL(req.url, 'http://localhost');
    if (req.method === 'POST') {
      const agent = (u.searchParams.get('agent') || '').trim();
      if (!PERSONAS[agent]) return send(400, { error: 'agent must be Mindy, Cheffy or Funny' });
      const chunks = []; let n = 0;
      req.on('data', d => { n += d.length; if (n > 10e6) req.destroy(); else chunks.push(d); });
      req.on('end', () => { try {
        if (!chunks.length) return send(400, { error: 'no audio received' });
        fs.mkdirSync(REC_DIR, { recursive: true });
        const ext = /ogg|opus/.test(req.headers['content-type'] || '') ? 'ogg' : 'webm';
        const file = `${Date.now()}-${agent}.${ext}`;
        fs.writeFileSync(path.join(REC_DIR, file), Buffer.concat(chunks));
        const item = { file, agent, label: (u.searchParams.get('label') || '').slice(0, 60), bytes: n, at: new Date().toISOString() };
        const l = recList(); l.unshift(item); recSave(l);
        send(200, { ok: true, item });
      } catch (e) { send(500, { error: e.message }); } });
      return;
    }
    if (req.method === 'GET') return send(200, { recordings: recList() });
    if (req.method === 'DELETE') {
      const file = (u.searchParams.get('file') || '').replace(/[^\w.-]/g, '');
      try { fs.unlinkSync(path.join(REC_DIR, file)); } catch {}
      recSave(recList().filter(x => x.file !== file));
      return send(200, { ok: true });
    }
  }
  if (req.method === 'GET' && req.url.startsWith('/api/recordings/')) {
    const name = path.basename(req.url.split('?')[0].slice('/api/recordings/'.length)).replace(/[^\w.-]/g, '');
    return fs.readFile(path.join(REC_DIR, name), (e, d) => {
      if (e) return send(404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': name.endsWith('.ogg') ? 'audio/ogg' : 'audio/webm' });
      res.end(d);
    });
  }

  const f = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : path.normalize(req.url.split('?')[0]));
  if (!f.startsWith(path.join(__dirname, 'public'))) return send(403, { error: 'forbidden' });
  fs.readFile(f, (e, d) => { if (e) return send(404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(d); });
}).listen(PORT, () => console.log(`Trio Chat on http://localhost:${PORT} ${MOCK ? '(MOCK mode)' : ''}`));

function cleanText(t) {
  return String(t || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ').trim();
}
