/**
 * Polymarket 模拟盘后端
 * - SQLite 存储持仓/余额
 * - 每5分钟自动扫描套利机会并执行
 * - REST API 供前端调用
 */

const http = require('http');
const https = require('https');
const url = require('url');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'sim.db');
const PROXY_PORT = 3721;
const API_PORT = 3722;
const INIT_BALANCE = 10000;
const USER_ID = 'contin'; // 单用户

// ── DB INIT ──
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    balance REAL NOT NULL DEFAULT ${INIT_BALANCE},
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    market_id TEXT NOT NULL,
    question TEXT NOT NULL,
    choice TEXT NOT NULL,
    amount REAL NOT NULL,
    prob REAL NOT NULL,
    payout REAL NOT NULL,
    strategy TEXT,
    opened_at INTEGER DEFAULT (strftime('%s','now')),
    closed_at INTEGER,
    close_price REAL,
    pnl REAL
  );
  CREATE TABLE IF NOT EXISTS arb_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy TEXT,
    market_id TEXT,
    question TEXT,
    choice TEXT,
    amount REAL,
    prob REAL,
    reason TEXT,
    ts INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// 初始化用户
const ensureUser = db.prepare(`INSERT OR IGNORE INTO users (id, balance) VALUES (?, ?)`);
ensureUser.run(USER_ID, INIT_BALANCE);

// ── HELPERS ──
function getUser() {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(USER_ID);
}
function getPositions() {
  return db.prepare('SELECT * FROM positions WHERE user_id = ? AND closed_at IS NULL ORDER BY opened_at DESC').all(USER_ID);
}
function fetchMarkets(offset = 0, limit = 100) {
  return new Promise((resolve, reject) => {
    const qs = `limit=${limit}&active=true&closed=false&order=volume24hr&ascending=false&offset=${offset}`;
    https.get(`https://gamma-api.polymarket.com/markets?${qs}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function parseMkt(m) {
  try {
    const prices = JSON.parse(m.outcomePrices || '[]');
    const yes = parseFloat(prices[0]);
    const no = parseFloat(prices[1] ?? (1 - yes));
    if (isNaN(yes)) return null;
    return {
      id: m.id,
      question: m.question,
      yes, no,
      vol: parseFloat(m.volume24hr ?? m.volume ?? '0'),
      end: (m.endDate ?? '').slice(0, 10),
      slug: m.slug || ''
    };
  } catch { return null; }
}

// ── ARBITRAGE STRATEGIES ──

/**
 * 时间序列套利：同主题市场，截止越晚YES应该越高
 * 发现 earlier.yes > later.yes 时，买 later YES
 */
function stratTimeSeries(markets) {
  const opportunities = [];
  const keywords = ['iran', 'ukraine', 'russia', 'netanyahu', 'bitcoin', 'btc', 'trump', 'fed rate'];

  for (const kw of keywords) {
    const group = markets
      .filter(m => m.question.toLowerCase().includes(kw) && m.end)
      .sort((a, b) => a.end.localeCompare(b.end));

    for (let i = 0; i < group.length - 1; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const early = group[i], late = group[j];
        // 晚截止的YES应该≥早截止的YES
        if (early.yes > late.yes + 0.05 && late.yes > 0.05 && late.yes < 0.95) {
          const edge = early.yes - late.yes;
          opportunities.push({
            strategy: 'time_series',
            market: late,
            choice: 'YES',
            edge,
            reason: `${kw.toUpperCase()}: 早截止(${early.end}) YES=${(early.yes*100).toFixed(1)}% > 晚截止(${late.end}) YES=${(late.yes*100).toFixed(1)}%, 价差${(edge*100).toFixed(1)}%`
          });
        }
      }
    }
  }
  return opportunities;
}

/**
 * 高确定性套利：YES > 92% 的市场，买 YES 低风险
 */
function stratHighConf(markets) {
  return markets
    .filter(m => m.yes >= 0.92 && m.yes < 0.999 && m.vol > 50000)
    .map(m => ({
      strategy: 'high_conf',
      market: m,
      choice: 'YES',
      edge: m.yes - 0.92,
      reason: `高确定性: YES=${(m.yes*100).toFixed(1)}%, 24h成交$${(m.vol/1000).toFixed(0)}K`
    }));
}

/**
 * 低概率反向套利：NO > 92% 的市场
 */
function stratHighConfNo(markets) {
  return markets
    .filter(m => m.no >= 0.92 && m.no < 0.999 && m.vol > 50000)
    .map(m => ({
      strategy: 'high_conf_no',
      market: m,
      choice: 'NO',
      edge: m.no - 0.92,
      reason: `高确定性NO: NO=${(m.no*100).toFixed(1)}%, 24h成交$${(m.vol/1000).toFixed(0)}K`
    }));
}

// ── AUTO TRADE ──
const MAX_BET = 300;
const MIN_EDGE = 0.04;
const MAX_POSITIONS = 20;

async function runArbitrage() {
  console.log(`[${new Date().toLocaleTimeString()}] 开始套利扫描...`);
  try {
    const raw = await fetchMarkets(0, 100);
    const markets = raw.map(parseMkt).filter(Boolean);

    const opps = [
      ...stratTimeSeries(markets),
      ...stratHighConf(markets),
      ...stratHighConfNo(markets),
    ].filter(o => o.edge >= MIN_EDGE)
     .sort((a, b) => b.edge - a.edge);

    const user = getUser();
    const openPos = getPositions();

    // 不重复买同一市场同一方向
    const openKeys = new Set(openPos.map(p => `${p.market_id}_${p.choice}`));

    let balance = user.balance;
    let count = 0;

    const insertPos = db.prepare(`
      INSERT INTO positions (user_id, market_id, question, choice, amount, prob, payout, strategy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateBal = db.prepare(`UPDATE users SET balance = ? WHERE id = ?`);
    const insertLog = db.prepare(`
      INSERT INTO arb_log (strategy, market_id, question, choice, amount, prob, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const opp of opps) {
      if (openPos.length + count >= MAX_POSITIONS) break;
      if (balance < 50) break;

      const key = `${opp.market.id}_${opp.choice}`;
      if (openKeys.has(key)) continue;

      // 根据 edge 决定下注金额
      const betAmt = Math.min(MAX_BET, Math.max(50, Math.round(opp.edge * 1000)));
      if (betAmt > balance) continue;

      const prob = opp.choice === 'YES' ? opp.market.yes : opp.market.no;
      const payout = betAmt / prob;

      insertPos.run(USER_ID, opp.market.id, opp.market.question, opp.choice, betAmt, prob, payout, opp.strategy);
      insertLog.run(opp.strategy, opp.market.id, opp.market.question, opp.choice, betAmt, prob, opp.reason);
      balance -= betAmt;
      openKeys.add(key);
      count++;

      console.log(`  ✅ [${opp.strategy}] ${opp.choice} $${betAmt} | ${opp.market.question.slice(0, 50)}`);
      console.log(`     ${opp.reason}`);
    }

    if (count > 0) {
      updateBal.run(balance, USER_ID);
      console.log(`  📊 本轮下注 ${count} 笔，余额剩 $${balance.toFixed(2)}`);
    } else {
      console.log('  ℹ️ 本轮无新套利机会');
    }

    // 自动平仓：接近到期(≤2天)且当前价格有利
    await autoClose(markets);

  } catch (e) {
    console.error('套利扫描出错:', e.message);
  }
}

async function autoClose(markets) {
  const mktMap = {};
  markets.forEach(m => { mktMap[m.id] = m; });

  const pos = getPositions();
  const now = new Date();
  const closePos = db.prepare(`UPDATE positions SET closed_at=strftime('%s','now'), close_price=?, pnl=? WHERE id=?`);
  const updateBal = db.prepare(`UPDATE users SET balance = balance + ? WHERE id = ?`);

  for (const p of pos) {
    const mkt = mktMap[p.market_id];
    if (!mkt) continue;

    const curProb = p.choice === 'YES' ? mkt.yes : mkt.no;
    const curVal = p.amount / p.prob * curProb;
    const pnl = curVal - p.amount;

    // 平仓条件：盈利>15% 或 接近到期且亏损
    const daysLeft = p.closed_at ? 0 : (new Date(mkt.end) - now) / 86400000;
    const profitPct = pnl / p.amount;

    if (profitPct >= 0.15 || (daysLeft <= 2 && pnl < 0)) {
      closePos.run(curProb, pnl, p.id);
      updateBal.run(curVal, USER_ID);
      console.log(`  🔄 平仓 [${p.choice}] ${p.question.slice(0,40)} PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
    }
  }
}

// ── HTTP API SERVER ──
const apiServer = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (p === '/sim/status') {
    const user = getUser();
    const positions = getPositions();
    const closed = db.prepare(`SELECT * FROM positions WHERE user_id = ? AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 20`).all(USER_ID);
    const totalPnl = closed.reduce((s, p) => s + (p.pnl || 0), 0);
    const logs = db.prepare(`SELECT * FROM arb_log ORDER BY ts DESC LIMIT 10`).all();
    res.writeHead(200);
    res.end(JSON.stringify({ balance: user.balance, positions, closed, totalPnl, logs }));

  } else if (p === '/sim/run') {
    runArbitrage().catch(console.error);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, message: '套利扫描已触发' }));

  } else if (p === '/sim/reset') {
    db.prepare(`UPDATE users SET balance = ? WHERE id = ?`).run(INIT_BALANCE, USER_ID);
    db.prepare(`DELETE FROM positions WHERE user_id = ?`).run(USER_ID);
    db.prepare(`DELETE FROM arb_log`).run();
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, balance: INIT_BALANCE }));

  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

apiServer.listen(3722, '127.0.0.1', () => {
  console.log('API server on :3722');
});

// ── PROXY SERVER (port 3721, same as before) ──
const proxyServer = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  if (!parsed.pathname.startsWith('/api/markets')) {
    res.writeHead(404); res.end('not found'); return;
  }
  const q = Object.assign({
    limit: '50', active: 'true', closed: 'false',
    order: 'volume24hr', ascending: 'false'
  }, parsed.query);
  const qs = new URLSearchParams(q).toString();
  https.get(`https://gamma-api.polymarket.com/markets?${qs}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  }, uRes => {
    res.writeHead(uRes.statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=30'
    });
    uRes.pipe(res);
  }).on('error', e => {
    res.writeHead(502); res.end(JSON.stringify({ error: e.message }));
  });
});

proxyServer.listen(3721, '127.0.0.1', () => {
  console.log('Proxy server on :3721');
  // 启动时立即跑一次
  runArbitrage();
  // 每5分钟跑一次
  setInterval(runArbitrage, 5 * 60 * 1000);
});
