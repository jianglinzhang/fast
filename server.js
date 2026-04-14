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
const UPSTREAMS = [
  { name: 'cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'google', url: 'https://dns.google/dns-query' },
];

const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 2500);

const MIN_TTL = 60;
const MAX_TTL = 86400;
const NEGATIVE_TTL = 120;
const STALE_WINDOW_SEC = 3600;
const MAX_CACHE_SIZE = 5000;

// 你当前只关心 linux.do，所以优先硬编码
// 注意：Cloudflare 代理 IP 未来可能变化，如失效请更新
const HARDCODED = {
  'linux.do': {
    A: ['172.66.166.61', '104.20.16.234'],
  },
  // 如果你确认 connect.linux.do 也要固定，可取消注释
  // 'connect.linux.do': {
  //   A: ['172.66.166.61', '104.20.16.234'],
  // },
};

const HARDCODED_TTL = 300;

// ==================== 内存缓存 ====================
const cache = new Map();
const inflight = new Map();

function clampTtl(ttl) {
  return Math.max(MIN_TTL, Math.min(Number(ttl || MIN_TTL), MAX_TTL));
}

function normalizeName(name) {
  return String(name || '').trim().replace(/\.+$/, '').toLowerCase();
}

function cacheSet(key, entry) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, {
    ...entry,
    ttl: clampTtl(entry.ttl),
    time: Date.now(),
  });

  if (cache.size > MAX_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;

  const ageSec = Math.floor((Date.now() - entry.time) / 1000);

  // LRU touch
  cache.delete(key);
  cache.set(key, entry);

  if (ageSec < entry.ttl) {
    return {
      entry,
      status: 'HIT',
      ageSec,
      remainingTtl: Math.max(1, entry.ttl - ageSec),
    };
  }

  if (ageSec < entry.ttl + STALE_WINDOW_SEC) {
    return {
      entry,
      status: 'STALE',
      ageSec,
      remainingTtl: 1,
    };
  }

  cache.delete(key);
  return null;
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
    if (buf.length >= 2) {
      buf[0] = 0;
      buf[1] = 0;
    }
    return b64encode(buf);
  } catch {
    return dns64;
  }
}

// ==================== DNS 辅助 ====================
function typeNumToName(type) {
  if (type === 1) return 'A';
  if (type === 28) return 'AAAA';
  if (type === 5) return 'CNAME';
  if (type === 15) return 'MX';
  if (type === 16) return 'TXT';
  if (type === 2) return 'NS';
  return String(type);
}

function typeNameToNum(type) {
  const t = String(type || '').toUpperCase();
  if (t === 'A') return 1;
  if (t === 'AAAA') return 28;
  if (t === 'CNAME') return 5;
  if (t === 'MX') return 15;
  if (t === 'TXT') return 16;
  if (t === 'NS') return 2;
  return 1;
}

function getHardcodedAnswers(name, type) {
  const n = normalizeName(name);
  const t = String(type || '').toUpperCase();
  return HARDCODED[n]?.[t] || null;
}

function skipNameView(v, o) {
  while (o < v.byteLength) {
    const len = v.getUint8(o);
    if (len === 0) return o + 1;
    if ((len & 0xc0) === 0xc0) return o + 2;
    o += 1 + len;
  }
  return o;
}

function skipNameBuf(buf, o) {
  while (o < buf.length) {
    const len = buf[o];
    if (len === 0) return o + 1;
    if ((len & 0xc0) === 0xc0) return o + 2;
    o += 1 + len;
  }
  return o;
}

function parseWireQuery(buf) {
  try {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    if (buf.length < 17) return null;

    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const qd = v.getUint16(4);
    if (qd < 1) return null;

    let o = 12;
    const labels = [];

    while (o < buf.length) {
      const len = buf[o];
      if (len === 0) {
        o++;
        break;
      }
      if ((len & 0xc0) === 0xc0) return null;
      o++;
      if (o + len > buf.length) return null;
      labels.push(buf.subarray(o, o + len).toString('ascii'));
      o += len;
    }

    if (o + 4 > buf.length) return null;

    const qtype = v.getUint16(o);
    const qclass = v.getUint16(o + 2);
    if (qclass !== 1) return null;

    return {
      name: normalizeName(labels.join('.')),
      qtype,
      questionEnd: o + 4,
    };
  } catch {
    return null;
  }
}

function ipv4ToBuf(ip) {
  const parts = String(ip).split('.').map(x => Number(x));
  if (parts.length !== 4 || parts.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return Buffer.from(parts);
}

function ipv6ToBuf(ip) {
  try {
    const s = String(ip).toLowerCase();

    if (!s.includes(':')) return null;

    let [left, right] = s.split('::');
    const leftParts = left ? left.split(':').filter(Boolean) : [];
    const rightParts = right ? right.split(':').filter(Boolean) : [];

    const missing = 8 - (leftParts.length + rightParts.length);
    if (missing < 0) return null;

    const full = [...leftParts, ...Array(missing).fill('0'), ...rightParts];
    if (full.length !== 8) return null;

    const buf = Buffer.alloc(16);
    for (let i = 0; i < 8; i++) {
      const n = parseInt(full[i], 16);
      if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
      buf.writeUInt16BE(n, i * 2);
    }
    return buf;
  } catch {
    return null;
  }
}

function buildWireResponseFromQuery(queryBuf, qtype, answers, ttl = HARDCODED_TTL) {
  const parsed = parseWireQuery(queryBuf);
  if (!parsed) return null;

  const question = queryBuf.subarray(12, parsed.questionEnd);

  const header = Buffer.alloc(12);
  header[0] = queryBuf[0];
  header[1] = queryBuf[1];
  header[2] = 0x81; // QR=1, RD=1
  header[3] = 0x80; // RA=1
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(answers.length, 6); // ANCOUNT
  header.writeUInt16BE(0, 8); // NSCOUNT
  header.writeUInt16BE(0, 10); // ARCOUNT

  const rrList = [];

  for (const ans of answers) {
    if (qtype === 1) {
      const rdata = ipv4ToBuf(ans);
      if (!rdata) continue;

      const rr = Buffer.alloc(16);
      rr[0] = 0xc0; rr[1] = 0x0c; // 指向 question name
      rr.writeUInt16BE(1, 2);     // TYPE A
      rr.writeUInt16BE(1, 4);     // CLASS IN
      rr.writeUInt32BE(ttl >>> 0, 6);
      rr.writeUInt16BE(4, 10);
      rdata.copy(rr, 12);
      rrList.push(rr);
    } else if (qtype === 28) {
      const rdata = ipv6ToBuf(ans);
      if (!rdata) continue;

      const rr = Buffer.alloc(28);
      rr[0] = 0xc0; rr[1] = 0x0c;
      rr.writeUInt16BE(28, 2);    // AAAA
      rr.writeUInt16BE(1, 4);
      rr.writeUInt32BE(ttl >>> 0, 6);
      rr.writeUInt16BE(16, 10);
      rdata.copy(rr, 12);
      rrList.push(rr);
    }
  }

  header.writeUInt16BE(rrList.length, 6);
  return Buffer.concat([header, question, ...rrList]);
}

function buildJsonResponse(name, type, answers, ttl = HARDCODED_TTL) {
  const t = typeNameToNum(type);
  return JSON.stringify({
    Status: 0,
    TC: false,
    RD: true,
    RA: true,
    AD: false,
    CD: false,
    Question: [{ name: `${normalizeName(name)}.`, type: t }],
    Answer: answers.map(v => ({
      name: `${normalizeName(name)}.`,
      type: t,
      TTL: ttl,
      data: v,
    })),
  });
}

function extractMinTtlWire(buf) {
  try {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const qd = v.getUint16(4);
    const an = v.getUint16(6);
    const ns = v.getUint16(8);

    let o = 12;
    for (let i = 0; i < qd; i++) {
      o = skipNameView(v, o);
      o += 4;
    }

    if (an === 0 && ns === 0) return NEGATIVE_TTL;

    let min = 0xffffffff;

    for (let i = 0; i < an + ns; i++) {
      o = skipNameView(v, o);
      const type = v.getUint16(o);
      const ttl = v.getUint32(o + 4);
      if (type !== 41 && ttl < min) min = ttl; // 排除 OPT
      o += 10 + v.getUint16(o + 8);
    }

    return min === 0xffffffff ? NEGATIVE_TTL : min;
  } catch {
    return MIN_TTL;
  }
}

function patchWireTtl(buf, ttl) {
  const out = Buffer.from(buf);
  try {
    const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const qd = v.getUint16(4);
    const an = v.getUint16(6);
    const ns = v.getUint16(8);

    let o = 12;
    for (let i = 0; i < qd; i++) {
      o = skipNameView(v, o);
      o += 4;
    }

    for (let i = 0; i < an + ns; i++) {
      o = skipNameView(v, o);
      const type = v.getUint16(o);
      if (type !== 41) {
        v.setUint32(o + 4, Math.max(1, ttl) >>> 0);
      }
      o += 10 + v.getUint16(o + 8);
    }
  } catch {}
  return out;
}

function adjustJsonTtlString(text, ttl) {
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j.Answer)) {
      for (const a of j.Answer) a.TTL = Math.max(1, ttl);
    }
    if (Array.isArray(j.Authority)) {
      for (const a of j.Authority) {
        if (typeof a.TTL === 'number') a.TTL = Math.max(1, ttl);
      }
    }
    return JSON.stringify(j);
  } catch {
    return text;
  }
}

// ==================== 上游请求 ====================
async function fetchUpstreamRace(buildUrl, headers) {
  const tasks = UPSTREAMS.map(async (u) => {
    const t0 = performance.now();
    const resp = await fetch(buildUrl(u), {
      method: 'GET',
      headers: {
        ...headers,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`${u.name}:${resp.status}`);
    return {
      upstream: u.name,
      ms: performance.now() - t0,
      resp,
    };
  });

  try {
    return await Promise.any(tasks);
  } catch {
    throw new Error('All upstreams failed');
  }
}

async function loadWireFromUpstream(dns64) {
  const result = await fetchUpstreamRace(
    (u) => `${u.url}?dns=${encodeURIComponent(dns64)}`,
    { Accept: 'application/dns-message' }
  );

  const data = Buffer.from(await result.resp.arrayBuffer());
  return {
    data,
    ttl: clampTtl(extractMinTtlWire(data)),
    upstream: result.upstream,
    upstreamMs: result.ms,
  };
}

async function loadJsonFromUpstream(name, type) {
  const result = await fetchUpstreamRace(
    (u) => `${u.url}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
    { Accept: 'application/dns-json' }
  );

  const text = await result.resp.text();

  let ttl = MIN_TTL;
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j.Answer) && j.Answer.length > 0) {
      ttl = Math.min(...j.Answer.map(a => Number(a.TTL || MIN_TTL)));
    } else {
      ttl = NEGATIVE_TTL;
    }
  } catch {
    ttl = MIN_TTL;
  }

  return {
    data: text,
    ttl: clampTtl(ttl),
    upstream: result.upstream,
    upstreamMs: result.ms,
  };
}

// ==================== 后台刷新 ====================
function refreshWire(dns64, key) {
  if (inflight.has(key)) return;
  const p = loadWireFromUpstream(dns64)
    .then(r => cacheSet(key, { kind: 'wire', data: r.data, ttl: r.ttl }))
    .catch(() => {})
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
}

function refreshJson(name, type, key) {
  if (inflight.has(key)) return;
  const p = loadJsonFromUpstream(name, type)
    .then(r => cacheSet(key, { kind: 'json', data: r.data, ttl: r.ttl }))
    .catch(() => {})
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
}

// ==================== 调试参数 ====================
function getFlags(req, url) {
  const forceUpstream =
    url.searchParams.get('force_upstream') === '1' ||
    req.headers['x-force-upstream'] === '1';

  const noCache =
    url.searchParams.get('no_cache') === '1' ||
    req.headers['x-no-cache'] === '1';

  return { forceUpstream, noCache };
}

// ==================== 响应头 ====================
const EXPOSE_HEADERS = [
  'X-DoH-Mode',
  'X-DoH-Upstream',
  'X-Upstream-Time-Ms',
  'X-Server-Time-Ms',
  'X-Cache',
  'Server-Timing',
];

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Force-Upstream, X-No-Cache');
  res.setHeader('Access-Control-Expose-Headers', EXPOSE_HEADERS.join(', '));
  res.setHeader('Access-Control-Max-Age', '86400');
}

function send(res, status, contentType, body, meta = {}) {
  const totalMs = meta.start != null ? (performance.now() - meta.start) : 0;

  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');

  if (meta.mode) {
    res.setHeader('X-DoH-Mode', meta.mode);
    res.setHeader('X-Cache', meta.mode);
  }
  if (meta.upstream) res.setHeader('X-DoH-Upstream', meta.upstream);
  if (meta.upstreamMs != null) res.setHeader('X-Upstream-Time-Ms', meta.upstreamMs.toFixed(1));
  res.setHeader('X-Server-Time-Ms', totalMs.toFixed(1));

  const timing = [`total;dur=${totalMs.toFixed(1)}`];
  if (meta.upstreamMs != null) timing.push(`upstream;dur=${meta.upstreamMs.toFixed(1)}`);
  res.setHeader('Server-Timing', timing.join(', '));

  if (Buffer.isBuffer(body)) {
    res.setHeader('Content-Length', body.length);
    res.end(body);
  } else {
    const out = String(body);
    res.setHeader('Content-Length', Buffer.byteLength(out));
    res.end(out);
  }
}

function sendJsonError(res, status, message, meta = {}) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify({ error: message }), meta);
}

// ==================== 读取 body ====================
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ==================== JSON 查询 ====================
async function handleJson(req, res, url) {
  const start = performance.now();
  const { forceUpstream, noCache } = getFlags(req, url);

  const name = normalizeName(url.searchParams.get('name'));
  const type = String(url.searchParams.get('type') || 'A').toUpperCase();

  if (!name) {
    return sendJsonError(res, 400, 'Missing name', { start });
  }

  // 1) 硬编码优先
  if (!forceUpstream) {
    const hardcoded = getHardcodedAnswers(name, type);
    if (hardcoded) {
      const body = buildJsonResponse(name, type, hardcoded, HARDCODED_TTL);
      return send(res, 200, 'application/dns-json', body, {
        start,
        mode: 'HARDCODED',
      });
    }
  }

  const key = `j:${name}:${type}`;

  // 2) 缓存
  if (!noCache) {
    const hit = cacheGet(key);
    if (hit) {
      const body = adjustJsonTtlString(hit.entry.data, hit.remainingTtl);
      if (hit.status === 'STALE') refreshJson(name, type, key);
      return send(res, 200, 'application/dns-json', body, {
        start,
        mode: hit.status,
      });
    }
  }

  // 3) 上游 / inflight 去重
  let loader = inflight.get(key);
  if (!loader || noCache) {
    loader = loadJsonFromUpstream(name, type);
    if (!noCache) {
      inflight.set(key, loader.finally(() => inflight.delete(key)));
    }
  }

  const result = await loader;
  if (!noCache) {
    cacheSet(key, {
      kind: 'json',
      data: result.data,
      ttl: result.ttl,
    });
  }

  return send(res, 200, 'application/dns-json', result.data, {
    start,
    mode: noCache ? 'BYPASS' : 'MISS',
    upstream: result.upstream,
    upstreamMs: result.upstreamMs,
  });
}

// ==================== Wire GET ====================
async function handleWireGet(req, res, url) {
  const start = performance.now();
  const { forceUpstream, noCache } = getFlags(req, url);

  const dns64 = url.searchParams.get('dns');
  if (!dns64) {
    return sendJsonError(res, 400, 'Missing dns parameter', { start });
  }

  let raw;
  try {
    raw = b64decode(dns64);
  } catch {
    return sendJsonError(res, 400, 'Invalid dns parameter', { start });
  }

  // 1) 硬编码优先
  if (!forceUpstream) {
    const parsed = parseWireQuery(raw);
    if (parsed) {
      const hardcoded = getHardcodedAnswers(parsed.name, typeNumToName(parsed.qtype));
      if (hardcoded) {
        const body = buildWireResponseFromQuery(raw, parsed.qtype, hardcoded, HARDCODED_TTL);
        if (body) {
          return send(res, 200, 'application/dns-message', body, {
            start,
            mode: 'HARDCODED',
          });
        }
      }
    }
  }

  const key = `w:${stableWireKey(dns64)}`;

  // 2) 缓存
  if (!noCache) {
    const hit = cacheGet(key);
    if (hit) {
      const body = patchWireTtl(hit.entry.data, hit.remainingTtl);
      if (hit.status === 'STALE') refreshWire(dns64, key);
      return send(res, 200, 'application/dns-message', body, {
        start,
        mode: hit.status,
      });
    }
  }

  // 3) 上游 / inflight 去重
  let loader = inflight.get(key);
  if (!loader || noCache) {
    loader = loadWireFromUpstream(dns64);
    if (!noCache) {
      inflight.set(key, loader.finally(() => inflight.delete(key)));
    }
  }

  const result = await loader;
  if (!noCache) {
    cacheSet(key, {
      kind: 'wire',
      data: result.data,
      ttl: result.ttl,
    });
  }

  return send(res, 200, 'application/dns-message', result.data, {
    start,
    mode: noCache ? 'BYPASS' : 'MISS',
    upstream: result.upstream,
    upstreamMs: result.upstreamMs,
  });
}

// ==================== Wire POST ====================
async function handleWirePost(req, res, url) {
  const start = performance.now();
  const { forceUpstream, noCache } = getFlags(req, url);

  const body = await readBody(req);
  if (!body || body.length === 0) {
    return sendJsonError(res, 400, 'Empty body', { start });
  }

  // 1) 硬编码优先
  if (!forceUpstream) {
    const parsed = parseWireQuery(body);
    if (parsed) {
      const hardcoded = getHardcodedAnswers(parsed.name, typeNumToName(parsed.qtype));
      if (hardcoded) {
        const out = buildWireResponseFromQuery(body, parsed.qtype, hardcoded, HARDCODED_TTL);
        if (out) {
          return send(res, 200, 'application/dns-message', out, {
            start,
            mode: 'HARDCODED',
          });
        }
      }
    }
  }

  const dns64 = b64encode(body);
  const key = `w:${stableWireKey(dns64)}`;

  // 2) 缓存
  if (!noCache) {
    const hit = cacheGet(key);
    if (hit) {
      const out = patchWireTtl(hit.entry.data, hit.remainingTtl);
      if (hit.status === 'STALE') refreshWire(dns64, key);
      return send(res, 200, 'application/dns-message', out, {
        start,
        mode: hit.status,
      });
    }
  }

  // 3) 上游 / inflight 去重
  let loader = inflight.get(key);
  if (!loader || noCache) {
    loader = loadWireFromUpstream(dns64);
    if (!noCache) {
      inflight.set(key, loader.finally(() => inflight.delete(key)));
    }
  }

  const result = await loader;
  if (!noCache) {
    cacheSet(key, {
      kind: 'wire',
      data: result.data,
      ttl: result.ttl,
    });
  }

  return send(res, 200, 'application/dns-message', result.data, {
    start,
    mode: noCache ? 'BYPASS' : 'MISS',
    upstream: result.upstream,
    upstreamMs: result.upstreamMs,
  });
}

// ==================== 健康检查 ====================
function handleHealth(res) {
  send(
    res,
    200,
    'application/json; charset=utf-8',
    JSON.stringify({
      status: 'ok',
      cache: cache.size,
      inflight: inflight.size,
      uptime: Math.round(process.uptime()),
      hardcoded: Object.keys(HARDCODED),
    })
  );
}

// ==================== 首页 ====================
function renderHome(origin) {
  const ep = `${origin}/dns-query`;
  const hardcodedHtml = Object.entries(HARDCODED).map(([domain, records]) => {
    const parts = [];
    if (records.A) parts.push(`A: ${records.A.join(', ')}`);
    if (records.AAAA) parts.push(`AAAA: ${records.AAAA.join(', ')}`);
    return `<div><strong>${domain}</strong><br>${parts.join('<br>')}</div>`;
  }).join('<br>');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DoH Server</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:20px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#e9eef8}
.wrap{max-width:900px;margin:0 auto;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:28px;backdrop-filter:blur(12px)}
h1{margin:0 0 8px;font-size:30px}
.sub{margin:0 0 18px;color:#aab6d3}
.card{background:rgba(0,0,0,.22);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:16px;margin-top:16px}
.endpoint{font-family:ui-monospace,Consolas,monospace;background:#0d1324;border:1px solid #27406c;padding:12px;border-radius:10px;word-break:break-all;cursor:pointer;color:#7cc8ff}
.row{display:flex;gap:10px;flex-wrap:wrap}
input,select,button{border:none;border-radius:10px;padding:10px 12px;font-size:14px}
input,select{background:#10182c;color:#fff;border:1px solid rgba(255,255,255,.12)}
button{cursor:pointer;background:linear-gradient(90deg,#58a6ff,#4fd1c5);color:#04111f;font-weight:700}
button.alt{background:linear-gradient(90deg,#f093fb,#f5576c);color:#19070d}
button.gray{background:#334155;color:#fff}
pre{white-space:pre-wrap;background:#09111f;border-radius:10px;padding:14px;max-height:420px;overflow:auto;color:#dbeafe;font-family:ui-monospace,Consolas,monospace}
.small{font-size:13px;color:#b9c4dd;line-height:1.7}
.ok{color:#86efac}
.warn{color:#fbbf24}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:800px){.grid{grid-template-columns:1fr}}
kbd{background:#111827;border:1px solid #374151;border-bottom-width:2px;padding:1px 6px;border-radius:6px;font-size:12px}
</style>
</head>
<body>
<div class="wrap">
  <h1>🔒 DoH Server</h1>
  <p class="sub">专注 linux.do 的低逻辑开销 DoH，支持硬编码返回、缓存和上游回退</p>

  <div class="card">
    <div><strong>DoH Endpoint</strong></div>
    <div class="endpoint" id="ep">${ep}</div>
    <div class="small" id="copyTip">点击复制。Chrome / Edge / Firefox 都可直接填这个地址。</div>
  </div>

  <div class="grid">
    <div class="card">
      <div><strong>当前硬编码域名</strong></div>
      <div class="small" style="margin-top:10px">${hardcodedHtml || '无'}</div>
      <div class="small" style="margin-top:10px">
        命中硬编码时，不走上游 DNS，服务端处理通常只有 <span class="ok">1~3ms</span>。
      </div>
    </div>

    <div class="card">
      <div><strong>怎么看真实浏览器延迟</strong></div>
      <div class="small" style="margin-top:10px">
        1. 下面的 <strong>Wire POST</strong> 比 JSON 更接近浏览器安全 DNS 实际请求。<br>
        2. 看 3 个值：<br>
        - 浏览器总耗时<br>
        - 服务端处理耗时<br>
        - 上游耗时<br><br>
        如果“浏览器总耗时”远大于“服务端处理耗时”，差值基本就是 <span class="warn">链路 + TLS 握手 + 跨境 RTT</span>。
      </div>
    </div>
  </div>

  <div class="card">
    <div><strong>测试</strong></div>
    <div class="row" style="margin-top:12px">
      <input id="domain" value="linux.do" placeholder="域名">
      <select id="type">
        <option>A</option>
        <option>AAAA</option>
        <option>CNAME</option>
        <option>MX</option>
        <option>TXT</option>
        <option>NS</option>
      </select>
      <label class="small" style="display:flex;align-items:center;gap:6px">
        <input id="forceUpstream" type="checkbox" style="width:16px;height:16px"> 强制走上游
      </label>
      <label class="small" style="display:flex;align-items:center;gap:6px">
        <input id="noCache" type="checkbox" checked style="width:16px;height:16px"> 跳过缓存
      </label>
    </div>

    <div class="row" style="margin-top:12px">
      <button id="btnJson">JSON GET 测试</button>
      <button id="btnWire">Wire POST 测试（更接近浏览器 DoH）</button>
      <button class="alt" id="btnCompare">跑一组对比</button>
      <button class="gray" id="btnClear">清空输出</button>
    </div>

    <pre id="out" style="margin-top:14px;display:block"></pre>
  </div>

  <div class="card small">
    <strong>更真实的最终验证：</strong><br>
    把浏览器“安全 DNS”直接设成上面的 DoH 地址，然后用无痕窗口首次打开 <kbd>https://linux.do</kbd>。<br>
    这个首页测试能帮你看清：到底是服务端慢，还是 Render / TLS / 跨境链路慢。
  </div>
</div>

<script>
const E = ${JSON.stringify(ep)};
const out = document.getElementById('out');
const epEl = document.getElementById('ep');
const copyTip = document.getElementById('copyTip');

epEl.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(E);
    copyTip.textContent = '✅ 已复制';
    setTimeout(() => copyTip.textContent = '点击复制。Chrome / Edge / Firefox 都可直接填这个地址。', 1600);
  } catch {}
});

function log(s='') {
  out.textContent += s + "\\n";
  out.scrollTop = out.scrollHeight;
}

function getOpts() {
  return {
    domain: document.getElementById('domain').value.trim(),
    type: document.getElementById('type').value,
    forceUpstream: document.getElementById('forceUpstream').checked,
    noCache: document.getElementById('noCache').checked,
  };
}

function buildDebugUrl() {
  const u = new URL(E);
  const opts = getOpts();
  if (opts.forceUpstream) u.searchParams.set('force_upstream', '1');
  if (opts.noCache) u.searchParams.set('no_cache', '1');
  u.searchParams.set('_', Date.now().toString() + Math.random().toString(16).slice(2));
  return u.toString();
}

function typeNameToNum(type) {
  if (type === 'A') return 1;
  if (type === 'AAAA') return 28;
  if (type === 'CNAME') return 5;
  if (type === 'MX') return 15;
  if (type === 'TXT') return 16;
  if (type === 'NS') return 2;
  return 1;
}

function buildDnsQuery(name, type) {
  const labels = name.replace(/\\.+$/,'').split('.');
  let len = 12 + 4 + 1;
  for (const l of labels) len += 1 + new TextEncoder().encode(l).length;

  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf.subarray(0, 2));
  buf[2] = 0x01; // RD
  buf[5] = 0x01; // QDCOUNT=1

  let o = 12;
  for (const label of labels) {
    const b = new TextEncoder().encode(label);
    buf[o++] = b.length;
    buf.set(b, o);
    o += b.length;
  }
  buf[o++] = 0x00;

  const qtype = typeNameToNum(type);
  buf[o++] = (qtype >> 8) & 0xff;
  buf[o++] = qtype & 0xff;
  buf[o++] = 0x00;
  buf[o++] = 0x01;

  return buf;
}

function skipName(buf, o) {
  while (o < buf.length) {
    const len = buf[o];
    if (len === 0) return o + 1;
    if ((len & 0xc0) === 0xc0) return o + 2;
    o += 1 + len;
  }
  return o;
}

function parseDnsWire(ab) {
  function readName(buf, start, depth) {
    depth = depth || 0;
    if (depth > 8) return '';
    const labels = [];
    let o = start;
    let jumped = false;
    let end = start;

    while (o < buf.length) {
      const len = buf[o];
      if (len === 0) {
        if (!jumped) end = o + 1;
        break;
      }
      if ((len & 0xc0) === 0xc0) {
        if (o + 1 >= buf.length) break;
        const ptr = ((len & 0x3f) << 8) | buf[o + 1];
        const tail = readName(buf, ptr, depth + 1);
        if (tail) labels.push(tail);
        if (!jumped) end = o + 2;
        jumped = true;
        break;
      }
      const next = o + 1 + len;
      if (next > buf.length) break;
      labels.push(new TextDecoder().decode(buf.slice(o + 1, next)));
      o = next;
      if (!jumped) end = o;
    }

    return labels.join('.');
  }

  const buf = new Uint8Array(ab);
  const dv = new DataView(ab);
  const qd = dv.getUint16(4);
  const an = dv.getUint16(6);
  let o = 12;

  for (let i = 0; i < qd; i++) {
    o = skipName(buf, o);
    o += 4;
  }

  const ans = [];
  for (let i = 0; i < an; i++) {
    o = skipName(buf, o);
    const type = dv.getUint16(o);
    const ttl = dv.getUint32(o + 4);
    const rdlen = dv.getUint16(o + 8);
    o += 10;

    if (type === 1 && rdlen === 4) {
      ans.push({
        type: 'A',
        ttl,
        data: [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]].join('.')
      });
    } else if (type === 28 && rdlen === 16) {
      const parts = [];
      for (let j = 0; j < 16; j += 2) {
        parts.push(((buf[o + j] << 8) | buf[o + j + 1]).toString(16));
      }
      ans.push({
        type: 'AAAA',
        ttl,
        data: parts.join(':')
      });
    } else if (type === 5) {
      ans.push({
        type: 'CNAME',
        ttl,
        data: readName(buf, o)
      });
    } else if (type === 2) {
      ans.push({
        type: 'NS',
        ttl,
        data: readName(buf, o)
      });
    } else if (type === 15) {
      const pref = dv.getUint16(o);
      ans.push({
        type: 'MX',
        ttl,
        data: pref + ' ' + readName(buf, o + 2)
      });
    } else if (type === 16) {
      let p = o;
      const txt = [];
      while (p < o + rdlen) {
        const l = buf[p++];
        txt.push(new TextDecoder().decode(buf.slice(p, p + l)));
        p += l;
      }
      ans.push({
        type: 'TXT',
        ttl,
        data: txt.join(' ')
      });
    } else {
      ans.push({
        type: String(type),
        ttl,
        data: 'RDLEN=' + rdlen
      });
    }

    o += rdlen;
  }

  return ans;
}

function formatMeta(f, total) {
  const mode = f.headers.get('X-DoH-Mode') || '-';
  const serverMs = f.headers.get('X-Server-Time-Ms') || '-';
  const upstreamMs = f.headers.get('X-Upstream-Time-Ms') || '-';
  const upstream = f.headers.get('X-DoH-Upstream') || '-';

  return [
    '总耗时: ' + total.toFixed(1) + 'ms',
    '服务端: ' + serverMs + 'ms',
    '上游: ' + upstreamMs + 'ms',
    '模式: ' + mode,
    '上游源: ' + upstream
  ].join(' | ');
}

async function runJsonTest(override) {
  const opts = Object.assign({}, getOpts(), override || {});
  if (!opts.domain) {
    log('❌ 请输入域名');
    return;
  }

  const u = new URL(E);
  u.searchParams.set('name', opts.domain);
  u.searchParams.set('type', opts.type);
  if (opts.forceUpstream) u.searchParams.set('force_upstream', '1');
  if (opts.noCache) u.searchParams.set('no_cache', '1');
  u.searchParams.set('_', Date.now().toString() + Math.random().toString(16).slice(2));

  log('');
  log('⏳ JSON GET ' + opts.domain + ' ' + opts.type + (opts.label ? ' [' + opts.label + ']' : '') + ' ...');

  const s = performance.now();
  const f = await fetch(u.toString(), {
    headers: {
      'Accept': 'application/dns-json',
      'Cache-Control': 'no-store'
    }
  });
  const total = performance.now() - s;

  if (!f.ok) {
    log('❌ HTTP ' + f.status + ' | ' + formatMeta(f, total));
    return;
  }

  const j = await f.json();
  log('✅ ' + formatMeta(f, total));

  if (j.Answer && j.Answer.length) {
    const m = {1:'A',2:'NS',5:'CNAME',15:'MX',16:'TXT',28:'AAAA'};
    j.Answer.forEach(function(a) {
      log('  ' + (m[a.type] || a.type) + ' ' + a.data + ' TTL:' + a.TTL);
    });
  } else {
    log('  ⚠️ 无 Answer');
  }
}

async function runWireTest(override) {
  const opts = Object.assign({}, getOpts(), override || {});
  if (!opts.domain) {
    log('❌ 请输入域名');
    return;
  }

  const u = new URL(E);
  if (opts.forceUpstream) u.searchParams.set('force_upstream', '1');
  if (opts.noCache) u.searchParams.set('no_cache', '1');
  u.searchParams.set('_', Date.now().toString() + Math.random().toString(16).slice(2));

  const q = buildDnsQuery(opts.domain, opts.type);

  log('');
  log('⏳ Wire POST ' + opts.domain + ' ' + opts.type + (opts.label ? ' [' + opts.label + ']' : '') + ' ...');

  const s = performance.now();
  const f = await fetch(u.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/dns-message',
      'Accept': 'application/dns-message',
      'Cache-Control': 'no-store'
    },
    body: q
  });
  const total = performance.now() - s;

  if (!f.ok) {
    log('❌ HTTP ' + f.status + ' | ' + formatMeta(f, total));
    return;
  }

  const ab = await f.arrayBuffer();
  const ans = parseDnsWire(ab);

  log('✅ ' + formatMeta(f, total));
  if (ans.length) {
    ans.forEach(function(a) {
      log('  ' + a.type + ' ' + a.data + ' TTL:' + a.ttl);
    });
  } else {
    log('  ⚠️ 无 Answer');
  }
}

async function runCompare() {
  const opts = getOpts();
  if (!opts.domain) {
    log('❌ 请输入域名');
    return;
  }

  log('');
  log('================ 对比开始 ================');
  log('域名: ' + opts.domain + ' | 类型: ' + opts.type);
  log('说明: Wire POST 更接近浏览器安全 DNS 实际请求');
  log('');

  await runWireTest({
    forceUpstream: false,
    noCache: true,
    label: '默认路径'
  });

  await runWireTest({
    forceUpstream: true,
    noCache: true,
    label: '强制上游'
  });

  await runWireTest({
    forceUpstream: false,
    noCache: false,
    label: '允许缓存'
  });

  log('');
  log('================ 对比结束 ================');
  log('如果“服务端 1~5ms，但总耗时 700ms+”，那瓶颈就在 TLS/跨境链路，不在服务端逻辑。');
}

document.getElementById('btnJson').addEventListener('click', function() {
  runJsonTest().catch(function(e) {
    log('❌ ' + e.message);
  });
});

document.getElementById('btnWire').addEventListener('click', function() {
  runWireTest().catch(function(e) {
    log('❌ ' + e.message);
  });
});

document.getElementById('btnCompare').addEventListener('click', function() {
  runCompare().catch(function(e) {
    log('❌ ' + e.message);
  });
});

document.getElementById('btnClear').addEventListener('click', function() {
  out.textContent = '';
});

document.getElementById('domain').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    runWireTest().catch(function(err) {
      log('❌ ' + err.message);
    });
  }
});

(async function init() {
  try {
    const s = performance.now();
    const f = await fetch(E + '?name=linux.do&type=A&no_cache=1&_=' + Date.now(), {
      headers: { 'Accept': 'application/dns-json' }
    });
    const total = performance.now() - s;
    if (f.ok) {
      log('🚀 就绪 | ' + formatMeta(f, total));
      log('建议先点“跑一组对比”，看默认路径 / 强制上游 / 缓存命中的差异。');
    } else {
      log('❌ 初始化检测失败: HTTP ' + f.status);
    }
  } catch (e) {
    log('❌ 初始化检测失败: ' + e.message);
  }
})();
</script>
</body>
</html>`;
}

// ==================== 首页处理 ====================
function handleHome(req, res) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const origin = proto + '://' + host;
  send(res, 200, 'text/html; charset=utf-8', renderHome(origin));
}

// ==================== 清缓存接口 ====================
function handleFlush(res) {
  cache.clear();
  inflight.clear();
  send(
    res,
    200,
    'application/json; charset=utf-8',
    JSON.stringify({
      ok: true,
      message: 'cache cleared',
      cache: cache.size,
      inflight: inflight.size
    })
  );
}

// ==================== 总路由 ====================
async function handleRequest(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');

  try {
    if (url.pathname === '/') {
      return handleHome(req, res);
    }

    if (url.pathname === '/health') {
      return handleHealth(res);
    }

    if (url.pathname === '/flush') {
      return handleFlush(res);
    }

    if (url.pathname === '/dns-query') {
      if (req.method === 'GET') {
        if (url.searchParams.has('dns')) {
          return await handleWireGet(req, res, url);
        }
        if (url.searchParams.has('name')) {
          return await handleJson(req, res, url);
        }
        return sendJsonError(res, 400, 'Missing name or dns parameter');
      }

      if (req.method === 'POST') {
        return await handleWirePost(req, res, url);
      }

      return sendJsonError(res, 405, 'Method not allowed');
    }

    return sendJsonError(res, 404, 'Not found');
  } catch (e) {
    console.error('Request error:', e);
    return sendJsonError(res, 502, e && e.message ? e.message : 'Bad gateway');
  }
}

// ==================== 启动 ====================
createServer(handleRequest).listen(PORT, '0.0.0.0', () => {
  console.log('DoH server listening on :' + PORT);
  console.log('Hardcoded domains:', Object.keys(HARDCODED));
});
