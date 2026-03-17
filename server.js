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
  market: { symbol: 'AAPL', timeframe: '1m', price: 191.23, changePct: 0, candles: [] },
  position: { side: 'FLAT', size: 0, entry: null, stop: null, unrealized: 0 },
  rules: { maxTradesPerDay: 3, riskPerTradePctEquity: 5, breakevenAfterPartials: true, flattenAt: '12:00' },
  activity: [{ t: Date.now(), msg: 'System online. Waiting for replay bridge.' }],
  chat: []
};

function pushActivity(msg) {
  state.activity.unshift({ t: Date.now(), msg });
  state.activity = state.activity.slice(0, 50);
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(data));
}

function simTick() {
  if (state.bridge.connected) return;
  const drift = (Math.random() - 0.48) * 0.35;
  state.market.price = Math.max(1, +(state.market.price + drift).toFixed(2));
  state.market.changePct = +(((state.market.price - 191.23) / 191.23) * 100).toFixed(2);
  state.market.candles.push({ t: Date.now(), close: state.market.price });
  state.market.candles = state.market.candles.slice(-120);
}

setInterval(() => {
  simTick();
  if (state.bridge.connected && state.bridge.lastSeen && Date.now() - state.bridge.lastSeen > 7000) {
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
  if(window.__openclawBridge){console.log('OpenClaw bridge already running');return;}
  const host='${host}';
  const pick=(arr)=>{for(const s of arr){const el=document.querySelector(s);if(el&&el.textContent&&el.textContent.trim()) return el.textContent.trim();}return null;};
  const parsePrice=(txt)=>{if(!txt) return null; const m=txt.replace(/,/g,'').match(/(-?\\d+(?:\\.\\d+)?)/); return m?Number(m[1]):null;};
  const candleBuf=[];
  async function push(){
    const symbol = pick(['[data-symbol]','[class*="symbol"]','[class*="ticker"]']) || (document.title.split(' ')[0]||'UNKNOWN');
    const priceText = pick(['[data-last-price]','[class*="last-price"]','[class*="price"]','[class*="close"]']);
    const price = parsePrice(priceText);
    if(price){ candleBuf.push({t:Date.now(), close:price}); if(candleBuf.length>180)candleBuf.shift(); }
    const payload = { symbol, timeframe:'1m', price, candles:candleBuf.slice(-120), raw:{title:document.title} };
    try{ await fetch(host+'/api/bridge/push',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}catch(e){}
  }
  window.__openclawBridge=setInterval(push,1000);
  push();
  console.log('OpenClaw replay bridge started -> '+host);
})();`;
  res.type('application/javascript').send(script);
});

app.post('/api/bridge/push', (req, res) => {
  const { symbol, timeframe, price, candles, position, account, raw } = req.body || {};
  state.bridge.connected = true;
  state.bridge.source = 'replay.tradingterminal.com';
  state.bridge.lastSeen = Date.now();
  state.bot.attached = true;
  if (symbol) state.market.symbol = String(symbol).toUpperCase();
  if (timeframe) state.market.timeframe = timeframe;
  if (typeof price === 'number' && Number.isFinite(price)) state.market.price = +price.toFixed(2);
  if (Array.isArray(candles)) state.market.candles = candles.slice(-120);
  if (position && typeof position === 'object') state.position = { ...state.position, ...position };
  if (account && typeof account === 'object') state.account = { ...state.account, ...account };
  state.market.changePct = +(state.market.candles.length > 1
    ? ((state.market.price - state.market.candles[0].close) / state.market.candles[0].close) * 100
    : state.market.changePct).toFixed(2);
  if (raw && raw.title && Math.random() < 0.03) pushActivity(`Bridge sync: ${raw.title}`);
  broadcast({ type: 'state', state });
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
  pushActivity(`Command queued for bridge executor: ${command}`);
  res.json({ ok: true, queued: true });
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
  const reply = `Live ${state.market.symbol} ${state.market.timeframe}: $${state.market.price} (${state.market.changePct}%). Bridge=${state.bridge.connected?'ON':'OFF'}, Bot=${state.bot.running?'RUNNING':'PAUSED'}, Position=${state.position.side} ${state.position.size}.`;
  state.chat.push({ role: 'assistant', message: reply, t: Date.now() });
  res.json({ ok: true, reply, state });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 4273;
server.listen(PORT, () => console.log(`openclaw-control-ui running on http://localhost:${PORT}`));
