// server.js
import { createServer } from 'node:http';
import { URL } from 'node:url';

const PORT = process.env.PORT || 10000;

// ==================== 配置 ====================
// 既然你只需要 linux.do，可以考虑精简

// 上游用 IP 直连，跳过 DNS 解析上游域名的开销
const UPSTREAMS = [
  {
    url: 'https://8.8.8.8/dns-query',
    host: 'dns.google',
  },
  {
    url: 'https://1.1.1.1/dns-query',
    host: 'cloudflare-dns.com',
  },
];

const MIN_TTL = 600;       // 提高最小TTL，减少上游请求
const MAX_TTL = 86400;
const NEGATIVE_TTL = 120;
const UPSTREAM_TIMEOUT = 3000;  // 从5s降到3s

// ==================== 预热: linux.do 的结果 ====================
const PREFETCH_DOMAINS = [
  { name: 'linux.do', type: 'A' },
  { name: 'linux.do', type: 'AAAA' },
  { name: 'connect.linux.do', type: 'A' },
];

// ==================== 内存缓存 ====================
const cache = new Map();
const MAX_CACHE_SIZE = 10000;  // 你只需要几个域名，不需要50000

// 上游连接的 keep-alive agent
import { Agent } from 'node:https';
const keepAliveAgent = new Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: UPSTREAM_TIMEOUT,
});

// ==================== 缓存操作 ====================
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  const age = Date.now() - entry.time;
  if (age < entry.ttl * 1000) return { ...entry, status: 'HIT' };
  // stale-while-revalidate: 过期后1小时内仍可用，同时后台刷新
  if (age < (entry.ttl + 3600) * 1000) return { ...entry, status: 'STALE' };
  cache.delete(key);
  return null;
}

function cacheSet(key, data, contentType, ttl) {
  if (cache.size >= MAX_CACHE_SIZE) {
    // LRU: 删除最早的
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { data, contentType, ttl: clamp(ttl), time: Date.now() });
}

function clamp(t) {
  return Math.max(MIN_TTL, Math.min(t || MIN_TTL, MAX_TTL));
}

// ==================== Base64url ====================
function b64encode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64decode(str) {
  return Buffer.from(str, 'base64url');
}

function stableWireKey(dns64) {
  try {
    const buf = Buffer.from(b64decode(dns64));
    buf[0] = 0; buf[1] = 0;  // 清除 transaction ID
    return b64encode(buf);
  } catch { return dns64; }
}

// ==================== 上游请求（竞速模式） ====================
// 关键优化：两个上游同时发，谁先回用谁
async function fetchUpstreamRace(path, headers) {
  const controller = new AbortController();
  const { signal } = controller;

  // 设置总超时
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);

  try {
    const promises = UPSTREAMS.map(async (upstream) => {
      const url = `${upstream.url}${path}`;
      const resp = await fetch(url, {
        headers: { ...headers, Host: upstream.host },
        signal,
        // Node 18+ 的 fetch 不直接支持 agent，但我们用 IP 直连已经省了 DNS
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp;
    });

    const result = await Promise.any(promises);
    clearTimeout(timeout);
    // 不需要 abort 其他请求，让它们自然完成（连接可复用）
    return result;
  } catch (e) {
    clearTimeout(timeout);
    throw new Error('All upstreams failed: ' + e.message);
  }
}

// 简单 fallback 模式（用于后台刷新等非关键路径）
async function fetchUpstreamSimple(path, headers) {
  for (const upstream of UPSTREAMS) {
    try {
      const url = `${upstream.url}${path}`;
      const resp = await fetch(url, {
        headers: { ...headers, Host: upstream.host },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
      });
      if (resp.ok) return resp;
    } catch (e) {
      // continue
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
    for (let i = 0; i < qd; i++) { o = skipName(v, o); o += 4; }
    if (an === 0) return NEGATIVE_TTL;
    let min = 0xFFFFFFFF;
    for (let i = 0; i < an; i++) {
      o = skipName(v, o);
      const ttl = v.getUint32(o + 4);
      if (ttl < min) min = ttl;
      o += 10 + v.getUint16(o + 8);
    }
    return min;
  } catch { return MIN_TTL; }
}

function skipName(v, o) {
  while (o < v.byteLength) {
    const l = v.getUint8(o);
    if (l === 0) return o + 1;
    if ((l & 0xc0) === 0xc0) return o + 2;
    o += 1 + l;
  }
  return o;
}

// ==================== CORS headers ====================
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Max-Age': '86400',
};

// ==================== 核心处理 ====================
// 去掉 Express，用原生 http 模块，减少中间件开销约 1-3ms

async function handleRequest(req, res) {
  // CORS
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.setHeader(k, v);
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/dns-query' || pathname === '/') {
      if (req.method === 'POST') {
        await handleWirePost(req, res);
      } else if (url.searchParams.has('dns')) {
        await handleWireGet(url.searchParams.get('dns'), res);
      } else if (url.searchParams.has('name')) {
        await handleJson(url.searchParams, res);
      } else if (pathname === '/') {
        serveHome(req, res);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing name or dns parameter' }));
      }
    } else if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', cache: cache.size, uptime: process.uptime() }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  } catch (e) {
    console.error('Request error:', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ==================== Wire 格式处理 ====================
async function handleWireGet(dns64, res) {
  const sk = stableWireKey(dns64);
  const ck = `w:${sk}`;

  const hit = cacheGet(ck);
  if (hit) {
    res.writeHead(200, {
      'Content-Type': 'application/dns-message',
      'X-Cache': hit.status,
      'Cache-Control': `max-age=${hit.ttl}`,
    });
    if (hit.status === 'STALE') refreshWire(dns64, ck);
    res.end(Buffer.from(hit.data));
    return;
  }

  const upstream = await fetchUpstreamRace(
    `?dns=${dns64}`,
    { Accept: 'application/dns-message' }
  );
  const data = Buffer.from(await upstream.arrayBuffer());
  const ttl = extractTtl(data);
  cacheSet(ck, data, 'application/dns-message', ttl);

  res.writeHead(200, {
    'Content-Type': 'application/dns-message',
    'X-Cache': 'MISS',
    'Cache-Control': `max-age=${clamp(ttl)}`,
  });
  res.end(data);
}

async function handleWirePost(req, res) {
  const body = await readBody(req);
  if (!body || body.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Empty body' }));
    return;
  }

  const dns64 = b64encode(body);
  const sk = stableWireKey(dns64);
  const ck = `w:${sk}`;

  const hit = cacheGet(ck);
  if (hit) {
    res.writeHead(200, {
      'Content-Type': 'application/dns-message',
      'X-Cache': hit.status,
    });
    if (hit.status === 'STALE') refreshWire(dns64, ck);
    res.end(Buffer.from(hit.data));
    return;
  }

  const upstream = await fetchUpstreamRace(
    `?dns=${dns64}`,
    { Accept: 'application/dns-message' }
  );
  const data = Buffer.from(await upstream.arrayBuffer());
  cacheSet(ck, data, 'application/dns-message', extractTtl(data));

  res.writeHead(200, {
    'Content-Type': 'application/dns-message',
    'X-Cache': 'MISS',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function refreshWire(dns64, ck) {
  fetchUpstreamSimple(`?dns=${dns64}`, { Accept: 'application/dns-message' })
    .then(async r => {
      const data = Buffer.from(await r.arrayBuffer());
      cacheSet(ck, data, 'application/dns-message', extractTtl(data));
    })
    .catch(() => {});
}

// ==================== JSON 格式处理 ====================
async function handleJson(params, res) {
  const name = params.get('name');
  const type = (params.get('type') || 'A').toUpperCase();
  const ck = `j:${name}:${type}`;

  const hit = cacheGet(ck);
  if (hit) {
    res.writeHead(200, {
      'Content-Type': 'application/dns-json',
      'X-Cache': hit.status,
      'Cache-Control': `max-age=${hit.ttl}`,
    });
    if (hit.status === 'STALE') refreshJson(name, type, ck);
    res.end(hit.data);
    return;
  }

  const upstream = await fetchUpstreamRace(
    `?name=${encodeURIComponent(name)}&type=${type}`,
    { Accept: 'application/dns-json' }
  );
  const data = await upstream.text();

  let ttl = MIN_TTL;
  try {
    const j = JSON.parse(data);
    if (j.Answer?.length) ttl = Math.min(...j.Answer.map(a => a.TTL || MIN_TTL));
    else ttl = NEGATIVE_TTL;
  } catch {}
  cacheSet(ck, data, 'application/dns-json', ttl);

  res.writeHead(200, {
    'Content-Type': 'application/dns-json',
    'X-Cache': 'MISS',
    'Cache-Control': `max-age=${clamp(ttl)}`,
  });
  res.end(data);
}

function refreshJson(name, type, ck) {
  fetchUpstreamSimple(
    `?name=${encodeURIComponent(name)}&type=${type}`,
    { Accept: 'application/dns-json' }
  ).then(async r => {
    const data = await r.text();
    let ttl = MIN_TTL;
    try {
      const j = JSON.parse(data);
      if (j.Answer?.length) ttl = Math.min(...j.Answer.map(a => a.TTL || MIN_TTL));
    } catch {}
    cacheSet(ck, data, 'application/dns-json', ttl);
  }).catch(() => {});
}

// ==================== 预热缓存 ====================
async function prefetch() {
  console.log('🔥 Prefetching critical domains...');
  for (const { name, type } of PREFETCH_DOMAINS) {
    try {
      const resp = await fetchUpstreamSimple(
        `?name=${encodeURIComponent(name)}&type=${type}`,
        { Accept: 'application/dns-json' }
      );
      const data = await resp.text();
      let ttl = MIN_TTL;
      try {
        const j = JSON.parse(data);
        if (j.Answer?.length) ttl = Math.min(...j.Answer.map(a => a.TTL || MIN_TTL));
      } catch {}
      cacheSet(`j:${name}:${type}`, data, 'application/dns-json', ttl);
      console.log(`  ✅ ${name} ${type} cached (TTL: ${clamp(ttl)}s)`);
    } catch (e) {
      console.log(`  ❌ ${name} ${type} failed: ${e.message}`);
    }
  }
}

// 定期刷新关键域名
setInterval(() => {
  prefetch().catch(() => {});
}, 5 * 60 * 1000);  // 每5分钟刷新一次

// ==================== 防休眠 (Render 免费计划) ====================
function keepAlive() {
  const url = `http://localhost:${PORT}/health`;
  fetch(url).catch(() => {});
}
// 每12分钟 ping 自己（Render 免费计划15分钟休眠）
setInterval(keepAlive, 12 * 60 * 1000);

// ==================== 首页 ====================
let cachedHomeHtml = '';  // 缓存渲染结果

function serveHome(req, res) {
  const origin = `https://${req.headers.host}`;
  const ep = `${origin}/dns-query`;

  if (!cachedHomeHtml || !cachedHomeHtml.includes(ep)) {
    cachedHomeHtml = renderHome(ep);
  }

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(cachedHomeHtml);
}

// ==================== 启动 ====================
const server = createServer(handleRequest);

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`⚡ DoH server on port ${PORT} (native http, no Express overhead)`);
  // 启动后立即预热
  await prefetch();
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
✅ 双上游竞速，取最快响应<br>
✅ 关键域名预热 + 定期刷新
</div>
<h2>🌐 设置</h2>
<div class="box">
<strong>Chrome/Edge：</strong>设置 → 隐私和安全 → 安全 → 安全DNS → 自定义<br>
<strong>Firefox：</strong>设置 → 隐私与安全 → DNS over HTTPS → 自定义
</div>
<h2>🧪 测试</h2>
<div class="ts"><div class="tr">
<input id="dm" value="linux.do" placeholder="域名"/>
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
try{const s=performance.now(),f=await fetch(E+'?name=linux.do&type=A',{headers:{Accept:'application/dns-json'}});
const ms=Math.round(performance.now()-s);
if(f.ok){sd.className='d g';st.textContent='✅ '+ms+'ms'}
else{sd.className='d r';st.textContent='❌ HTTP '+f.status}}
catch{sd.className='d r';st.textContent='不可达'}})();
document.getElementById('dm').addEventListener('keydown',e=>{if(e.key==='Enter')q()});
</script></body></html>`;
}
