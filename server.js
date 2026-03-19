const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const state = {
  timezone: 'America/New_York',
  tradingWindow: { start: '09:00', end: '12:00' },
  bot: { running: true, mode: 'frank', attached: false, autonomous: true },
  bridge: { connected: false, source: 'sim', lastSeen: null },
  frank: { connected: false, lastDecisionAt: null, lastDecision: 'HOLD', lastReason: 'waiting for context' },
  account: { equity: 100000, sessionPnl: 0, dailyPnl: 0 },
  market: { symbol: 'AMD', timeframe: '1m', price: 181.24, changePct: 0, candles: [] },
  position: { side: 'FLAT', size: 0, entry: null, stop: null, unrealized: 0 },
  rules: { maxTradesPerDay: 3, riskPerTradePctEquity: 5, breakevenAfterPartials: true, flattenAt: '12:00' },
  guidance: { text: '', updatedAt: null, strict: true },
  activity: [{ t: Date.now(), msg: 'System online. Frank autonomous mode is default. Waiting for replay bridge + Frank decisions.' }],
  chat: []
};

let commandSeq = 1;
const pendingCommands = [];
let pendingVerification = null;
let lastCommandAt = 0;

function pushActivity(msg) {
  state.activity.unshift({ t: Date.now(), msg });
  state.activity = state.activity.slice(0, 80);
}
function broadcast(payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(data));
}

function simTick() {
  if (state.bridge.connected) return;
  const drift = (Math.random() - 0.48) * 0.3;
  state.market.price = Math.max(1, +(state.market.price + drift).toFixed(2));
  state.market.changePct = +(((state.market.price - 181.24) / 181.24) * 100).toFixed(2);
  const minute = Math.floor(Date.now() / 60000) * 60000;
  const last = state.market.candles[state.market.candles.length - 1];
  if (!last || last.t !== minute) {
    state.market.candles.push({ t: minute, o: state.market.price, h: state.market.price, l: state.market.price, c: state.market.price });
  } else {
    last.h = Math.max(last.h, state.market.price);
    last.l = Math.min(last.l, state.market.price);
    last.c = state.market.price;
  }
  state.market.candles = state.market.candles.slice(-120);
}

setInterval(() => {
  simTick();
  if (state.bridge.connected && state.bridge.lastSeen && Date.now() - state.bridge.lastSeen > 9000) {
    state.bridge.connected = false;
    state.bridge.source = 'sim';
    state.bot.attached = false;
    pushActivity('Replay bridge heartbeat lost. Falling back to sim feed.');
  }
  broadcast({ type: 'state', state });
}, 1000);

app.get('/api/state', (req, res) => res.json(state));

const POLYGON_BASE = 'https://api.polygon.io';
function polygonKey() { return process.env.POLYGON_API_KEY || ''; }
async function polygonGet(path, params = {}) {
  const key = polygonKey();
  if (!key) throw new Error('POLYGON_API_KEY missing');
  const q = new URLSearchParams({ ...params, apiKey: key });
  const r = await fetch(`${POLYGON_BASE}${path}?${q.toString()}`);
  if (!r.ok) throw new Error(`Polygon ${r.status}`);
  return r.json();
}
function etHM(ts) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date(ts));
  const hour = Number(parts.find(p => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

app.get('/api/polygon/test', async (req, res) => {
  try {
    const snap = await polygonGet('/v2/snapshot/locale/us/markets/stocks/tickers/AAPL');
    res.json({ ok: true, hasKey: !!polygonKey(), ticker: snap?.ticker?.ticker || 'AAPL' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/market/levels', async (req, res) => {
  const ticker = String(req.query.ticker || '').toUpperCase();
  if (!ticker) return res.status(400).json({ ok: false, error: 'ticker required' });
  try {
    const today = new Date().toISOString().slice(0, 10);
    const prev = await polygonGet(`/v2/aggs/ticker/${ticker}/prev`, { adjusted: 'true' });
    const snap = await polygonGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);

    let priorClose = prev?.results?.[0]?.c ?? snap?.ticker?.prevDay?.c ?? null;
    let avgVol = snap?.ticker?.prevDay?.v ?? null;

    let atr = null;
    try {
      const atrJson = await polygonGet(`/v1/indicators/atr/${ticker}`, {
        timespan: 'day', adjusted: 'true', window: '14', series_type: 'close', order: 'desc', limit: '1'
      });
      atr = atrJson?.results?.values?.[0]?.value ?? null;
    } catch (_) {
      // fallback ATR approximation from daily ranges
      const from = new Date(Date.now() - 1000 * 60 * 60 * 24 * 40).toISOString().slice(0, 10);
      const daily = await polygonGet(`/v2/aggs/ticker/${ticker}/range/1/day/${from}/${today}`, { adjusted: 'true', sort: 'desc', limit: '20' });
      const ranges = (daily?.results || []).slice(0, 14).map(b => (b.h - b.l)).filter(Number.isFinite);
      atr = ranges.length ? ranges.reduce((a, b) => a + b, 0) / ranges.length : null;
    }

    const mins = await polygonGet(`/v2/aggs/ticker/${ticker}/range/1/minute/${today}/${today}`, {
      adjusted: 'true', sort: 'asc', limit: '50000'
    });
    const pmBars = (mins?.results || []).filter(b => {
      const m = etHM(b.t);
      return m >= (4 * 60) && m < (9 * 60 + 30);
    });

    const pmHigh = pmBars.length ? Math.max(...pmBars.map(b => b.h)) : null;
    const pmLow = pmBars.length ? Math.min(...pmBars.map(b => b.l)) : null;
    const sumPV = pmBars.reduce((a, b) => a + ((b.vw ?? b.c) * (b.v || 0)), 0);
    const sumV = pmBars.reduce((a, b) => a + (b.v || 0), 0);
    const pmVWAP = sumV > 0 ? (sumPV / sumV) : null;

    const atrUpper = (priorClose != null && atr != null) ? priorClose + atr : null;
    const atrLower = (priorClose != null && atr != null) ? priorClose - atr : null;
    const withinAtr = (pmHigh != null && pmLow != null && atrUpper != null && atrLower != null)
      ? (pmHigh <= atrUpper && pmLow >= atrLower)
      : null;

    res.json({
      ok: true,
      ticker,
      priorClose,
      avgDailyVol: avgVol,
      atr,
      pmHigh,
      pmLow,
      pmVWAP,
      atrUpper,
      atrLower,
      withinAtr,
      passesBaseFilters: (priorClose >= 20) && (avgVol >= 15000000)
    });
  } catch (e) {
    res.status(500).json({ ok: false, ticker, error: String(e.message || e) });
  }
});

app.get('/api/market/scan', async (req, res) => {
  const raw = String(req.query.tickers || 'NVDA,AMD,MU,INTC,AAPL,TSLA,MSFT,AMZN,META,GOOGL').toUpperCase();
  const tickers = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 30);
  const out = [];
  for (const t of tickers) {
    try {
      const r = await fetch(`http://127.0.0.1:${process.env.PORT || 4273}/api/market/levels?ticker=${encodeURIComponent(t)}`);
      const j = await r.json();
      if (!j.ok) continue;
      const pass = j.passesBaseFilters && j.withinAtr === true;
      out.push({ ticker: t, pass, ...j });
    } catch (_) {}
  }
  res.json({ ok: true, total: out.length, passed: out.filter(x => x.pass).length, results: out });
});

app.get('/api/bridge/inject.js', (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  const script = `(function(){
 if(window.__openclawBridge){clearInterval(window.__openclawBridge)}
 const host='${host}';
 const num=(s)=>{if(!s)return null;const m=String(s).replace(/,/g,'').match(/-?\\d+(?:\\.\\d+)?/);return m?Number(m[0]):null};
 const txt=(sel)=>{const el=document.querySelector(sel);return el?.textContent?.trim()||null};
 const symbolFromUrl=()=>{const u=new URL(location.href);return u.searchParams.get('symbol')||u.searchParams.get('ticker')||u.searchParams.get('instrument')||null};
 const symbolFromStorage=()=>{for(const k of Object.keys(localStorage)){if(/symbol|ticker|instrument/i.test(k)){const v=localStorage.getItem(k);if(v&&/^[A-Z.]{1,8}$/.test(v))return v;}}return null};
 const symbolFromDom=()=> txt('[data-symbol]')||txt('[class*=symbol]')||txt('[class*=ticker]')||null;
 const getSymbol=()=> (symbolFromUrl()||symbolFromStorage()||symbolFromDom()||'UNKNOWN').toUpperCase();
 const getPrice=()=>{const body=(document.body?.innerText||'');const cMatch=body.match(/\bC\s*[: ]\s*(\d+(?:\.\d+)?)/i);if(cMatch){const cp=num(cMatch[1]);if(cp&&cp>0&&cp<10000)return cp;}const c=['[data-last-price]','[class*=last-price]','[class*=mark-price]','[class*=current-price]','[class*=quote-price]','[class*=close]'].map(txt).map(num).filter(Boolean);for(const p of c){if(p>0&&p<10000)return p;}const bad=/(p&l|pnl|profit|equity|balance|buying power|account|unrealized|realized|daily|total|cash)/i;const nodes=[...document.querySelectorAll('span,div')].slice(0,2600);for(const n of nodes){const t=n.textContent?.trim();const parent=(n.parentElement?.textContent||'').trim();if(!t||t.length>24||bad.test(t)||bad.test(parent))continue;const p=num(t);if(p&&p>0&&p<10000&&/\\d+\\.\\d+/.test(t))return p;}return null};
 const candles=[];
 let bar=null;
 const roll=(price)=>{const slot=Math.floor(Date.now()/5000)*5000; if(!bar||bar.t!==slot){ if(bar) candles.push(bar); bar={t:slot,o:price,h:price,l:price,c:price}; if(candles.length>240)candles.shift(); } else { bar.h=Math.max(bar.h,price); bar.l=Math.min(bar.l,price); bar.c=price; }};
 const pullCommands=async()=>{try{const r=await fetch(host+'/api/bridge/commands');const j=await r.json();return j.commands||[]}catch{return []}};
 const clickByText=(re)=>{const els=[...document.querySelectorAll('button,[role=button],a,div,span')];const el=els.find(e=>re.test((e.textContent||'').trim())&&e.offsetParent!==null);if(el){el.click();return true;}return false;};
 const getSide=()=>{const t=(document.body?.innerText||'').toLowerCase(); if(/\bflat\b/.test(t)) return 'FLAT'; if(/\blong\b/.test(t)) return 'LONG'; if(/\bshort\b/.test(t)) return 'SHORT'; return 'UNKNOWN';};
 const execCmd=async(c)=>{let ok=false, note='no matching control found';
   if(c.type==='BUY'){ok=clickByText(/\\bbuy\\b/i); note=ok?'BUY click sent':note;}
   if(c.type==='SELL'){ok=clickByText(/\\b(sell|short)\\b/i); note=ok?'SELL/SHORT click sent':note;}
   if(c.type==='FLATTEN'){ok=clickByText(/flatten|close all|close position/i); note=ok?'FLATTEN click sent':note;}
   try{await fetch(host+'/api/bridge/ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:c.id,ok,note,phase:'click'})})}catch{}
 };
 const push=async()=>{
   const symbol=getSymbol();
   const price=getPrice();
   const positionSide=getSide();
   if(price){roll(price);}
   const fullBars=bar?[...candles.slice(-119),bar]:candles.slice(-120);
   const payload={symbol,timeframe:'1m',price,positionSide,candles:fullBars,raw:{title:document.title,href:location.href}};
   try{await fetch(host+'/api/bridge/push',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}catch(e){}
   const cmds=await pullCommands();
   for(const c of cmds) await execCmd(c);
 };
 window.__openclawBridge=setInterval(push,1000); push();
 console.log('OpenClaw replay bridge started -> '+host);
})();`;
  res.type('application/javascript').send(script);
});

app.post('/api/bridge/push', (req, res) => {
  const { symbol, timeframe, price, positionSide, candles, raw } = req.body || {};
  state.bridge.connected = true;
  state.bridge.source = 'replay.tradingterminal.com';
  state.bridge.lastSeen = Date.now();
  state.bot.attached = true;
  if (symbol && symbol !== 'UNKNOWN') state.market.symbol = String(symbol).toUpperCase();
  if (timeframe) state.market.timeframe = timeframe;
  if (typeof price === 'number' && Number.isFinite(price)) state.market.price = +price.toFixed(2);
  if (positionSide && ['LONG','SHORT','FLAT'].includes(positionSide)) state.position.side = positionSide;
  if (Array.isArray(candles)) {
    const cleaned = [];
    for (const b of candles.slice(-240)) {
      const o = Number(b.o ?? b.c ?? b.close);
      const h = Number(b.h ?? b.c ?? b.close);
      const l = Number(b.l ?? b.c ?? b.close);
      const c = Number(b.c ?? b.close);
      if (![o,h,l,c].every(Number.isFinite)) continue;
      if (c <= 0 || c > 10000) continue;
      const prev = cleaned[cleaned.length - 1];
      if (prev && Math.abs((c - prev.c) / prev.c) > 0.2) continue; // drop obvious outlier jumps
      cleaned.push({ t: Number(b.t) || Date.now(), o, h, l, c });
    }
    state.market.candles = cleaned.slice(-120);
  }
  if (state.market.candles.length > 1) {
    const base = state.market.candles[0].c ?? state.market.candles[0].close ?? state.market.price;
    state.market.changePct = +(((state.market.price - base) / base) * 100).toFixed(2);
  }
  if (pendingVerification) {
    const age = Date.now() - pendingVerification.t;
    const sideOk = pendingVerification.expectSide === 'ANY' || state.position.side === pendingVerification.expectSide;
    if (sideOk) {
      pushActivity(`Exec ${pendingVerification.id}: FILLED (state=${state.position.side})`);
      pendingVerification = null;
    } else if (age > 7000) {
      pushActivity(`Exec ${pendingVerification.id}: NO_CHANGE (state=${state.position.side})`);
      pendingVerification = null;
    }
  }
  if (raw?.title && Math.random() < 0.02) pushActivity(`Bridge sync: ${raw.title}`);
  res.json({ ok: true });
});

app.get('/api/bridge/commands', (req, res) => {
  if (pendingVerification) return res.json({ ok: true, commands: [] });
  const now = Date.now();
  if (now - lastCommandAt < 5000) return res.json({ ok: true, commands: [] });
  const cmd = pendingCommands.shift();
  if (!cmd) return res.json({ ok: true, commands: [] });
  lastCommandAt = now;
  const expectSide = cmd.type === 'BUY' ? 'LONG' : cmd.type === 'SELL' ? 'SHORT' : cmd.type === 'FLATTEN' ? 'FLAT' : 'ANY';
  pendingVerification = { id: cmd.id, expectSide, t: now };
  res.json({ ok: true, commands: [cmd] });
});

app.post('/api/bridge/ack', (req, res) => {
  const { id, ok, note, phase } = req.body || {};
  if (!ok) pushActivity(`Exec ${id}: CLICK_FAILED${note ? ` (${note})` : ''}`);
  else if (phase === 'click') pushActivity(`Exec ${id}: CLICK_SENT`);
  res.json({ ok: true });
});

app.get('/api/frank/context', (req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    bot: state.bot,
    bridge: state.bridge,
    market: state.market,
    position: state.position,
    account: state.account,
    rules: state.rules,
    guidance: state.guidance,
    pendingCommands: pendingCommands.length
  });
});

app.post('/api/frank/decide', (req, res) => {
  const { action = 'HOLD', reason = '' } = req.body || {};
  const normalized = String(action).toUpperCase();
  state.frank.connected = true;
  state.frank.lastDecisionAt = Date.now();
  state.frank.lastDecision = normalized;
  state.frank.lastReason = reason || 'no reason supplied';

  let queued = null;
  if (['BUY', 'SELL', 'FLATTEN'].includes(normalized)) {
    const id = `${normalized}-${commandSeq++}`;
    queued = { id, type: normalized, command: normalized, t: Date.now() };
    pendingCommands.push(queued);
    pushActivity(`Frank decision: ${normalized}${reason ? ` — ${reason}` : ''}`);
  } else {
    pushActivity(`Frank decision: HOLD${reason ? ` — ${reason}` : ''}`);
  }

  res.json({ ok: true, queued, frank: state.frank });
});

app.post('/api/bot/start', (req, res) => {
  state.bot.running = true;
  state.bot.autonomous = true;
  pushActivity('Frank autonomous mode started.');
  res.json({ ok: true, bot: state.bot });
});
app.post('/api/bot/stop', (req, res) => {
  state.bot.running = false;
  state.bot.autonomous = false;
  pushActivity('Frank autonomous mode paused.');
  res.json({ ok: true, bot: state.bot });
});
app.post('/api/command', (req, res) => {
  const { command } = req.body || {};
  if (!command) return res.status(400).json({ ok: false, error: 'command required' });
  const upper = String(command).toUpperCase();
  let type = 'CUSTOM';
  if (upper.includes('BUY')) type = 'BUY';
  if (upper.includes('SELL') || upper.includes('SHORT')) type = 'SELL';
  if (upper.includes('FLATTEN') || upper.includes('CLOSE')) type = 'FLATTEN';
  const id = `${type}-${commandSeq++}`;
  pendingCommands.push({ id, type, command, t: Date.now() });
  pushActivity(`Command queued: ${id}`);
  res.json({ ok: true, id });
});

app.post('/api/rules/update', (req, res) => {
  const patch = req.body || {};
  state.rules = { ...state.rules, ...patch };
  pushActivity(`Rules updated: ${Object.keys(patch).join(', ')}`);
  res.json({ ok: true, rules: state.rules });
});

app.post('/api/chat', (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ ok: false, error: 'message required' });
  state.chat.push({ role: 'user', message, t: Date.now() });

  state.guidance = { text: String(message), updatedAt: Date.now(), strict: true };
  pushActivity(`Guidance updated by Boss: ${String(message).slice(0, 120)}`);

  const reply = `Understood. I will follow your guidance as top priority: "${String(message).slice(0, 120)}". ` +
    `Live ${state.market.symbol}: $${state.market.price}.`;
  state.chat.push({ role: 'assistant', message: reply, t: Date.now() });
  pushActivity('Frank replied instantly (direct chat mode).');

  res.json({ ok: true, reply, guidance: state.guidance });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 4273;
server.listen(PORT, () => console.log(`openclaw-control-ui running on http://localhost:${PORT}`));
