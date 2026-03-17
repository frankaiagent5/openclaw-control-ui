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
  bot: { running: false, mode: 'replay', attached: false },
  bridge: { connected: false, source: 'sim', lastSeen: null },
  account: { equity: 100000, sessionPnl: 0, dailyPnl: 0 },
  market: { symbol: 'AMD', timeframe: '1m', price: 181.24, changePct: 0, candles: [] },
  position: { side: 'FLAT', size: 0, entry: null, stop: null, unrealized: 0 },
  rules: { maxTradesPerDay: 3, riskPerTradePctEquity: 5, breakevenAfterPartials: true, flattenAt: '12:00' },
  activity: [{ t: Date.now(), msg: 'System online. Waiting for replay bridge.' }],
  chat: []
};

let commandSeq = 1;
const pendingCommands = [];

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
  state.market.candles.push({ t: Date.now(), close: state.market.price });
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
 const getPrice=()=>{const c=['[data-last-price]','[class*=last-price]','[class*=mark-price]','[class*=current-price]','[class*=quote-price]','[class*=close]'].map(txt).map(num).filter(Boolean);for(const p of c){if(p>0&&p<10000)return p;}const nodes=[...document.querySelectorAll('span,div')].slice(0,1800);for(const n of nodes){const t=n.textContent?.trim();if(!t||t.length>24)continue;const p=num(t);if(p&&p>0&&p<10000&&/\\d+\\.\\d+/.test(t))return p;}return null};
 const candles=[];
 const pullCommands=async()=>{try{const r=await fetch(host+'/api/bridge/commands');const j=await r.json();return j.commands||[]}catch{return []}};
 const clickByText=(re)=>{const els=[...document.querySelectorAll('button,[role=button],a,div,span')];const el=els.find(e=>re.test((e.textContent||'').trim())&&e.offsetParent!==null);if(el){el.click();return true;}return false;};
 const execCmd=async(c)=>{let ok=false, note='no matching control found';
   if(c.type==='BUY'){ok=clickByText(/\\bbuy\\b/i); note=ok?'BUY clicked':note;}
   if(c.type==='SELL'){ok=clickByText(/\\b(sell|short)\\b/i); note=ok?'SELL/SHORT clicked':note;}
   if(c.type==='FLATTEN'){ok=clickByText(/flatten|close all|close position/i); note=ok?'FLATTEN clicked':note;}
   try{await fetch(host+'/api/bridge/ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:c.id,ok,note})})}catch{}
 };
 const push=async()=>{
   const symbol=getSymbol();
   const price=getPrice();
   if(price){candles.push({t:Date.now(),close:price}); if(candles.length>180)candles.shift();}
   const payload={symbol,timeframe:'1m',price,candles:candles.slice(-120),raw:{title:document.title,href:location.href}};
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
  const { symbol, timeframe, price, candles, raw } = req.body || {};
  state.bridge.connected = true;
  state.bridge.source = 'replay.tradingterminal.com';
  state.bridge.lastSeen = Date.now();
  state.bot.attached = true;
  if (symbol && symbol !== 'UNKNOWN') state.market.symbol = String(symbol).toUpperCase();
  if (timeframe) state.market.timeframe = timeframe;
  if (typeof price === 'number' && Number.isFinite(price)) state.market.price = +price.toFixed(2);
  if (Array.isArray(candles)) state.market.candles = candles.slice(-120);
  if (state.market.candles.length > 1) {
    state.market.changePct = +(((state.market.price - state.market.candles[0].close) / state.market.candles[0].close) * 100).toFixed(2);
  }
  if (raw?.title && Math.random() < 0.02) pushActivity(`Bridge sync: ${raw.title}`);
  res.json({ ok: true });
});

app.get('/api/bridge/commands', (req, res) => {
  const cmds = pendingCommands.splice(0, pendingCommands.length);
  res.json({ ok: true, commands: cmds });
});

app.post('/api/bridge/ack', (req, res) => {
  const { id, ok, note } = req.body || {};
  pushActivity(`Exec ${id}: ${ok ? 'OK' : 'FAILED'}${note ? ` (${note})` : ''}`);
  if (ok && String(id).includes('BUY')) {
    state.position = { side: 'LONG', size: 100, entry: state.market.price, stop: +(state.market.price - 1.5).toFixed(2), unrealized: 0 };
  }
  if (ok && String(id).includes('SELL')) {
    state.position = { side: 'SHORT', size: 100, entry: state.market.price, stop: +(state.market.price + 1.5).toFixed(2), unrealized: 0 };
  }
  if (ok && String(id).includes('FLATTEN')) {
    state.position = { side: 'FLAT', size: 0, entry: null, stop: null, unrealized: 0 };
  }
  res.json({ ok: true });
});

app.post('/api/bot/start', (req, res) => {
  state.bot.running = true;
  pushActivity('Bot started (replay-first mode).');
  res.json({ ok: true, bot: state.bot });
});
app.post('/api/bot/stop', (req, res) => {
  state.bot.running = false;
  pushActivity('Bot paused.');
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

  const m = String(message).toLowerCase();
  if (m.includes('buy')) pendingCommands.push({ id: `BUY-${commandSeq++}`, type: 'BUY', command: 'BUY macro', t: Date.now() });
  if (m.includes('sell') || m.includes('short')) pendingCommands.push({ id: `SELL-${commandSeq++}`, type: 'SELL', command: 'SELL macro', t: Date.now() });
  if (m.includes('flatten') || m.includes('close')) pendingCommands.push({ id: `FLATTEN-${commandSeq++}`, type: 'FLATTEN', command: 'FLATTEN', t: Date.now() });

  const reply = `Live ${state.market.symbol} ${state.market.timeframe}: $${state.market.price} (${state.market.changePct}%). Bridge=${state.bridge.connected ? 'ON' : 'OFF'}, Bot=${state.bot.running ? 'RUNNING' : 'PAUSED'}, Position=${state.position.side} ${state.position.size}.`;
  state.chat.push({ role: 'assistant', message: reply, t: Date.now() });
  res.json({ ok: true, reply, state });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 4273;
server.listen(PORT, () => console.log(`openclaw-control-ui running on http://localhost:${PORT}`));
