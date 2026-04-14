// // server.js
// import { createServer } from 'node:http';
// import { URL } from 'node:url';

// const PORT = process.env.PORT || 10000;

// // ==================== 配置 ====================
// // 既然你只需要 linux.do，可以考虑精简

// // 上游用 IP 直连，跳过 DNS 解析上游域名的开销
// const UPSTREAMS = [
//   {
//     url: 'https://8.8.8.8/dns-query',
//     host: 'dns.google',
//   },
//   {
//     url: 'https://1.1.1.1/dns-query',
//     host: 'cloudflare-dns.com',
//   },
// ];

// const MIN_TTL = 600;       // 提高最小TTL，减少上游请求
// const MAX_TTL = 86400;
// const NEGATIVE_TTL = 120;
// const UPSTREAM_TIMEOUT = 3000;  // 从5s降到3s

// // ==================== 预热: linux.do 的结果 ====================
// const PREFETCH_DOMAINS = [
//   { name: 'linux.do', type: 'A' },
//   { name: 'linux.do', type: 'AAAA' },
//   { name: 'connect.linux.do', type: 'A' },
// ];

// // ==================== 内存缓存 ====================
// const cache = new Map();
// const MAX_CACHE_SIZE = 10000;  // 你只需要几个域名，不需要50000

// // 上游连接的 keep-alive agent
// import { Agent } from 'node:https';
// const keepAliveAgent = new Agent({
//   keepAlive: true,
//   keepAliveMsecs: 30000,
//   maxSockets: 10,
//   maxFreeSockets: 5,
//   timeout: UPSTREAM_TIMEOUT,
// });

// // ==================== 缓存操作 ====================
// function cacheGet(key) {
//   const entry = cache.get(key);
//   if (!entry) return null;
//   const age = Date.now() - entry.time;
//   if (age < entry.ttl * 1000) return { ...entry, status: 'HIT' };
//   // stale-while-revalidate: 过期后1小时内仍可用，同时后台刷新
//   if (age < (entry.ttl + 3600) * 1000) return { ...entry, status: 'STALE' };
//   cache.delete(key);
//   return null;
// }

// function cacheSet(key, data, contentType, ttl) {
//   if (cache.size >= MAX_CACHE_SIZE) {
//     // LRU: 删除最早的
//     const firstKey = cache.keys().next().value;
//     cache.delete(firstKey);
//   }
//   cache.set(key, { data, contentType, ttl: clamp(ttl), time: Date.now() });
// }

// function clamp(t) {
//   return Math.max(MIN_TTL, Math.min(t || MIN_TTL, MAX_TTL));
// }

// // ==================== Base64url ====================
// function b64encode(buf) {
//   return Buffer.from(buf).toString('base64url');
// }

// function b64decode(str) {
//   return Buffer.from(str, 'base64url');
// }

// function stableWireKey(dns64) {
//   try {
//     const buf = Buffer.from(b64decode(dns64));
//     buf[0] = 0; buf[1] = 0;  // 清除 transaction ID
//     return b64encode(buf);
//   } catch { return dns64; }
// }

// // ==================== 上游请求（竞速模式） ====================
// // 关键优化：两个上游同时发，谁先回用谁
// async function fetchUpstreamRace(path, headers) {
//   const controller = new AbortController();
//   const { signal } = controller;

//   // 设置总超时
//   const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);

//   try {
//     const promises = UPSTREAMS.map(async (upstream) => {
//       const url = `${upstream.url}${path}`;
//       const resp = await fetch(url, {
//         headers: { ...headers, Host: upstream.host },
//         signal,
//         // Node 18+ 的 fetch 不直接支持 agent，但我们用 IP 直连已经省了 DNS
//       });
//       if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
//       return resp;
//     });

//     const result = await Promise.any(promises);
//     clearTimeout(timeout);
//     // 不需要 abort 其他请求，让它们自然完成（连接可复用）
//     return result;
//   } catch (e) {
//     clearTimeout(timeout);
//     throw new Error('All upstreams failed: ' + e.message);
//   }
// }

// // 简单 fallback 模式（用于后台刷新等非关键路径）
// async function fetchUpstreamSimple(path, headers) {
//   for (const upstream of UPSTREAMS) {
//     try {
//       const url = `${upstream.url}${path}`;
//       const resp = await fetch(url, {
//         headers: { ...headers, Host: upstream.host },
//         signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
//       });
//       if (resp.ok) return resp;
//     } catch (e) {
//       // continue
//     }
//   }
//   throw new Error('All upstreams failed');
// }

// // ==================== TTL 解析 ====================
// function extractTtl(buf) {
//   try {
//     const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
//     const qd = v.getUint16(4), an = v.getUint16(6);
//     let o = 12;
//     for (let i = 0; i < qd; i++) { o = skipName(v, o); o += 4; }
//     if (an === 0) return NEGATIVE_TTL;
//     let min = 0xFFFFFFFF;
//     for (let i = 0; i < an; i++) {
//       o = skipName(v, o);
//       const ttl = v.getUint32(o + 4);
//       if (ttl < min) min = ttl;
//       o += 10 + v.getUint16(o + 8);
//     }
//     return min;
//   } catch { return MIN_TTL; }
// }

// function skipName(v, o) {
//   while (o < v.byteLength) {
//     const l = v.getUint8(o);
//     if (l === 0) return o + 1;
//     if ((l & 0xc0) === 0xc0) return o + 2;
//     o += 1 + l;
//   }
//   return o;
// }

// // ==================== CORS headers ====================
// const CORS_HEADERS = {
//   'Access-Control-Allow-Origin': '*',
//   'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
//   'Access-Control-Allow-Headers': 'Content-Type, Accept',
//   'Access-Control-Max-Age': '86400',
// };

// // ==================== 核心处理 ====================
// // 去掉 Express，用原生 http 模块，减少中间件开销约 1-3ms

// async function handleRequest(req, res) {
//   // CORS
//   for (const [k, v] of Object.entries(CORS_HEADERS)) {
//     res.setHeader(k, v);
//   }

//   if (req.method === 'OPTIONS') {
//     res.writeHead(204);
//     res.end();
//     return;
//   }

//   const url = new URL(req.url, `http://${req.headers.host}`);
//   const pathname = url.pathname;

//   try {
//     if (pathname === '/dns-query' || pathname === '/') {
//       if (req.method === 'POST') {
//         await handleWirePost(req, res);
//       } else if (url.searchParams.has('dns')) {
//         await handleWireGet(url.searchParams.get('dns'), res);
//       } else if (url.searchParams.has('name')) {
//         await handleJson(url.searchParams, res);
//       } else if (pathname === '/') {
//         serveHome(req, res);
//       } else {
//         res.writeHead(400, { 'Content-Type': 'application/json' });
//         res.end(JSON.stringify({ error: 'Missing name or dns parameter' }));
//       }
//     } else if (pathname === '/health') {
//       res.writeHead(200, { 'Content-Type': 'application/json' });
//       res.end(JSON.stringify({ status: 'ok', cache: cache.size, uptime: process.uptime() }));
//     } else {
//       res.writeHead(404);
//       res.end('Not Found');
//     }
//   } catch (e) {
//     console.error('Request error:', e.message);
//     res.writeHead(502, { 'Content-Type': 'application/json' });
//     res.end(JSON.stringify({ error: e.message }));
//   }
// }

// // ==================== Wire 格式处理 ====================
// async function handleWireGet(dns64, res) {
//   const sk = stableWireKey(dns64);
//   const ck = `w:${sk}`;

//   const hit = cacheGet(ck);
//   if (hit) {
//     res.writeHead(200, {
//       'Content-Type': 'application/dns-message',
//       'X-Cache': hit.status,
//       'Cache-Control': `max-age=${hit.ttl}`,
//     });
//     if (hit.status === 'STALE') refreshWire(dns64, ck);
//     res.end(Buffer.from(hit.data));
//     return;
//   }

//   const upstream = await fetchUpstreamRace(
//     `?dns=${dns64}`,
//     { Accept: 'application/dns-message' }
//   );
//   const data = Buffer.from(await upstream.arrayBuffer());
//   const ttl = extractTtl(data);
//   cacheSet(ck, data, 'application/dns-message', ttl);

//   res.writeHead(200, {
//     'Content-Type': 'application/dns-message',
//     'X-Cache': 'MISS',
//     'Cache-Control': `max-age=${clamp(ttl)}`,
//   });
//   res.end(data);
// }

// async function handleWirePost(req, res) {
//   const body = await readBody(req);
//   if (!body || body.length === 0) {
//     res.writeHead(400, { 'Content-Type': 'application/json' });
//     res.end(JSON.stringify({ error: 'Empty body' }));
//     return;
//   }

//   const dns64 = b64encode(body);
//   const sk = stableWireKey(dns64);
//   const ck = `w:${sk}`;

//   const hit = cacheGet(ck);
//   if (hit) {
//     res.writeHead(200, {
//       'Content-Type': 'application/dns-message',
//       'X-Cache': hit.status,
//     });
//     if (hit.status === 'STALE') refreshWire(dns64, ck);
//     res.end(Buffer.from(hit.data));
//     return;
//   }

//   const upstream = await fetchUpstreamRace(
//     `?dns=${dns64}`,
//     { Accept: 'application/dns-message' }
//   );
//   const data = Buffer.from(await upstream.arrayBuffer());
//   cacheSet(ck, data, 'application/dns-message', extractTtl(data));

//   res.writeHead(200, {
//     'Content-Type': 'application/dns-message',
//     'X-Cache': 'MISS',
//   });
//   res.end(data);
// }

// function readBody(req) {
//   return new Promise((resolve, reject) => {
//     const chunks = [];
//     req.on('data', c => chunks.push(c));
//     req.on('end', () => resolve(Buffer.concat(chunks)));
//     req.on('error', reject);
//   });
// }

// function refreshWire(dns64, ck) {
//   fetchUpstreamSimple(`?dns=${dns64}`, { Accept: 'application/dns-message' })
//     .then(async r => {
//       const data = Buffer.from(await r.arrayBuffer());
//       cacheSet(ck, data, 'application/dns-message', extractTtl(data));
//     })
//     .catch(() => {});
// }

// // ==================== JSON 格式处理 ====================
// async function handleJson(params, res) {
//   const name = params.get('name');
//   const type = (params.get('type') || 'A').toUpperCase();
//   const ck = `j:${name}:${type}`;

//   const hit = cacheGet(ck);
//   if (hit) {
//     res.writeHead(200, {
//       'Content-Type': 'application/dns-json',
//       'X-Cache': hit.status,
//       'Cache-Control': `max-age=${hit.ttl}`,
//     });
//     if (hit.status === 'STALE') refreshJson(name, type, ck);
//     res.end(hit.data);
//     return;
//   }

//   const upstream = await fetchUpstreamRace(
//     `?name=${encodeURIComponent(name)}&type=${type}`,
//     { Accept: 'application/dns-json' }
//   );
//   const data = await upstream.text();

//   let ttl = MIN_TTL;
//   try {
//     const j = JSON.parse(data);
//     if (j.Answer?.length) ttl = Math.min(...j.Answer.map(a => a.TTL || MIN_TTL));
//     else ttl = NEGATIVE_TTL;
//   } catch {}
//   cacheSet(ck, data, 'application/dns-json', ttl);

//   res.writeHead(200, {
//     'Content-Type': 'application/dns-json',
//     'X-Cache': 'MISS',
//     'Cache-Control': `max-age=${clamp(ttl)}`,
//   });
//   res.end(data);
// }

// function refreshJson(name, type, ck) {
//   fetchUpstreamSimple(
//     `?name=${encodeURIComponent(name)}&type=${type}`,
//     { Accept: 'application/dns-json' }
//   ).then(async r => {
//     const data = await r.text();
//     let ttl = MIN_TTL;
//     try {
//       const j = JSON.parse(data);
//       if (j.Answer?.length) ttl = Math.min(...j.Answer.map(a => a.TTL || MIN_TTL));
//     } catch {}
//     cacheSet(ck, data, 'application/dns-json', ttl);
//   }).catch(() => {});
// }

// // ==================== 预热缓存 ====================
// async function prefetch() {
//   console.log('🔥 Prefetching critical domains...');
//   for (const { name, type } of PREFETCH_DOMAINS) {
//     try {
//       const resp = await fetchUpstreamSimple(
//         `?name=${encodeURIComponent(name)}&type=${type}`,
//         { Accept: 'application/dns-json' }
//       );
//       const data = await resp.text();
//       let ttl = MIN_TTL;
//       try {
//         const j = JSON.parse(data);
//         if (j.Answer?.length) ttl = Math.min(...j.Answer.map(a => a.TTL || MIN_TTL));
//       } catch {}
//       cacheSet(`j:${name}:${type}`, data, 'application/dns-json', ttl);
//       console.log(`  ✅ ${name} ${type} cached (TTL: ${clamp(ttl)}s)`);
//     } catch (e) {
//       console.log(`  ❌ ${name} ${type} failed: ${e.message}`);
//     }
//   }
// }

// // 定期刷新关键域名
// setInterval(() => {
//   prefetch().catch(() => {});
// }, 5 * 60 * 1000);  // 每5分钟刷新一次

// // ==================== 防休眠 (Render 免费计划) ====================
// function keepAlive() {
//   const url = `http://localhost:${PORT}/health`;
//   fetch(url).catch(() => {});
// }
// // 每12分钟 ping 自己（Render 免费计划15分钟休眠）
// setInterval(keepAlive, 12 * 60 * 1000);

// // ==================== 首页 ====================
// let cachedHomeHtml = '';  // 缓存渲染结果

// function serveHome(req, res) {
//   const origin = `https://${req.headers.host}`;
//   const ep = `${origin}/dns-query`;

//   if (!cachedHomeHtml || !cachedHomeHtml.includes(ep)) {
//     cachedHomeHtml = renderHome(ep);
//   }

//   res.writeHead(200, {
//     'Content-Type': 'text/html; charset=utf-8',
//     'Cache-Control': 'public, max-age=3600',
//   });
//   res.end(cachedHomeHtml);
// }

// // ==================== 启动 ====================
// const server = createServer(handleRequest);

// server.listen(PORT, '0.0.0.0', async () => {
//   console.log(`⚡ DoH server on port ${PORT} (native http, no Express overhead)`);
//   // 启动后立即预热
//   await prefetch();
// });

// // ==================== 首页 HTML ====================
// function renderHome(ep) {
//   return `<!DOCTYPE html>
// <html lang="zh-CN"><head><meta charset="UTF-8">
// <meta name="viewport" content="width=device-width,initial-scale=1">
// <title>DoH Server</title>
// <style>
// *{margin:0;padding:0;box-sizing:border-box}
// body{font-family:-apple-system,sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
// .c{max-width:720px;width:100%;background:rgba(255,255,255,.05);border-radius:16px;padding:40px;backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.1)}
// h1{font-size:2em;margin-bottom:8px;background:linear-gradient(90deg,#f093fb,#f5576c,#4facfe);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
// .sub{color:#aaa;margin-bottom:25px}
// h2{font-size:1.15em;color:#4facfe;margin:22px 0 8px}
// .ep{background:rgba(0,0,0,.3);border:1px solid rgba(79,172,254,.3);border-radius:8px;padding:14px;font-family:monospace;font-size:1.05em;word-break:break-all;color:#4facfe;cursor:pointer;transition:.3s}
// .ep:hover{background:rgba(79,172,254,.1)}.ep.ok{border-color:#00ff64}
// .h{font-size:.83em;color:#888;margin-top:4px}
// .box{background:rgba(79,172,254,.08);border:1px solid rgba(79,172,254,.15);border-radius:8px;padding:14px;margin-top:8px;font-size:.9em;line-height:1.7}
// .ts{margin-top:20px;padding:18px;background:rgba(0,0,0,.2);border-radius:8px}
// .tr{display:flex;gap:8px;flex-wrap:wrap}
// .ts input{flex:1;min-width:140px;padding:9px 12px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.3);color:#fff;font-size:1em}
// .ts select{padding:9px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.3);color:#fff}
// .ts button{padding:9px 22px;border-radius:6px;border:none;background:linear-gradient(90deg,#4facfe,#00f2fe);color:#000;font-weight:bold;cursor:pointer}
// .ts button:disabled{opacity:.5}
// #r{margin-top:12px;padding:12px;background:rgba(0,0,0,.3);border-radius:6px;font-family:monospace;white-space:pre-wrap;font-size:.84em;max-height:280px;overflow-y:auto;display:none;line-height:1.5}
// .st{margin:18px 0;text-align:center;font-size:.95em}
// .d{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
// .d.g{background:#00ff64;box-shadow:0 0 6px #00ff64}
// .d.r{background:#f44;box-shadow:0 0 6px #f44}
// .d.y{background:#fa0;box-shadow:0 0 6px #fa0;animation:p 1s infinite}
// @keyframes p{50%{opacity:.4}}
// .info{background:rgba(0,255,100,.08);border:1px solid rgba(0,255,100,.2);border-radius:8px;padding:14px;margin-top:8px;font-size:.88em;line-height:1.7;color:#a0ffb0}
// </style></head><body><div class="c">
// <h1>🔒 DoH Server</h1>
// <p class="sub">DNS over HTTPS · Asia Node</p>
// <div class="st"><span class="d y" id="sd"></span><span id="st">检测中...</span></div>
// <h2>📡 端点</h2>
// <div class="ep" id="ep" onclick="cp()">${ep}</div>
// <p class="h" id="ch">点击复制</p>
// <h2>⚡ 优势</h2>
// <div class="info">
// ✅ 亚洲节点，延迟低<br>
// ✅ 内存缓存，重复查询 &lt; 5ms<br>
// ✅ 双上游竞速，取最快响应<br>
// ✅ 关键域名预热 + 定期刷新
// </div>
// <h2>🌐 设置</h2>
// <div class="box">
// <strong>Chrome/Edge：</strong>设置 → 隐私和安全 → 安全 → 安全DNS → 自定义<br>
// <strong>Firefox：</strong>设置 → 隐私与安全 → DNS over HTTPS → 自定义
// </div>
// <h2>🧪 测试</h2>
// <div class="ts"><div class="tr">
// <input id="dm" value="linux.do" placeholder="域名"/>
// <select id="qt"><option>A</option><option>AAAA</option><option>CNAME</option><option>MX</option><option>TXT</option><option>NS</option></select>
// <button id="btn" onclick="q()">查询</button>
// <button onclick="q();setTimeout(q,1e3)" style="background:linear-gradient(90deg,#f093fb,#f5576c);font-size:.85em">查2次</button>
// </div><div id="r"></div></div>
// </div>
// <script>
// const E='${ep}';
// function cp(){navigator.clipboard.writeText(E).then(()=>{document.getElementById('ep').classList.add('ok');document.getElementById('ch').textContent='✅ 已复制';setTimeout(()=>{document.getElementById('ep').classList.remove('ok');document.getElementById('ch').textContent='点击复制'},2e3)})}
// async function q(){
// const d=document.getElementById('dm').value.trim(),t=document.getElementById('qt').value,b=document.getElementById('btn'),r=document.getElementById('r');
// if(!d)return;b.disabled=true;r.style.display='block';
// r.textContent+='\\n⏳ '+d+' '+t+'...\\n';
// const s=performance.now();
// try{const f=await fetch(E+'?name='+encodeURIComponent(d)+'&type='+t,{headers:{Accept:'application/dns-json'}});
// const ms=Math.round(performance.now()-s),xc=f.headers.get('X-Cache')||'-';
// if(!f.ok){r.textContent+='❌ HTTP '+f.status+'\\n';return}
// const j=await f.json(),ic=xc==='HIT'?'⚡':xc==='STALE'?'♻️':'🌐';
// let o=ic+' '+ms+'ms Cache:'+xc+'\\n';
// if(j.Answer&&j.Answer.length){const m={1:'A',2:'NS',5:'CNAME',15:'MX',16:'TXT',28:'AAAA'};
// j.Answer.forEach(a=>{o+='  '+(m[a.type]||a.type)+' '+a.data+' TTL:'+a.TTL+'\\n'})}
// else o+='  ⚠️ 无记录\\n';
// r.textContent+=o;r.scrollTop=r.scrollHeight}
// catch(e){r.textContent+='❌ '+e.message+'\\n'}finally{b.disabled=false}}
// (async()=>{const sd=document.getElementById('sd'),st=document.getElementById('st');
// try{const s=performance.now(),f=await fetch(E+'?name=linux.do&type=A',{headers:{Accept:'application/dns-json'}});
// const ms=Math.round(performance.now()-s);
// if(f.ok){sd.className='d g';st.textContent='✅ '+ms+'ms'}
// else{sd.className='d r';st.textContent='❌ HTTP '+f.status}}
// catch{sd.className='d r';st.textContent='不可达'}})();
// document.getElementById('dm').addEventListener('keydown',e=>{if(e.key==='Enter')q()});
// </script></body></html>`;
// }




import { createServer } from 'node:http';
import { URL } from 'node:url';
import { performance } from 'node:perf_hooks';

const PORT = process.env.PORT || 10000;

// ==================== 配置 ====================
const ENABLE_PINNED = process.env.ENABLE_PINNED !== '0';
const LOG_QUERIES = process.env.LOG_QUERIES !== '0';

const UPSTREAM_TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT || 2500);
const CACHE_MAX = Number(process.env.CACHE_MAX || 10000);
const MIN_TTL = Number(process.env.MIN_TTL || 60);
const MAX_TTL = Number(process.env.MAX_TTL || 86400);
const NEGATIVE_TTL = Number(process.env.NEGATIVE_TTL || 60);
const STALE_WINDOW = Number(process.env.STALE_WINDOW || 3600);

// 浏览器安全 DNS 真正用的是 wire format。
// 这里的 JSON 只是给首页测试面板和后台刷新用。
const UPSTREAMS = [
  { name: 'cf', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'google', url: 'https://dns.google/dns-query' },
];

// 你目前只关心 linux.do：优先硬编码
// 这些值会在后台定时从上游刷新，避免长久写死。
const PINNED_STATE = {
  'linux.do': {
    A: ['104.20.16.234', '172.66.166.61'],
    AAAA: ['2606:4700:20::6812:10ea', '2606:4700:20::ac42:a63d'],
  },
  'connect.linux.do': {
    A: ['104.20.16.234', '172.66.166.61'],
    AAAA: ['2606:4700:20::6812:10ea', '2606:4700:20::ac42:a63d'],
  },
};

const PINNED_TTL = Number(process.env.PINNED_TTL || 120);
const PINNED_REFRESH_MS = Number(process.env.PINNED_REFRESH_MS || 10 * 60 * 1000);

// ==================== CORS / Timing headers ====================
const COMMON_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Max-Age': '86400',
  'Timing-Allow-Origin': '*',
};

// ==================== 缓存 ====================
const cache = new Map();

function clampTtl(ttl) {
  const t = Number(ttl || MIN_TTL);
  return Math.max(MIN_TTL, Math.min(t, MAX_TTL));
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;

  const ageMs = Date.now() - entry.time;
  const ttlMs = entry.ttl * 1000;

  if (ageMs < ttlMs) {
    return {
      ...entry,
      status: 'HIT',
      ageSec: Math.floor(ageMs / 1000),
      leftTtl: Math.max(0, entry.ttl - Math.floor(ageMs / 1000)),
    };
  }

  if (ageMs < ttlMs + STALE_WINDOW * 1000) {
    return {
      ...entry,
      status: 'STALE',
      ageSec: Math.floor(ageMs / 1000),
      leftTtl: 0,
    };
  }

  cache.delete(key);
  return null;
}

function cacheSet(key, value, ttl, meta = {}) {
  if (cache.size >= CACHE_MAX) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, {
    ...value,
    ttl: clampTtl(ttl),
    time: Date.now(),
    meta,
  });
}

function cacheClear() {
  cache.clear();
}

// ==================== 工具 ====================
function nowMs() {
  return performance.now();
}

function round(n) {
  return Math.round(n * 10) / 10;
}

function reqId() {
  return Math.random().toString(36).slice(2, 10);
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || '-';
}

function typeNumToName(n) {
  switch (n) {
    case 1: return 'A';
    case 28: return 'AAAA';
    case 5: return 'CNAME';
    case 15: return 'MX';
    case 16: return 'TXT';
    case 2: return 'NS';
    case 65: return 'HTTPS';
    default: return String(n || '');
  }
}

function typeNameToNum(t) {
  const x = String(t || 'A').toUpperCase();
  switch (x) {
    case 'A': return 1;
    case 'AAAA': return 28;
    case 'CNAME': return 5;
    case 'MX': return 15;
    case 'TXT': return 16;
    case 'NS': return 2;
    case 'HTTPS': return 65;
    default: return 1;
  }
}

function b64encode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64decode(str) {
  return Buffer.from(str, 'base64url');
}

function stableWireKeyFromBuffer(buf) {
  const copy = Buffer.from(buf);
  if (copy.length >= 2) {
    copy[0] = 0;
    copy[1] = 0;
  }
  return b64encode(copy);
}

function jsonLog(obj) {
  if (!LOG_QUERIES) return;
  console.log(JSON.stringify(obj));
}

function sendJson(res, code, obj, headers = {}) {
  res.writeHead(code, {
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(obj));
}

function addCommonHeaders(res) {
  for (const [k, v] of Object.entries(COMMON_HEADERS)) {
    res.setHeader(k, v);
  }
}

function buildServerTiming(timings) {
  const parts = [];
  for (const [k, v] of Object.entries(timings)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      parts.push(`${k};dur=${round(v)}`);
    }
  }
  return parts.join(', ');
}

function finalizeDoHHeaders(res, ctx, extra = {}) {
  const total = nowMs() - ctx.start;
  ctx.timings.total = total;

  res.setHeader('X-Trace-Id', ctx.id);
  res.setHeader('X-App-Time-Ms', String(round(total)));
  res.setHeader('Server-Timing', buildServerTiming(ctx.timings));
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extra)) {
    res.setHeader(k, v);
  }
}

function logDone(ctx, extra = {}) {
  const total = nowMs() - ctx.start;
  const log = {
    at: new Date().toISOString(),
    id: ctx.id,
    ip: ctx.ip,
    method: ctx.method,
    path: ctx.path,
    kind: ctx.kind,
    qname: ctx.qname || '',
    qtype: ctx.qtype || '',
    source: ctx.source || '',
    cache: ctx.cacheStatus || '',
    upstreamWinner: ctx.upstreamWinner || '',
    upstreams: ctx.upstreams || [],
    timings: Object.fromEntries(
      Object.entries({ ...ctx.timings, total }).map(([k, v]) => [k, round(v)])
    ),
    ua: ctx.ua || '',
    ...extra,
  };
  jsonLog(log);
}

// ==================== DNS wire 解析 / 构造 ====================
function parseWireQuery(buf) {
  try {
    if (!buf || buf.length < 17) return null;

    let offset = 12;
    const labels = [];

    while (offset < buf.length) {
      const len = buf[offset];
      if (len === 0) {
        offset += 1;
        break;
      }
      if ((len & 0xc0) === 0xc0) {
        return null; // query 一般不会压缩，遇到压缩名直接放弃硬编码分支
      }
      if (offset + 1 + len > buf.length) return null;
      labels.push(buf.slice(offset + 1, offset + 1 + len).toString('ascii'));
      offset += 1 + len;
    }

    if (offset + 4 > buf.length) return null;

    const qtype = buf.readUInt16BE(offset);
    const qclass = buf.readUInt16BE(offset + 2);
    const rd = (buf[2] & 0x01) === 0x01;

    return {
      name: labels.join('.').toLowerCase(),
      qtype,
      qclass,
      rd,
      questionEnd: offset + 4,
    };
  } catch {
    return null;
  }
}

function ipv6ToBuffer(ip) {
  try {
    let left = [];
    let right = [];

    if (ip.includes('::')) {
      const parts = ip.split('::');
      left = parts[0] ? parts[0].split(':') : [];
      right = parts[1] ? parts[1].split(':') : [];
    } else {
      left = ip.split(':');
    }

    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;

    const full = [...left, ...Array(missing).fill('0'), ...right];
    if (full.length !== 8) return null;

    const out = Buffer.alloc(16);
    for (let i = 0; i < 8; i++) {
      const n = parseInt(full[i] || '0', 16);
      if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
      out.writeUInt16BE(n, i * 2);
    }
    return out;
  } catch {
    return null;
  }
}

function buildPinnedWireResponse(queryBuf, parsed, answers, ttlSec = PINNED_TTL) {
  const tx0 = queryBuf[0];
  const tx1 = queryBuf[1];
  const rdBit = parsed.rd ? 0x01 : 0x00;

  const header = Buffer.from([
    tx0, tx1,         // ID
    0x80 | rdBit,     // QR=1, RD=copy
    0x80,             // RA=1
    0x00, 0x01,       // QDCOUNT
    0x00, answers.length, // ANCOUNT
    0x00, 0x00,       // NSCOUNT
    0x00, 0x00,       // ARCOUNT
  ]);

  const question = queryBuf.slice(12, parsed.questionEnd);

  const ttl = Buffer.alloc(4);
  ttl.writeUInt32BE(ttlSec);

  const rrList = [];

  for (const answer of answers) {
    if (parsed.qtype === 1) {
      const parts = answer.split('.').map(x => Number(x));
      if (parts.length !== 4 || parts.some(x => !Number.isInteger(x) || x < 0 || x > 255)) {
        continue;
      }
      rrList.push(Buffer.from([
        0xc0, 0x0c,       // NAME pointer
        0x00, 0x01,       // TYPE A
        0x00, 0x01,       // CLASS IN
        ttl[0], ttl[1], ttl[2], ttl[3],
        0x00, 0x04,
        parts[0], parts[1], parts[2], parts[3],
      ]));
    } else if (parsed.qtype === 28) {
      const buf = ipv6ToBuffer(answer);
      if (!buf) continue;
      rrList.push(Buffer.concat([
        Buffer.from([
          0xc0, 0x0c,     // NAME pointer
          0x00, 0x1c,     // TYPE AAAA
          0x00, 0x01,     // CLASS IN
          ttl[0], ttl[1], ttl[2], ttl[3],
          0x00, 0x10,
        ]),
        buf,
      ]));
    }
  }

  return Buffer.concat([header, question, ...rrList]);
}

function buildPinnedJsonResponse(name, type, answers, ttlSec = PINNED_TTL) {
  const qtype = typeNameToNum(type);
  return JSON.stringify({
    Status: 0,
    TC: false,
    RD: true,
    RA: true,
    AD: false,
    CD: false,
    Question: [
      { name: `${name}.`, type: qtype },
    ],
    Answer: answers.map(data => ({
      name: `${name}.`,
      type: qtype,
      TTL: ttlSec,
      data,
    })),
  });
}

// ==================== TTL 解析 ====================
function skipName(view, offset) {
  while (offset < view.byteLength) {
    const len = view.getUint8(offset);
    if (len === 0) return offset + 1;
    if ((len & 0xc0) === 0xc0) return offset + 2;
    offset += 1 + len;
  }
  return offset;
}

function extractTtlFromWire(buf) {
  try {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const qd = view.getUint16(4);
    const an = view.getUint16(6);

    let offset = 12;
    for (let i = 0; i < qd; i++) {
      offset = skipName(view, offset);
      offset += 4;
    }

    if (an === 0) return NEGATIVE_TTL;

    let min = 0xffffffff;
    for (let i = 0; i < an; i++) {
      offset = skipName(view, offset);
      const ttl = view.getUint32(offset + 4);
      if (ttl < min) min = ttl;
      offset += 10 + view.getUint16(offset + 8);
    }

    return min === 0xffffffff ? MIN_TTL : min;
  } catch {
    return MIN_TTL;
  }
}

function extractTtlFromJsonText(text) {
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j.Answer) && j.Answer.length > 0) {
      return Math.min(...j.Answer.map(a => Number(a.TTL || MIN_TTL)));
    }
    return NEGATIVE_TTL;
  } catch {
    return MIN_TTL;
  }
}

// ==================== 上游请求 ====================
async function fetchOneUpstream(upstream, path, headers, trace) {
  const t0 = nowMs();
  try {
    const resp = await fetch(`${upstream.url}${path}`, {
      headers,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    });
    const ms = nowMs() - t0;

    trace.push({
      name: upstream.name,
      ok: resp.ok,
      status: resp.status,
      ms: round(ms),
    });

    if (!resp.ok) {
      throw new Error(`${upstream.name}:${resp.status}`);
    }

    return { upstream: upstream.name, resp, ms };
  } catch (e) {
    const ms = nowMs() - t0;
    trace.push({
      name: upstream.name,
      ok: false,
      error: e?.name || e?.message || 'fetch_error',
      ms: round(ms),
    });
    throw e;
  }
}

async function fetchUpstreamRace(path, headers, ctx) {
  const t0 = nowMs();
  const trace = [];

  const promises = UPSTREAMS.map(u => fetchOneUpstream(u, path, headers, trace));

  try {
    const result = await Promise.any(promises);
    ctx.timings.upstream = nowMs() - t0;
    ctx.upstreams = trace;
    ctx.upstreamWinner = result.upstream;
    return result;
  } catch {
    ctx.timings.upstream = nowMs() - t0;
    ctx.upstreams = trace;
    throw new Error('All upstreams failed');
  }
}

async function fetchUpstreamSimple(path, headers) {
  for (const u of UPSTREAMS) {
    try {
      const r = await fetch(`${u.url}${path}`, {
        headers,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
      });
      if (r.ok) return { upstream: u.name, resp: r };
    } catch {
      // continue
    }
  }
  throw new Error('All upstreams failed');
}

// ==================== Pinned 逻辑 ====================
function getPinnedAnswers(name, type) {
  if (!ENABLE_PINNED) return null;
  const item = PINNED_STATE[String(name || '').toLowerCase()];
  if (!item) return null;
  const answers = item[String(type || '').toUpperCase()];
  if (!Array.isArray(answers) || answers.length === 0) return null;
  return answers;
}

async function refreshPinnedHost(name) {
  const lower = name.toLowerCase();
  const out = { ...PINNED_STATE[lower] };

  for (const type of ['A', 'AAAA']) {
    try {
      const path = `?name=${encodeURIComponent(lower)}&type=${type}`;
      const { upstream, resp } = await fetchUpstreamSimple(path, {
        Accept: 'application/dns-json, application/json;q=0.9',
      });
      const text = await resp.text();
      const data = JSON.parse(text);
      const answers = Array.isArray(data.Answer)
        ? data.Answer
            .filter(a => a.type === typeNameToNum(type))
            .map(a => a.data)
            .filter(Boolean)
        : [];

      if (answers.length > 0) {
        out[type] = answers;
        jsonLog({
          at: new Date().toISOString(),
          kind: 'pinned-refresh',
          name: lower,
          type,
          upstream,
          answers,
        });
      }
    } catch (e) {
      jsonLog({
        at: new Date().toISOString(),
        kind: 'pinned-refresh-error',
        name: lower,
        type,
        error: e.message,
      });
    }
  }

  PINNED_STATE[lower] = out;
}

async function refreshAllPinned() {
  const names = Object.keys(PINNED_STATE);
  for (const name of names) {
    await refreshPinnedHost(name);
  }
}

// ==================== body 读取 ====================
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ==================== wire 处理 ====================
async function resolveWire(queryBuf, ctx) {
  const parseStart = nowMs();
  const parsed = parseWireQuery(queryBuf);
  ctx.timings.parse = nowMs() - parseStart;

  if (parsed) {
    ctx.qname = parsed.name;
    ctx.qtype = typeNumToName(parsed.qtype);

    const pinnedStart = nowMs();
    const pinnedAnswers = getPinnedAnswers(parsed.name, ctx.qtype);
    if (pinnedAnswers && (parsed.qtype === 1 || parsed.qtype === 28)) {
      const data = buildPinnedWireResponse(queryBuf, parsed, pinnedAnswers, PINNED_TTL);
      ctx.timings.build = nowMs() - pinnedStart;
      ctx.source = 'PINNED';
      ctx.cacheStatus = 'PINNED';
      return {
        data,
        contentType: 'application/dns-message',
        xCache: 'PINNED',
      };
    }
    ctx.timings.pinned = nowMs() - pinnedStart;
  }

  const keyStart = nowMs();
  const cacheKey = `w:${stableWireKeyFromBuffer(queryBuf)}`;
  const hit = cacheGet(cacheKey);
  ctx.timings.cache = nowMs() - keyStart;

  if (hit) {
    ctx.source = 'CACHE';
    ctx.cacheStatus = hit.status;

    if (hit.status === 'STALE') {
      refreshWireInBackground(queryBuf, cacheKey);
    }

    return {
      data: Buffer.from(hit.data),
      contentType: 'application/dns-message',
      xCache: hit.status,
    };
  }

  const dns64 = b64encode(queryBuf);
  const { resp, upstream } = await fetchUpstreamRace(
    `?dns=${dns64}`,
    { Accept: 'application/dns-message' },
    ctx
  );
  const data = Buffer.from(await resp.arrayBuffer());
  const ttl = extractTtlFromWire(data);
  cacheSet(cacheKey, { data, contentType: 'application/dns-message' }, ttl, { upstream });

  ctx.source = 'UPSTREAM';
  ctx.cacheStatus = 'MISS';

  return {
    data,
    contentType: 'application/dns-message',
    xCache: 'MISS',
  };
}

function refreshWireInBackground(queryBuf, cacheKey) {
  const dns64 = b64encode(queryBuf);
  fetchUpstreamSimple(`?dns=${dns64}`, { Accept: 'application/dns-message' })
    .then(async ({ upstream, resp }) => {
      const data = Buffer.from(await resp.arrayBuffer());
      const ttl = extractTtlFromWire(data);
      cacheSet(cacheKey, { data, contentType: 'application/dns-message' }, ttl, { upstream });
    })
    .catch(() => {});
}

// ==================== JSON 处理（给网页测试/后台刷新用） ====================
async function handleJsonQuery(params, res, ctx) {
  const name = String(params.get('name') || '').trim().toLowerCase();
  const type = String(params.get('type') || 'A').trim().toUpperCase();

  if (!name) {
    return sendJson(res, 400, { error: 'missing name' });
  }

  ctx.kind = 'json';
  ctx.qname = name;
  ctx.qtype = type;

  const pinnedStart = nowMs();
  const pinnedAnswers = getPinnedAnswers(name, type);
  if (pinnedAnswers && (type === 'A' || type === 'AAAA')) {
    const text = buildPinnedJsonResponse(name, type, pinnedAnswers, PINNED_TTL);
    ctx.timings.build = nowMs() - pinnedStart;
    ctx.source = 'PINNED';
    ctx.cacheStatus = 'PINNED';

    finalizeDoHHeaders(res, ctx, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Cache': 'PINNED',
    });
    res.writeHead(200);
    res.end(text);
    return logDone(ctx, { status: 200 });
  }
  ctx.timings.pinned = nowMs() - pinnedStart;

  const cacheStart = nowMs();
  const cacheKey = `j:${name}:${type}`;
  const hit = cacheGet(cacheKey);
  ctx.timings.cache = nowMs() - cacheStart;

  if (hit) {
    ctx.source = 'CACHE';
    ctx.cacheStatus = hit.status;

    if (hit.status === 'STALE') {
      refreshJsonInBackground(name, type, cacheKey);
    }

    finalizeDoHHeaders(res, ctx, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Cache': hit.status,
    });
    res.writeHead(200);
    res.end(hit.data);
    return logDone(ctx, { status: 200 });
  }

  const { resp, upstream } = await fetchUpstreamRace(
    `?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
    { Accept: 'application/dns-json, application/json;q=0.9' },
    ctx
  );

  const text = await resp.text();
  const ttl = extractTtlFromJsonText(text);
  cacheSet(cacheKey, { data: text, contentType: 'application/json; charset=utf-8' }, ttl, { upstream });

  ctx.source = 'UPSTREAM';
  ctx.cacheStatus = 'MISS';

  finalizeDoHHeaders(res, ctx, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Cache': 'MISS',
  });
  res.writeHead(200);
  res.end(text);
  return logDone(ctx, { status: 200 });
}

function refreshJsonInBackground(name, type, cacheKey) {
  fetchUpstreamSimple(
    `?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
    { Accept: 'application/dns-json, application/json;q=0.9' }
  )
    .then(async ({ upstream, resp }) => {
      const text = await resp.text();
      const ttl = extractTtlFromJsonText(text);
      cacheSet(cacheKey, { data: text, contentType: 'application/json; charset=utf-8' }, ttl, { upstream });
    })
    .catch(() => {});
}

// ==================== 路由 ====================
async function handleRequest(req, res) {
  addCommonHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  const ctx = {
    id: reqId(),
    start: nowMs(),
    ip: clientIp(req),
    method: req.method,
    path: pathname,
    kind: '',
    ua: String(req.headers['user-agent'] || ''),
    timings: {},
    upstreams: [],
  };

  try {
    if (pathname === '/health') {
      return sendJson(res, 200, {
        status: 'ok',
        uptime: round(process.uptime()),
        cache: cache.size,
        pinned: PINNED_STATE,
      });
    }

    if (pathname === '/flush' && req.method === 'POST') {
      cacheClear();
      return sendJson(res, 200, { ok: true, cache: 0 });
    }

    if (pathname === '/dns-query') {
      if (req.method === 'GET' && url.searchParams.has('dns')) {
        ctx.kind = 'wire-get';
        const bodyDecodeStart = nowMs();
        const dns64 = url.searchParams.get('dns') || '';
        let queryBuf;
        try {
          queryBuf = b64decode(dns64);
        } catch {
          return sendJson(res, 400, { error: 'invalid dns param' });
        }
        ctx.timings.decode = nowMs() - bodyDecodeStart;

        const result = await resolveWire(queryBuf, ctx);

        finalizeDoHHeaders(res, ctx, {
          'Content-Type': result.contentType,
          'X-Cache': result.xCache,
        });
        res.writeHead(200);
        res.end(result.data);
        return logDone(ctx, { status: 200 });
      }

      if (req.method === 'POST') {
        ctx.kind = 'wire-post';
        const bodyStart = nowMs();
        const body = await readBody(req);
        ctx.timings.body = nowMs() - bodyStart;

        if (!body || body.length === 0) {
          return sendJson(res, 400, { error: 'empty body' });
        }

        const result = await resolveWire(body, ctx);

        finalizeDoHHeaders(res, ctx, {
          'Content-Type': result.contentType,
          'X-Cache': result.xCache,
        });
        res.writeHead(200);
        res.end(result.data);
        return logDone(ctx, { status: 200 });
      }

      if (req.method === 'GET' && url.searchParams.has('name')) {
        return await handleJsonQuery(url.searchParams, res, ctx);
      }

      return sendJson(res, 400, { error: 'missing name or dns parameter' });
    }

    if (pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(renderHome(`https://${req.headers.host}/dns-query`));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    finalizeDoHHeaders(res, ctx);
    logDone(ctx, { status: 502, error: e.message });
    return sendJson(res, 502, { error: e.message, trace: ctx.id });
  }
}

// ==================== 首页测试页 ====================
function renderHome(endpoint) {
  const pinnedList = Object.entries(PINNED_STATE)
    .map(([domain, records]) => {
      const a = records.A?.join(', ') || '-';
      const aaaa = records.AAAA?.join(', ') || '-';
      return `<div><b>${domain}</b><br>A: ${a}<br>AAAA: ${aaaa}</div>`;
    })
    .join('<hr style="border-color:#333;margin:12px 0">');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>DoH Probe</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#111827;color:#e5e7eb;margin:0;padding:24px}
.wrap{max-width:860px;margin:0 auto}
.card{background:#1f2937;border:1px solid #374151;border-radius:14px;padding:18px;margin-bottom:16px}
h1,h2{margin:0 0 12px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
input,select,button{padding:10px 12px;border-radius:10px;border:1px solid #4b5563;background:#111827;color:#fff}
button{cursor:pointer}
.row{display:flex;gap:8px;flex-wrap:wrap}
.out{white-space:pre-wrap;background:#0b1220;border:1px solid #334155;border-radius:10px;padding:12px;min-height:120px}
.small{color:#9ca3af;font-size:13px}
.ok{color:#34d399}
.warn{color:#fbbf24}
.bad{color:#f87171}
a{color:#60a5fa}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>DoH Probe</h1>
    <div>Endpoint: <code id="ep">${endpoint}</code></div>
    <div class="small" style="margin-top:8px">
      这个页面能看浏览器 fetch 的连接/TTFB/服务端内部耗时。<br>
      真正的“浏览器安全 DNS”冷启动测试，请配合 <code>chrome://net-export/</code> 使用。
    </div>
  </div>

  <div class="card">
    <h2>快速测试</h2>
    <div class="row">
      <input id="name" value="linux.do" placeholder="domain" />
      <select id="type">
        <option>A</option>
        <option>AAAA</option>
        <option>CNAME</option>
        <option>MX</option>
        <option>TXT</option>
        <option>NS</option>
      </select>
      <button onclick="runOnce()">测 1 次</button>
      <button onclick="runTwice()">测 2 次（看连接复用/缓存）</button>
    </div>
    <div class="small" style="margin-top:10px">
      首次慢，常常不是服务端慢，而是浏览器到平台的 TCP/TLS 建连慢。
    </div>
    <pre id="out" class="out"></pre>
  </div>

  <div class="card">
    <h2>当前 pinned</h2>
    ${pinnedList}
  </div>

  <div class="card">
    <h2>真实浏览器 DoH 测试方法</h2>
    <div class="small">
      1. 在 Chrome/Edge 设置里把安全 DNS 改成：<code>${endpoint}</code><br>
      2. 打开 <code>chrome://net-export/</code><br>
      3. Start Logging to Disk<br>
      4. 完全退出浏览器，再重新打开<br>
      5. 访问 <code>https://linux.do</code><br>
      6. 查看日志中 <code>DOH / HOST_RESOLVER / SSL_CONNECT_JOB / HTTP_STREAM_JOB</code>
    </div>
  </div>
</div>

<script>
const EP = ${JSON.stringify(endpoint)};

function fmt(n){ return typeof n === 'number' && isFinite(n) ? n.toFixed(1) + 'ms' : '-'; }

function serverTimingToText(entry){
  if(!entry || !entry.serverTiming || !entry.serverTiming.length) return '无';
  return entry.serverTiming.map(x => \`\${x.name}=\${fmt(x.duration)}\`).join(', ');
}

function findEntry(url){
  const entries = performance.getEntriesByName(url, 'resource');
  return entries[entries.length - 1];
}

async function doFetch(name, type){
  const url = EP + '?name=' + encodeURIComponent(name) + '&type=' + encodeURIComponent(type) + '&_=' + Date.now() + Math.random();
  performance.clearResourceTimings();

  const t0 = performance.now();
  const resp = await fetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  const t1 = performance.now();
  const text = await resp.text();
  const total = t1 - t0;
  const entry = findEntry(url);

  let body;
  try { body = JSON.parse(text); } catch { body = null; }

  return { url, resp, text, body, total, entry };
}

function renderResult(tag, result){
  const { resp, body, total, entry } = result;
  const out = [];

  out.push('[' + tag + ']');
  out.push('HTTP: ' + resp.status);
  out.push('X-Cache: ' + (resp.headers.get('X-Cache') || '-'));
  out.push('X-App-Time-Ms: ' + (resp.headers.get('X-App-Time-Ms') || '-'));
  out.push('X-Trace-Id: ' + (resp.headers.get('X-Trace-Id') || '-'));
  out.push('浏览器总耗时: ' + fmt(total));

  if(entry){
    const connect = entry.connectEnd > 0 ? (entry.connectEnd - entry.connectStart) : 0;
    const tls = entry.secureConnectionStart > 0 ? (entry.connectEnd - entry.secureConnectionStart) : 0;
    const req = entry.responseStart > 0 ? (entry.responseStart - entry.requestStart) : 0;
    const download = entry.responseEnd > 0 ? (entry.responseEnd - entry.responseStart) : 0;

    out.push('connect: ' + fmt(connect));
    out.push('tls: ' + fmt(tls));
    out.push('request→TTFB: ' + fmt(req));
    out.push('download: ' + fmt(download));
    out.push('serverTiming: ' + serverTimingToText(entry));

    if(connect === 0 && tls === 0){
      out.push('提示: 这次大概率复用了浏览器连接');
    }
  } else {
    out.push('resource timing: 不可用');
  }

  if(body && body.Answer && body.Answer.length){
    out.push('答案:');
    for(const a of body.Answer){
      out.push('  ' + a.data + ' TTL:' + a.TTL);
    }
  } else {
    out.push('答案: 无或非 JSON');
  }

  return out.join('\\n');
}

async function runOnce(){
  const name = document.getElementById('name').value.trim();
  const type = document.getElementById('type').value;
  const el = document.getElementById('out');
  el.textContent = '请求中...';
  try{
    const r = await doFetch(name, type);
    el.textContent = renderResult('第1次', r);
  }catch(e){
    el.textContent = '错误: ' + e.message;
  }
}

async function runTwice(){
  const name = document.getElementById('name').value.trim();
  const type = document.getElementById('type').value;
  const el = document.getElementById('out');
  el.textContent = '请求中...';
  try{
    const r1 = await doFetch(name, type);
    await new Promise(r => setTimeout(r, 500));
    const r2 = await doFetch(name, type);
    el.textContent = renderResult('第1次', r1) + '\\n\\n' + renderResult('第2次', r2);
  }catch(e){
    el.textContent = '错误: ' + e.message;
  }
}
</script>
</body>
</html>`;
}

// ==================== 启动 ====================
const server = createServer(handleRequest);

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`DoH server listening on :${PORT}`);
  console.log(`Pinned enabled: ${ENABLE_PINNED}`);
  console.log(`Pinned domains: ${Object.keys(PINNED_STATE).join(', ')}`);
  try {
    await refreshAllPinned();
  } catch (e) {
    console.log('Initial pinned refresh failed:', e.message);
  }
});

setInterval(() => {
  refreshAllPinned().catch(() => {});
}, PINNED_REFRESH_MS);
