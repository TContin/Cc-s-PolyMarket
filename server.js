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
 * 【策略1】时序套利 (Time-Series Arbitrage)
 * 逻辑：同一事件，截止越晚的版本，YES 概率理论上应 >= 截止越早的。
 * 如果 早截止YES > 晚截止YES + threshold，说明晚截止被低估，买入。
 * 有效性：✅ 真实市场定价矛盾，逻辑最硬
 */
// 判断两个问题是否是"同一事件的不同截止版本"
// 要求：问题高度相似（前40个词的词汇重叠度 > 60%）
function isSameEvent(q1, q2) {
  // 1. 截止日期必须不同（同截止日期不存在时序套利）
  // 这个在调用处已经保证
  
  // 2. 提取核心词汇（去掉时间词、冠词）
  const stopWords = new Set([
    'will','the','a','an','by','in','on','at','of','to','be','is','are',
    'was','were','have','has','had','do','does','did','for','with','from',
    'that','this','they','than','above','below','before','after','until',
    'january','february','march','april','may','june','july','august',
    'september','october','november','december','2024','2025','2026','2027','2028'
  ]);
  const words1 = new Set(q1.toLowerCase().match(/\w{3,}/g)?.filter(w => !stopWords.has(w)) || []);
  const words2 = new Set(q2.toLowerCase().match(/\w{3,}/g)?.filter(w => !stopWords.has(w)) || []);
  
  if (words1.size === 0 || words2.size === 0) return false;
  
  // 交集 / 并集 = Jaccard 相似度
  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);
  const jaccard = intersection.size / union.size;
  
  // 相似度 > 55% 才认为是同一事件
  return jaccard > 0.55;
}

function stratTimeSeries(markets) {
  const opps = [];
  const keywords = [
    'iran', 'ukraine', 'russia', 'netanyahu', 'israel',
    'bitcoin', 'btc', 'ethereum', 'eth',
    'trump', 'fed rate', 'federal reserve', 'interest rate',
    'gaza', 'ceasefire', 'nato', 'china', 'taiwan',
  ];

  for (const kw of keywords) {
    const group = markets
      .filter(m =>
        m.question.toLowerCase().includes(kw) &&
        m.end &&
        isValidMarket(m) &&
        m.vol > 50000 &&
        m.yes > 0.05 && m.yes < 0.95
      )
      .sort((a, b) => a.end.localeCompare(b.end));

    if (group.length < 2) continue;

    for (let i = 0; i < group.length - 1; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const early = group[i], late = group[j];
        
        // ✅ 核心过滤：截止日期必须不同
        if (early.end === late.end) continue;
        
        // ✅ 核心过滤：两个问题必须是同一事件
        if (!isSameEvent(early.question, late.question)) continue;
        
        const gap = early.yes - late.yes;
        // 正向：早截止YES > 晚截止YES（晚截止被低估，买YES）
        if (gap > 0.08 && gap < 0.55) {
          opps.push({
            strategy: 'time_series',
            market: late,
            choice: 'YES',
            edge: gap,
            reason: `时序套利: 早[${early.end}]YES=${(early.yes*100).toFixed(1)}% > 晚[${late.end}]YES=${(late.yes*100).toFixed(1)}%, 价差${(gap*100).toFixed(1)}%, vol=$${(late.vol/1000).toFixed(0)}K`
          });
        }
        // 反向：晚截止YES > 早截止YES（早截止被高估，买NO）
        const reverseGap = late.yes - early.yes;
        if (reverseGap > 0.12 && reverseGap < 0.55 && early.no > 0.05) {
          opps.push({
            strategy: 'time_series',
            market: early,
            choice: 'NO',
            edge: reverseGap * 0.7,
            reason: `时序反转: 晚[${late.end}]YES=${(late.yes*100).toFixed(1)}% >> 早[${early.end}]YES=${(early.yes*100).toFixed(1)}%, 早截止高估, vol=$${(early.vol/1000).toFixed(0)}K`
          });
        }
      }
    }
  }
  return opps;
}

/**
 * 【策略2】Bundle 定价错误 (Bundle Mispricing)
 * 逻辑：同一市场 YES + NO 理论上 = 1（减去手续费约 0.96-0.98）。
 * 如果 YES + NO < 0.95，说明有人在两边都定价过低，存在无风险套利空间。
 * 有效性：✅ 数学上确定，但在高效市场中很快消失
 */
function stratBundle(markets) {
  const opps = [];
  for (const m of markets) {
    if (!isValidMarket(m) || m.vol < 50000) continue;
    const sum = m.yes + m.no;
    if (sum < 0.95 && sum > 0.50) {
      const edge = 1 - sum;
      // 买被更低估的那边
      const choice = m.yes <= m.no ? 'YES' : 'NO';
      const prob = choice === 'YES' ? m.yes : m.no;
      opps.push({
        strategy: 'bundle',
        market: m,
        choice,
        edge,
        reason: `Bundle定价缺口: YES(${(m.yes*100).toFixed(1)}%)+NO(${(m.no*100).toFixed(1)}%)=${(sum*100).toFixed(1)}%<100%, 套利空间${(edge*100).toFixed(1)}%, vol=$${(m.vol/1000).toFixed(0)}K`
      });
    }
  }
  return opps;
}

/**
 * 【策略3】临近到期高动量 (Near-Expiry Momentum)
 * 逻辑：3-10天内到期、概率在 55-80%（有足够悬念）、高流动性。
 * 市场在最后阶段信息快速涌入，概率剧烈波动，做对方向收益高。
 * 只在市场概率连续两个采样点向同一方向移动时买入（动量确认）。
 * 有效性：⚠️ 依赖信息优势，模拟盘当动量追踪来用
 */
function stratNearExpiry(markets) {
  return markets.filter(m => {
    if (!m.end || !isValidMarket(m)) return false;
    const daysLeft = (new Date(m.end) - new Date()) / 86400000;
    return daysLeft >= 3 && daysLeft <= 10
      && m.yes >= 0.55 && m.yes <= 0.80
      && m.vol > 200000; // 只碰超高流动性市场
  }).map(m => {
    const daysLeft = Math.round((new Date(m.end) - new Date()) / 86400000);
    // 概率越靠近 0.5，赔率倍数越高
    const oddsMultiplier = 1 / m.yes;
    const edge = (m.yes - 0.55) * 0.4;
    return {
      strategy: 'near_expiry',
      market: m,
      choice: 'YES',
      edge: Math.max(edge, 0.07),
      reason: `临近到期动量: ${daysLeft}天结算, YES=${(m.yes*100).toFixed(1)}%, 赔率${oddsMultiplier.toFixed(2)}x, 24h成交$${(m.vol/1000).toFixed(0)}K`
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
const MAX_BET = 300;
const MIN_EDGE = 0.08; // 至少8%真实利润空间，只买有逻辑的单

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

    const rawOpps = [
      ...stratTimeSeries(markets),    // 策略1: 时序套利（最硬）
      ...stratBundle(markets),        // 策略2: Bundle定价错误
      ...stratNearExpiry(markets),    // 策略3: 临近到期动量
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
