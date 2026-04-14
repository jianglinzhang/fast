// server.js
import express from 'express';

const app = express();
const PORT = process.env.PORT || 10000;

// ==================== 配置 ====================
const UPSTREAMS = [
  'https://dns.google/dns-query',
  'https://cloudflare-dns.com/dns-query',
];

const MIN_TTL = 300;
const MAX_TTL = 86400;
const NEGATIVE_TTL = 120;

// ==================== 内存缓存 ====================
const cache = new Map();
const MAX_CACHE_SIZE = 50000;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  const age = Date.now() - entry.time;
  if (age < entry.ttl * 1000) return { ...entry, status: 'HIT' };
  if (age < (entry.ttl + 3600) * 1000) return { ...entry, status: 'STALE' };
  cache.delete(key);
  return null;
}

function cacheSet(key, data, contentType, ttl) {
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { data, contentType, ttl: clamp(ttl), time: Date.now() });
}

function clamp(t) { return Math.max(MIN_TTL, Math.min(t, MAX_TTL)); }

// ==================== Base64url ====================
function b64encode(buf) {
  return Buffer.from(buf).toString('base64url');  // ★ FIX: Node 原生 base64url
}

function b64decode(str) {
  return Buffer.from(str, 'base64url');  // ★ FIX
}

function stableWireKey(dns64) {
  try {
    const buf = Buffer.from(b64decode(dns64));
    buf[0] = 0; buf[1] = 0;
    return b64encode(buf);
  } catch { return dns64; }
}

// ==================== 上游请求 ====================
// ★ FIX: 不用竞速了，简单可靠的 fallback，避免 AbortController 兼容问题
async function fetchUpstream(buildUrl, headers) {
  for (const base of UPSTREAMS) {
    try {
      const url = buildUrl(base);
      const resp = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(5000),  // 5秒超时
      });
      if (resp.ok) return resp;
    } catch (e) {
      console.error(`Upstream ${base} failed:`, e.message);
    }
  }
  throw new Error('All upstreams failed');
}

// ==================== TTL 解析 ====================
function extractTtl(buf) {
  try {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
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

// ★ FIX: CORS 中间件放在最前面，确保所有请求都有 CORS 头
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.set('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// ★ FIX: body 解析放在 CORS 之后
app.use('/dns-query', (req, res, next) => {
  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
      next();
    });
    req.on('error', e => {
      res.status(400).json({ error: e.message });
    });
  } else {
    next();
  }
});

// ==================== 路由 ====================

// GET /dns-query?name=xxx 或 ?dns=xxx
app.get('/dns-query', async (req, res) => {
  try {
    if (req.query.name) {
      return await handleJson(req, res);
    }
    if (req.query.dns) {
      return await handleWireGet(req, res);
    }
    res.status(400).json({ error: 'Missing name or dns parameter' });
  } catch (e) {
    console.error('GET error:', e);
    res.status(502).json({ error: e.message });
  }
});

// POST /dns-query
app.post('/dns-query', async (req, res) => {
  try {
    const body = req.rawBody;
    if (!body || body.length === 0) {
      return res.status(400).json({ error: 'Empty body' });
    }

    const dns64 = b64encode(body);
    const sk = stableWireKey(dns64);
    const ck = `w:${sk}`;

    const hit = cacheGet(ck);
    if (hit) {
      res.set('Content-Type', 'application/dns-message');
      res.set('X-Cache', hit.status);
      if (hit.status === 'STALE') refreshWire(dns64, ck);
      return res.send(Buffer.from(hit.data));
    }

    const upstream = await fetchUpstream(
      base => `${base}?dns=${dns64}`,
      { Accept: 'application/dns-message' }
    );
    const data = Buffer.from(await upstream.arrayBuffer());
    cacheSet(ck, data, 'application/dns-message', extractTtl(data));

    res.set('Content-Type', 'application/dns-message');
    res.set('X-Cache', 'MISS');
    res.send(data);
  } catch (e) {
    console.error('POST error:', e);
    res.status(502).json({ error: e.message });
  }
});

// ==================== Wire GET ====================
async function handleWireGet(req, res) {
  const dns64 = req.query.dns;
  const sk = stableWireKey(dns64);
  const ck = `w:${sk}`;

  const hit = cacheGet(ck);
  if (hit) {
    res.set('Content-Type', 'application/dns-message');
    res.set('X-Cache', hit.status);
    if (hit.status === 'STALE') refreshWire(dns64, ck);
    return res.send(Buffer.from(hit.data));
  }

  const upstream = await fetchUpstream(
    base => `${base}?dns=${dns64}`,
    { Accept: 'application/dns-message' }
  );
  const data = Buffer.from(await upstream.arrayBuffer());
  cacheSet(ck, data, 'application/dns-message', extractTtl(data));

  res.set('Content-Type', 'application/dns-message');
  res.set('X-Cache', 'MISS');
  res.send(data);
}

function refreshWire(dns64, ck) {
  fetch(`${UPSTREAMS[0]}?dns=${dns64}`, {
    headers: { Accept: 'application/dns-message' },
  }).then(async r => {
    if (!r.ok) return;
    const data = Buffer.from(await r.arrayBuffer());
    cacheSet(ck, data, 'application/dns-message', extractTtl(data));
  }).catch(() => {});
}

// ==================== JSON ====================
async function handleJson(req, res) {
  const name = req.query.name;
  const type = (req.query.type || 'A').toUpperCase();
  const ck = `j:${name}:${type}`;

  const hit = cacheGet(ck);
  if (hit) {
    res.set('Content-Type', 'application/dns-json');
    res.set('X-Cache', hit.status);
    if (hit.status === 'STALE') refreshJson(name, type, ck);
    return res.send(hit.data);
  }

  const upstream = await fetchUpstream(
    base => `${base}?name=${encodeURIComponent(name)}&type=${type}`,
    { Accept: 'application/dns-json' }
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
}

function refreshJson(name, type, ck) {
  fetch(`${UPSTREAMS[0]}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { Accept: 'application/dns-json' },
  }).then(async r => {
    if (!r.ok) return;
    const data = await r.text();
    let ttl = 300;
    try {
      const j = JSON.parse(data);
      if (j.Answer?.length) ttl = Math.min(...j.Answer.map(a => a.TTL || 300));
    } catch {}
    cacheSet(ck, data, 'application/dns-json', ttl);
  }).catch(() => {});
}

// ==================== 健康检查 ====================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', cache: cache.size, uptime: process.uptime() });
});

// ==================== 首页 ====================
app.get('/', (req, res) => {
  // ★ FIX: 也支持从 / 路径查询
  if (req.query.name) return handleJson(req, res).catch(e => res.status(502).json({ error: e.message }));
  if (req.query.dns) return handleWireGet(req, res).catch(e => res.status(502).json({ error: e.message }));

  const origin = `https://${req.get('host')}`;  // ★ FIX: 强制 https
  const ep = `${origin}/dns-query`;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderHome(ep));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`DoH server on port ${PORT}`);
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
<p class="sub">DNS over HTTPS · Asia Node</p>
<div class="st"><span class="d y" id="sd"></span><span id="st">检测中...</span></div>
<h2>📡 端点</h2>
<div class="ep" id="ep" onclick="cp()">${ep}</div>
<p class="h" id="ch">点击复制</p>
<h2>⚡ 优势</h2>
<div class="info">
✅ 亚洲节点，延迟低<br>
✅ 内存缓存，重复查询 &lt; 5ms<br>
✅ 多上游自动切换
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
if(!d)return;b.disabled=true;r.style.display='block';
r.textContent+='\\n⏳ '+d+' '+t+'...\\n';
const s=performance.now();
try{const f=await fetch(E+'?name='+encodeURIComponent(d)+'&type='+t,{headers:{Accept:'application/dns-json'}});
const ms=Math.round(performance.now()-s),xc=f.headers.get('X-Cache')||'-';
if(!f.ok){r.textContent+='❌ HTTP '+f.status+'\\n';return}
const j=await f.json(),ic=xc==='HIT'?'⚡':xc==='STALE'?'♻️':'🌐';
let o=ic+' '+ms+'ms Cache:'+xc+'\\n';
if(j.Answer&&j.Answer.length){const m={1:'A',2:'NS',5:'CNAME',15:'MX',16:'TXT',28:'AAAA'};
j.Answer.forEach(a=>{o+='  '+(m[a.type]||a.type)+' '+a.data+' TTL:'+a.TTL+'\\n'})}
else o+='  ⚠️ 无记录\\n';
r.textContent+=o;r.scrollTop=r.scrollHeight}
catch(e){r.textContent+='❌ '+e.message+'\\n'}finally{b.disabled=false}}
(async()=>{const sd=document.getElementById('sd'),st=document.getElementById('st');
try{const s=performance.now(),f=await fetch(E+'?name=cloudflare.com&type=A',{headers:{Accept:'application/dns-json'}});
const ms=Math.round(performance.now()-s);
if(f.ok){sd.className='d g';st.textContent='✅ '+ms+'ms'}
else{sd.className='d r';st.textContent='❌ HTTP '+f.status}}
catch{sd.className='d r';st.textContent='不可达'}})();
document.getElementById('dm').addEventListener('keydown',e=>{if(e.key==='Enter')q()});
</script></body></html>`;
}
