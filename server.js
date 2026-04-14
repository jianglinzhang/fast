// ============================================================
//  DoH Server for Render (Node.js)
//  部署：Render Web Service, Region: Singapore
//  环境：Node 18+
// ============================================================

import express from 'express';

const app = express();
const PORT = process.env.PORT || 10000;

// ==================== 配置 ====================
const UPSTREAMS = [
  'https://dns.google/dns-query',           // Google 有新加坡节点
  'https://cloudflare-dns.com/dns-query',   // CF 也有亚洲节点
  'https://dns.nextdns.io/dns-query',       // 备选
];

const MIN_TTL = 300;
const MAX_TTL = 86400;
const NEGATIVE_TTL = 120;

// ==================== 内存缓存 ====================
// Render 是持久进程，内存缓存非常有效
const cache = new Map();
const MAX_CACHE_SIZE = 50000;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  const age = Date.now() - entry.time;
  // 还在 TTL 内
  if (age < entry.ttl * 1000) return { ...entry, status: 'HIT' };
  // 在 stale 窗口内（额外1小时）
  if (age < (entry.ttl + 3600) * 1000) return { ...entry, status: 'STALE' };
  // 彻底过期
  cache.delete(key);
  return null;
}

function cacheSet(key, data, contentType, ttl) {
  // LRU 简易淘汰
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, {
    data,
    contentType,
    ttl: clamp(ttl),
    time: Date.now(),
  });
}

function clamp(t) { return Math.max(MIN_TTL, Math.min(t, MAX_TTL)); }

// ==================== Base64url ====================
function b64encode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function b64decode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

// DNS wire 前2字节是随机 Transaction ID，清零做缓存键
function stableWireKey(dns64) {
  try {
    const buf = Buffer.from(b64decode(dns64));
    buf[0] = 0;
    buf[1] = 0;
    return b64encode(buf);
  } catch {
    return dns64;
  }
}

// ==================== 竞速上游 ====================
async function raceUpstream(buildReq) {
  const controller1 = new AbortController();
  const controller2 = new AbortController();

  const p1 = buildReq(UPSTREAMS[0], controller1.signal)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      controller2.abort();
      return r;
    });

  // 给第一个 100ms 优势
  const p2 = new Promise(r => setTimeout(r, 100))
    .then(() => buildReq(UPSTREAMS[1], controller2.signal))
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      controller1.abort();
      return r;
    });

  try {
    return await Promise.any([p1, p2]);
  } catch {
    // 都失败了，试第三个
    try {
      return await buildReq(UPSTREAMS[2], AbortSignal.timeout(5000));
    } catch {
      throw new Error('All upstreams failed');
    }
  }
}

// ==================== TTL 解析 ====================
function extractTtl(buf) {
  try {
    const v = new DataView(buf.buffer || buf, buf.byteOffset || 0);
    const qd = v.getUint16(4), an = v.getUint16(6);
    let o = 12;
    for (let i = 0; i < qd; i++) { o = skipN(v, o); o += 4; }
    if (an === 0) return NEGATIVE_TTL;
    let min = 0xFFFFFFFF;
    for (let i = 0; i < an; i++) {
      o = skipN(v, o);
      const t = v.getUint32(o + 4);
      if (t < min) min = t;
      o += 10 + v.getUint16(o + 8);
    }
    return min;
  } catch { return 300; }
}

function skipN(v, o) {
  while (o < v.byteLength) {
    const l = v.getUint8(o);
    if (l === 0) return o + 1;
    if ((l & 0xc0) === 0xc0) return o + 2;
    o += 1 + l;
  }
  return o;
}

// ==================== CORS ====================
function cors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Accept');
  res.set('Access-Control-Max-Age', '86400');
}

// ==================== 路由 ====================

// 解析 raw body
app.use('/dns-query', express.raw({
  type: 'application/dns-message',
  limit: '4kb',
}));

app.options('*', (req, res) => {
  cors(res);
  res.status(204).end();
});

// JSON DoH: /dns-query?name=xxx&type=A
app.get('/dns-query', async (req, res) => {
  cors(res);

  if (req.query.name) {
    return await handleJson(req, res);
  }
  if (req.query.dns) {
    return await handleWireGet(req, res);
  }
  res.status(400).json({ error: 'Missing name or dns parameter' });
});

// Wire POST
app.post('/dns-query', async (req, res) => {
  cors(res);
  try {
    const body = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(await readBody(req));

    const dns64 = b64encode(body);
    const sk = stableWireKey(dns64);
    const ck = `w:${sk}`;

    // 查缓存
    const hit = cacheGet(ck);
    if (hit) {
      res.set('Content-Type', 'application/dns-message');
      res.set('X-Cache', hit.status);
      // stale 时后台刷新
      if (hit.status === 'STALE') {
        refreshWire(dns64, ck).catch(() => {});
      }
      return res.send(Buffer.from(hit.data));
    }

    const upstream = await raceUpstream((u, signal) =>
      fetch(`${u}?dns=${dns64}`, {
        headers: { Accept: 'application/dns-message' },
        signal,
      })
    );
    const data = Buffer.from(await upstream.arrayBuffer());
    const ttl = extractTtl(data);
    cacheSet(ck, data, 'application/dns-message', ttl);

    res.set('Content-Type', 'application/dns-message');
    res.set('X-Cache', 'MISS');
    res.send(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Wire GET
async function handleWireGet(req, res) {
  try {
    const dns64 = req.query.dns;
    const sk = stableWireKey(dns64);
    const ck = `w:${sk}`;

    const hit = cacheGet(ck);
    if (hit) {
      res.set('Content-Type', 'application/dns-message');
      res.set('X-Cache', hit.status);
      if (hit.status === 'STALE') refreshWire(dns64, ck).catch(() => {});
      return res.send(Buffer.from(hit.data));
    }

    const upstream = await raceUpstream((u, signal) =>
      fetch(`${u}?dns=${dns64}`, {
        headers: { Accept: 'application/dns-message' },
        signal,
      })
    );
    const data = Buffer.from(await upstream.arrayBuffer());
    const ttl = extractTtl(data);
    cacheSet(ck, data, 'application/dns-message', ttl);

    res.set('Content-Type', 'application/dns-message');
    res.set('X-Cache', 'MISS');
    res.send(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}

async function refreshWire(dns64, ck) {
  const r = await fetch(`${UPSTREAMS[0]}?dns=${dns64}`, {
    headers: { Accept: 'application/dns-message' },
  });
  if (!r.ok) return;
  const data = Buffer.from(await r.arrayBuffer());
  cacheSet(ck, data, 'application/dns-message', extractTtl(data));
}

// JSON format
async function handleJson(req, res) {
  try {
    const name = req.query.name;
    const type = (req.query.type || 'A').toUpperCase();
    const ck = `j:${name}:${type}`;

    const hit = cacheGet(ck);
    if (hit) {
      res.set('Content-Type', 'application/dns-json');
      res.set('X-Cache', hit.status);
      if (hit.status === 'STALE') refreshJson(name, type, ck).catch(() => {});
      return res.send(hit.data);
    }

    const upstream = await raceUpstream((u, signal) =>
      fetch(`${u}?name=${encodeURIComponent(name)}&type=${type}`, {
        headers: { Accept: 'application/dns-json' },
        signal,
      })
    );
    const data = await upstream.text();
    let ttl = 300;
    try {
      const j = JSON.parse(data);
      if (j.Answer?.length) ttl = Math.min(...j.Answer.map(a => a.TTL || 300));
      else ttl = NEGATIVE_TTL;
    } catch {}
    cacheSet(ck, data, 'application/dns-json', ttl);

    res.set('Content-Type', 'application/dns-json');
    res.set('X-Cache', 'MISS');
    res.send(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}

async function refreshJson(name, type, ck) {
  const r = await fetch(
    `${UPSTREAMS[0]}?name=${encodeURIComponent(name)}&type=${type}`,
    { headers: { Accept: 'application/dns-json' } }
  );
  if (!r.ok) return;
  const data = await r.text();
  let ttl = 300;
  try {
    const j = JSON.parse(data);
    if (j.Answer?.length) ttl = Math.min(...j.Answer.map(a => a.TTL || 300));
  } catch {}
  cacheSet(ck, data, 'application/dns-json', ttl);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ==================== 首页 ====================
app.get('/', (req, res) => {
  if (req.query.name || req.query.dns) {
    // 兼容 / 路径的 DoH 请求
    cors(res);
    if (req.query.name) return handleJson(req, res);
    if (req.query.dns) return handleWireGet(req, res);
  }

  const origin = `${req.protocol}://${req.get('host')}`;
  const ep = `${origin}/dns-query`;
  cors(res);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderHome(ep));
});

// ==================== 健康检查 ====================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cache_size: cache.size,
    uptime: process.uptime(),
  });
});

// ==================== 缓存统计 ====================
app.get('/stats', (req, res) => {
  cors(res);
  let fresh = 0, stale = 0, expired = 0;
  const now = Date.now();
  for (const [, v] of cache) {
    const age = now - v.time;
    if (age < v.ttl * 1000) fresh++;
    else if (age < (v.ttl + 3600) * 1000) stale++;
    else expired++;
  }
  res.json({ total: cache.size, fresh, stale, expired });
});

// ==================== 启动 ====================
app.listen(PORT, () => {
  console.log(`DoH server running on port ${PORT}`);
  console.log(`Upstreams: ${UPSTREAMS.join(', ')}`);
});

// ==================== 首页 HTML ====================
function renderHome(ep) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DoH Server</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.c{max-width:720px;width:100%;background:rgba(255,255,255,.05);border-radius:16px;padding:40px;backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.1)}
h1{font-size:2em;margin-bottom:8px;background:linear-gradient(90deg,#f093fb,#f5576c,#4facfe);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sub{color:#aaa;margin-bottom:25px}
h2{font-size:1.15em;color:#4facfe;margin:22px 0 8px}
.ep{background:rgba(0,0,0,.3);border:1px solid rgba(79,172,254,.3);border-radius:8px;padding:14px;font-family:monospace;font-size:1.05em;word-break:break-all;color:#4facfe;cursor:pointer;transition:.3s}
.ep:hover{background:rgba(79,172,254,.1)}.ep.ok{border-color:#00ff64}
.h{font-size:.83em;color:#888;margin-top:4px}
.box{background:rgba(79,172,254,.08);border:1px solid rgba(79,172,254,.15);border-radius:8px;padding:14px;margin-top:8px;font-size:.9em;line-height:1.7}
.ts{margin-top:20px;padding:18px;background:rgba(0,0,0,.2);border-radius:8px}
.tr{display:flex;gap:8px;flex-wrap:wrap}
.ts input{flex:1;min-width:140px;padding:9px 12px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.3);color:#fff;font-size:1em}
.ts select{padding:9px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.3);color:#fff}
.ts button{padding:9px 22px;border-radius:6px;border:none;background:linear-gradient(90deg,#4facfe,#00f2fe);color:#000;font-weight:bold;cursor:pointer}
.ts button:disabled{opacity:.5}
#r{margin-top:12px;padding:12px;background:rgba(0,0,0,.3);border-radius:6px;font-family:monospace;white-space:pre-wrap;font-size:.84em;max-height:280px;overflow-y:auto;display:none;line-height:1.5}
.st{margin:18px 0;text-align:center;font-size:.95em}
.d{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
.d.g{background:#00ff64;box-shadow:0 0 6px #00ff64}
.d.r{background:#f44;box-shadow:0 0 6px #f44}
.d.y{background:#fa0;box-shadow:0 0 6px #fa0;animation:p 1s infinite}
@keyframes p{50%{opacity:.4}}
.info{background:rgba(0,255,100,.08);border:1px solid rgba(0,255,100,.2);border-radius:8px;padding:14px;margin-top:8px;font-size:.88em;line-height:1.7;color:#a0ffb0}
</style></head><body><div class="c">
<h1>🔒 DoH Server</h1>
<p class="sub">DNS over HTTPS · Singapore Node</p>
<div class="st"><span class="d y" id="sd"></span><span id="st">检测中...</span></div>
<h2>📡 端点</h2>
<div class="ep" id="ep" onclick="cp()">${ep}</div>
<p class="h" id="ch">点击复制</p>
<h2>⚡ 优势</h2>
<div class="info">
✅ 新加坡节点，亚洲延迟低<br>
✅ 内存缓存，重复查询 < 5ms<br>
✅ 多上游竞速，自动选最快<br>
✅ Stale-While-Revalidate，缓存过期不卡顿
</div>
<h2>🌐 设置</h2>
<div class="box">
<strong>Chrome/Edge：</strong>设置→隐私和安全→安全→安全DNS→自定义<br>
<strong>Firefox：</strong>设置→隐私与安全→DNS over HTTPS→自定义
</div>
<h2>🧪 测试</h2>
<div class="ts"><div class="tr">
<input id="dm" value="google.com" placeholder="域名"/>
<select id="qt"><option>A</option><option>AAAA</option><option>CNAME</option><option>MX</option><option>TXT</option><option>NS</option></select>
<button id="btn" onclick="q()">查询</button>
<button onclick="q();setTimeout(q,1e3)" style="background:linear-gradient(90deg,#f093fb,#f5576c);font-size:.85em">查2次</button>
</div><div id="r"></div></div>
</div>
<script>
const E='${ep}';
function cp(){navigator.clipboard.writeText(E).then(()=>{document.getElementById('ep').classList.add('ok');document.getElementById('ch').textContent='✅ 已复制';setTimeout(()=>{document.getElementById('ep').classList.remove('ok');document.getElementById('ch').textContent='点击复制'},2e3)})}
async function q(){
const d=document.getElementById('dm').value.trim(),t=document.getElementById('qt').value,b=document.getElementById('btn'),r=document.getElementById('r');
if(!d)return;b.disabled=1;r.style.display='block';
r.textContent+='\\n⏳ '+d+' '+t+'...\\n';
const s=performance.now();
try{const f=await fetch(E+'?name='+encodeURIComponent(d)+'&type='+t,{headers:{Accept:'application/dns-json'}});
const ms=Math.round(performance.now()-s),xc=f.headers.get('X-Cache')||'-';
if(!f.ok){r.textContent+='❌ HTTP '+f.status+'\\n';return}
const j=await f.json(),ic=xc==='HIT'?'⚡':xc==='STALE'?'♻️':'🌐';
let o=ic+' '+ms+'ms Cache:'+xc+'\\n';
if(j.Answer?.length){const m={1:'A',2:'NS',5:'CNAME',15:'MX',16:'TXT',28:'AAAA'};
j.Answer.forEach(a=>{o+='  '+(m[a.type]||a.type)+' '+a.data+' TTL:'+a.TTL+'\\n'})}
else o+='  ⚠️ 无记录\\n';
r.textContent+=o;r.scrollTop=r.scrollHeight}
catch(e){r.textContent+='❌ '+e.message+'\\n'}finally{b.disabled=0}}
(async()=>{const sd=document.getElementById('sd'),st=document.getElementById('st');
try{const s=performance.now(),f=await fetch(E+'?name=cloudflare.com&type=A',{headers:{Accept:'application/dns-json'}});
const ms=Math.round(performance.now()-s);
if(f.ok){sd.className='d g';st.textContent='✅ '+ms+'ms'}
else{sd.className='d r';st.textContent='❌ HTTP '+f.status}}
catch{sd.className='d r';st.textContent='不可达'}})();
document.getElementById('dm').addEventListener('keydown',e=>{if(e.key==='Enter')q()});
</script></body></html>`;
}
