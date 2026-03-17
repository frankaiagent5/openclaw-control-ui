const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const state = {
  timezone: 'America/New_York',
  tradingWindow: { start: '09:00', end: '12:00' },
  bot: { running: false, mode: 'paper', attached: true },
  account: { equity: 100000, sessionPnl: 0, dailyPnl: 0, winRate: 0 },
  market: { symbol: 'AAPL', timeframe: '1m', price: 191.23, changePct: 0.0 },
  position: { side: 'FLAT', size: 0, entry: null, stop: null, unrealized: 0 },
  rules: {
    maxTradesPerDay: 3,
    riskPerTradePctEquity: 5,
    breakevenAfterPartials: true,
    flattenAt: '12:00',
    partials: [
      { pct: 30, at: '3R' },
      { pct: 20, at: '70% ATR' },
      { pct: 10, at: '80% ATR' },
      { pct: 10, at: '90% ATR' },
      { pct: 10, at: '100% ATR' },
      { pct: 10, at: '120% ATR' },
      { pct: 10, at: 'runner' }
    ]
  },
  activity: [
    { t: Date.now(), msg: 'System online. Waiting for bot start.' }
  ],
  chat: []
};

function pushActivity(msg) {
  state.activity.unshift({ t: Date.now(), msg });
  state.activity = state.activity.slice(0, 40);
}

function marketTick() {
  const drift = (Math.random() - 0.48) * 0.35;
  state.market.price = Math.max(1, +(state.market.price + drift).toFixed(2));
  state.market.changePct = +(((state.market.price - 191.23) / 191.23) * 100).toFixed(2);
  if (state.position.side !== 'FLAT') {
    const dir = state.position.side === 'LONG' ? 1 : -1;
    state.position.unrealized = +((state.market.price - state.position.entry) * state.position.size * dir).toFixed(2);
    state.account.sessionPnl = +(state.account.dailyPnl + state.position.unrealized).toFixed(2);
  }
}

setInterval(() => {
  marketTick();
  broadcast({ type: 'state', state });
}, 1000);

app.get('/api/state', (req, res) => res.json(state));

app.post('/api/bot/start', (req, res) => {
  state.bot.running = true;
  pushActivity('Bot started for continuous session loop (9:00-12:00 EST).');
  broadcast({ type: 'state', state });
  res.json({ ok: true, bot: state.bot });
});

app.post('/api/bot/stop', (req, res) => {
  state.bot.running = false;
  pushActivity('Bot stopped by operator.');
  broadcast({ type: 'state', state });
  res.json({ ok: true, bot: state.bot });
});

app.post('/api/command', (req, res) => {
  const { command } = req.body || {};
  if (!command) return res.status(400).json({ ok: false, error: 'command required' });
  pushActivity(`Command queued: ${command}`);

  if (/flatten/i.test(command)) {
    state.account.dailyPnl = +(state.account.dailyPnl + state.position.unrealized).toFixed(2);
    state.position = { side: 'FLAT', size: 0, entry: null, stop: null, unrealized: 0 };
    pushActivity('Position flattened and risk reset.');
  }

  if (/buy/i.test(command)) {
    state.position = { side: 'LONG', size: 100, entry: state.market.price, stop: +(state.market.price - 1.5).toFixed(2), unrealized: 0 };
    pushActivity(`Manual macro BUY executed @ ${state.market.price}`);
  }

  if (/sell/i.test(command)) {
    state.position = { side: 'SHORT', size: 100, entry: state.market.price, stop: +(state.market.price + 1.5).toFixed(2), unrealized: 0 };
    pushActivity(`Manual macro SELL executed @ ${state.market.price}`);
  }

  broadcast({ type: 'state', state });
  res.json({ ok: true });
});

app.post('/api/rules/update', (req, res) => {
  const patch = req.body || {};
  state.rules = { ...state.rules, ...patch };
  pushActivity(`Rules updated live: ${Object.keys(patch).join(', ')}`);
  broadcast({ type: 'state', state });
  res.json({ ok: true, rules: state.rules });
});

app.post('/api/chat', (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ ok: false, error: 'message required' });
  state.chat.push({ role: 'user', message, t: Date.now() });

  let reply = `Live ${state.market.symbol} ${state.market.timeframe}: $${state.market.price} (${state.market.changePct}%). ` +
    `Bot=${state.bot.running ? 'RUNNING' : 'PAUSED'}, Position=${state.position.side} size ${state.position.size}, ` +
    `SessionPnL=$${state.account.sessionPnl}.`;

  if (/max trades/i.test(message)) {
    const m = message.match(/(\d+)/);
    if (m) {
      state.rules.maxTradesPerDay = Number(m[1]);
      reply += ` Updated maxTradesPerDay to ${m[1]}.`;
      pushActivity(`Chat rule change: maxTradesPerDay=${m[1]}`);
    }
  }

  if (/risk/i.test(message) && /%/.test(message)) {
    const m = message.match(/(\d+(?:\.\d+)?)\s*%/);
    if (m) {
      state.rules.riskPerTradePctEquity = Number(m[1]);
      reply += ` Updated riskPerTradePctEquity to ${m[1]}%.`;
      pushActivity(`Chat rule change: riskPerTradePctEquity=${m[1]}%`);
    }
  }

  state.chat.push({ role: 'assistant', message: reply, t: Date.now() });
  broadcast({ type: 'state', state });
  res.json({ ok: true, reply, state });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcast(payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}

const PORT = process.env.PORT || 4273;
server.listen(PORT, () => {
  console.log(`openclaw-control-ui running on http://localhost:${PORT}`);
});
