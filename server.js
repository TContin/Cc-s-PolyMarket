/**
 * Polymarket 模拟盘后端
 * - SQLite 存储持仓/余额
 * - 每5分钟自动扫描套利机会并执行
 * - REST API 供前端调用
 */

const http = require('http');
const https = require('https');

// ── BTC 实时价格缓存 ──
let btcPrice = null;
let btcPriceTs = 0;

async function getBtcPrice() {
  const now = Date.now();
  if (btcPrice && now - btcPriceTs < 30000) return btcPrice; // 30秒缓存
  return new Promise((resolve) => {
    https.get('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          btcPrice = parseFloat(data.price);
          btcPriceTs = now;
          resolve(btcPrice);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}
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
// 核心原则：只做 ≤3 天内结算的市场，当日或次日见钱

/**
 * 有效市场过滤：只要 1-72 小时内结算的
 */
function isValidMarket(m) {
  if (!m.end) return false;
  const hoursLeft = (new Date(m.end) - new Date()) / 3600000;
  return hoursLeft >= 1 && hoursLeft <= 72; // 1小时到3天
}

/**
 * 【策略1】短线 Bundle 缺口
 * YES + NO < 0.96 且当天/明天结算 → 无风险套利
 * 体育盘口（NBA/NFL/Soccer）最常出现
 */
function stratShortBundle(markets) {
  const opps = [];
  for (const m of markets) {
    if (!isValidMarket(m) || m.vol < 20000) continue;
    const sum = m.yes + m.no;
    if (sum < 0.96 && sum > 0.40) {
      const edge = 1 - sum;
      const choice = m.yes <= m.no ? 'YES' : 'NO';
      const prob = choice === 'YES' ? m.yes : m.no;
      const hoursLeft = Math.round((new Date(m.end) - new Date()) / 3600000);
      opps.push({
        strategy: 'short_bundle',
        market: m,
        choice,
        edge,
        reason: `Bundle缺口: YES(${(m.yes*100).toFixed(1)}%)+NO(${(m.no*100).toFixed(1)}%)=${(sum*100).toFixed(1)}%<100%, 空间${(edge*100).toFixed(1)}%, ${hoursLeft}小时后结算, vol=$${(m.vol/1000).toFixed(0)}K`
      });
    }
  }
  return opps;
}

/**
 * 【策略2】BTC 当日价格锚定
 * 用 Binance 实时价格 vs Polymarket 今日/明日价格市场
 * 理论概率 vs 市场定价差 > 8% 即买入
 */
async function stratCryptoAnchor(markets, currentBtcPrice) {
  if (!currentBtcPrice) return [];
  const opps = [];
  const dailyVol = 0.025; // BTC 日波动率约 2.5%

  const btcMarkets = markets.filter(m => {
    if (!isValidMarket(m)) return false;
    if (m.vol < 30000) return false;
    const q = m.question.toLowerCase();
    return (q.includes('bitcoin') || q.includes('btc')) &&
           (q.includes('above') || q.includes('below') || q.includes('reach') || q.includes('dip'));
  });

  for (const m of btcMarkets) {
    const priceMatch = m.question.match(/\$([0-9,]+)/);
    if (!priceMatch) continue;
    const targetPrice = parseFloat(priceMatch[1].replace(',', ''));
    const hoursLeft = (new Date(m.end) - new Date()) / 3600000;
    const daysLeft = hoursLeft / 24;

    const vol = dailyVol * Math.sqrt(Math.max(daysLeft, 0.04));
    const z = Math.log(targetPrice / currentBtcPrice) / vol;
    const cdf = 0.5 * (1 + erf(z / Math.sqrt(2)));
    const theoretical = 1 - cdf; // P(BTC > target)

    const isAbove = m.question.toLowerCase().includes('above') || m.question.toLowerCase().includes('reach');
    const marketProb = isAbove ? m.yes : m.no;
    const theoreticalForSide = isAbove ? theoretical : (1 - theoretical);
    const diff = theoreticalForSide - marketProb;

    if (diff > 0.08 && theoreticalForSide > 0.10 && theoreticalForSide < 0.92) {
      opps.push({
        strategy: 'crypto_anchor',
        market: m,
        choice: isAbove ? 'YES' : 'NO',
        edge: diff,
        reason: `BTC锚定: 现价=$${currentBtcPrice.toFixed(0)}, 目标=$${targetPrice.toLocaleString()}, 理论=${(theoreticalForSide*100).toFixed(1)}%>市场${(marketProb*100).toFixed(1)}%, 差${(diff*100).toFixed(1)}%, ${Math.round(hoursLeft)}h后结算`
      });
    }
  }
  return opps;
}

function erf(x) {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign=x<0?-1:1; x=Math.abs(x);
  const t=1/(1+p*x);
  return sign*(1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x));
}

/**
 * 【策略3】BTC 阶梯价格套利（短线版）
 * 同一截止日期，P(BTC>低门槛) 必须 >= P(BTC>高门槛)
 * 逆序即买入被低估的
 */
function stratCryptoLadder(markets) {
  const opps = [];
  const btcAbove = markets.filter(m =>
    isValidMarket(m) && m.vol > 20000 &&
    (m.question.toLowerCase().includes('bitcoin') || m.question.toLowerCase().includes('btc')) &&
    (m.question.toLowerCase().includes('above') || m.question.toLowerCase().includes('reach'))
  ).map(m => {
    const pm = m.question.match(/\$([0-9,]+)/);
    if (!pm) return null;
    return { ...m, targetPrice: parseFloat(pm[1].replace(',','')) };
  }).filter(Boolean);

  const byDate = {};
  btcAbove.forEach(m => {
    const key = m.end?.slice(0, 13) || 'unknown';
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(m);
  });

  for (const group of Object.values(byDate)) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.targetPrice - b.targetPrice);
    for (let i = 0; i < group.length - 1; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const lo = group[i], hi = group[j];
        const diff = hi.yes - lo.yes;
        if (diff > 0.06) {
          const hoursLeft = Math.round((new Date(lo.end) - new Date()) / 3600000);
          opps.push({
            strategy: 'crypto_ladder',
            market: lo,
            choice: 'YES',
            edge: diff,
            reason: `BTC阶梯: P(>$${lo.targetPrice.toLocaleString()})=${(lo.yes*100).toFixed(1)}% < P(>$${hi.targetPrice.toLocaleString()})=${(hi.yes*100).toFixed(1)}%, 逻辑矛盾, ${hoursLeft}h结算`
          });
        }
      }
    }
  }
  return opps;
}

/**
 * 【策略4】短线高动量（今日结算 + 概率 45-75% + 超高流动性）
 * 今天结算的市场，概率接近50/50，说明真正有悬念，赔率好
 * 流动性 > $500K 才碰（保证真实盘也能成交）
 */
function stratTodayMomentum(markets) {
  return markets.filter(m => {
    if (!isValidMarket(m)) return false;
    const hoursLeft = (new Date(m.end) - new Date()) / 3600000;
    return hoursLeft <= 24              // 今天结算
      && m.yes >= 0.45 && m.yes <= 0.75 // 概率接近50/50，有悬念
      && m.vol > 500000;                // 超高流动性（$50万/天）
  }).map(m => {
    const hoursLeft = Math.round((new Date(m.end) - new Date()) / 3600000);
    const edge = Math.abs(m.yes - 0.5) + 0.08; // 偏离50%越多，edge越高
    return {
      strategy: 'today_momentum',
      market: m,
      choice: m.yes >= 0.5 ? 'YES' : 'NO', // 押概率更高的方向
      edge,
      reason: `今日高流动性: ${hoursLeft}h后结算, YES=${(m.yes*100).toFixed(1)}%, vol=$${(m.vol/1000).toFixed(0)}K`
    };
  });
}

// 过期判断
function isValidMarket(m) {
  if (!m.end) return true;
  const daysLeft = (new Date(m.end) - new Date()) / 86400000;
  return daysLeft > 2; // 至少2天才到期（否则流动性枯竭）
}

// 真实盈利过滤（扣手续费+滑点后仍正）
function filterRealProfit(opps) {
  return opps.map(o => {
    const prob = o.choice === 'YES' ? o.market.yes : o.market.no;
    const { realEdge, totalCostRate } = realPayout(100, prob, o.market.vol);
    return { ...o, realEdge, totalCostRate };
  }).filter(o => o.realEdge > 0.02); // 真实净利润 > 2%
}

// ── AUTO TRADE ──
const MAX_BET = 500; // 短线，结算快，可以下稍大
const MIN_EDGE = 0.06; // 短线策略，6%以上即可（手续费2.5%后仍有3.5%净利）

// ── 真实盘交易成本模拟 ──
const FEE_RATE = 0.02;       // Polymarket 手续费 2%
const BASE_SLIPPAGE = 0.005; // 基础滑点 0.5%

// 按流动性估算滑点（流动性越低越高）
function calcSlippage(vol24h, betAmt) {
  if (vol24h > 1000000) return 0.002;  // 高流动性 0.2%
  if (vol24h > 100000)  return 0.005;  // 中流动性 0.5%
  if (vol24h > 10000)   return 0.012;  // 低流动性 1.2%
  return 0.025;                         // 极低流动性 2.5%
}

// 真实盘实际成本：手续费 + 滑点
function realCost(amount, vol24h) {
  const slippage = calcSlippage(vol24h, amount);
  const totalCost = FEE_RATE + slippage;
  return {
    effectiveAmt: amount * (1 - totalCost), // 实际生效金额
    fee: amount * FEE_RATE,
    slippage: amount * slippage,
    totalCostRate: totalCost
  };
}

// 真实盘实际回报（扣除成本）
function realPayout(amount, prob, vol24h) {
  const { effectiveAmt, fee, slippage, totalCostRate } = realCost(amount, vol24h);
  const grossPayout = effectiveAmt / prob;
  const netProfit = grossPayout - amount; // 扣除全部成本后净利润
  const realEdge = netProfit / amount;    // 真实利润率
  return { grossPayout, netProfit, realEdge, fee, slippage, totalCostRate };
}
const MAX_POSITIONS = 20;

async function runArbitrage() {
  console.log(`[${new Date().toLocaleTimeString()}] 开始套利扫描...`);
  try {
    const raw = await fetchMarkets(0, 100);
    const markets = raw.map(parseMkt).filter(Boolean);

    // 拉 BTC 实时价格
    const btcPrice = await getBtcPrice();
    console.log(`  BTC 实时价格: $${btcPrice?.toFixed(0) || 'N/A'}`);

    const cryptoOpps = await stratCryptoAnchor(markets, btcPrice);

    const rawOpps = [
      ...stratShortBundle(markets),   // 策略1: Bundle缺口（当日/明日）
      ...cryptoOpps,                  // 策略2: BTC价格锚定
      ...stratCryptoLadder(markets),  // 策略3: BTC阶梯套利
      ...stratTodayMomentum(markets), // 策略4: 今日高流动性动量
    ].filter(o => o.edge >= MIN_EDGE);

    const opps = filterRealProfit(rawOpps, markets)
      .sort((a, b) => b.realEdge - a.realEdge); // 按真实收益率排序

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

      // 禁止自我对冲：同市场已有反向仓则跳过
      const reverseKey = `${opp.market.id}_${opp.choice === 'YES' ? 'NO' : 'YES'}`;
      if (openKeys.has(reverseKey)) continue;

      // 根据 edge 决定下注金额
      const betAmt = Math.min(MAX_BET, Math.max(50, Math.round(opp.edge * 1000)));
      if (betAmt > balance) continue;

      const prob = opp.choice === 'YES' ? opp.market.yes : opp.market.no;
      const { grossPayout, netProfit, realEdge, totalCostRate } = realPayout(betAmt, prob, opp.market.vol);
      const payout = grossPayout; // 存真实回报（扣手续费+滑点）

      const fullReason = opp.reason +
        ` | 手续费+滑点=${(totalCostRate*100).toFixed(1)}% | 真实净利润率=${(realEdge*100).toFixed(1)}%`;

      insertPos.run(USER_ID, opp.market.id, opp.market.question, opp.choice, betAmt, prob, payout, opp.strategy);
      insertLog.run(opp.strategy, opp.market.id, opp.market.question, opp.choice, betAmt, prob, fullReason);
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
