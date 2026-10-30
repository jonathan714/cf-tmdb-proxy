// ========== 配置区，自行修改 ==========
const MEM_CACHE_TTL = 86400 * 3; // 内存缓存有效期 3天（单位秒）
const MAX_CACHE_SIZE = 2000;     // 内存缓存最大条数，防止内存溢出
// =====================================

// 模块级内存缓存，同一个Worker实例内共享
const cacheMap = new Map();

// 清理过期缓存 + 超量淘汰（简易LRU，删除最早存入）
function cleanCache() {
  const now = Date.now();
  // 清理过期
  for (const [k, v] of cacheMap.entries()) {
    if (v.expire < now) {
      cacheMap.delete(k);
    }
  }
  // 超出上限，删除最早的
  if (cacheMap.size > MAX_CACHE_SIZE) {
    const delCount = cacheMap.size - MAX_CACHE_SIZE;
    const keys = Array.from(cacheMap.keys()).slice(0, delCount);
    for (const k of keys) cacheMap.delete(k);
  }
}

export default {
  async fetch(request, env, ctx) {
    const reqUrl = new URL(request.url);
    const path = reqUrl.pathname;
    const searchParams = new URLSearchParams(reqUrl.search);
    let targetHost = "";

    // 路由匹配
    if (path.startsWith("/api")) {
      targetHost = "api.themoviedb.org";
    } else if (path.startsWith("/image")) {
      targetHost = "image.tmdb.org";
    } else {
      return new Response("TMDB Proxy Ready, use /api or /image", { status: 200 });
    }

    // ========== API 接口逻辑（api_key由外部传入，原样携带） ==========
    if (targetHost === "api.themoviedb.org") {
      // 缓存key：路径 + 全部query参数（包含传入的api_key，不同key分开缓存）
      const cacheKey = `${path}?${searchParams.toString()}`;
      cleanCache();

      // 命中内存缓存
      if (cacheMap.has(cacheKey)) {
        const cached = cacheMap.get(cacheKey);
        if (cached.expire > Date.now()) {
          const selfHost = reqUrl.host;
          const body = cached.body.replaceAll("https://image.tmdb.org", `https://${selfHost}/image`);
          return new Response(body, {
            status: cached.status,
            headers: new Headers(cached.headers)
          });
        } else {
          cacheMap.delete(cacheKey);
        }
      }

      // 未命中缓存，构造上游请求，api_key原样透传
      const upstreamUrl = new URL(`https://api.themoviedb.org${path.replace(/^\/api/, "")}`);
      upstreamUrl.search = searchParams.toString();

      const headers = new Headers(request.headers);
      headers.set("Host", "api.themoviedb.org");
      headers.set("Referer", "https://www.themoviedb.org");
      headers.set("X-Real-IP", request.headers.get("cf-connecting-ip"));
      headers.set("X-Forwarded-For", request.headers.get("cf-connecting-ip"));

      const upstreamReq = new Request(upstreamUrl, {
        method: request.method,
        headers: headers,
        body: request.body,
        redirect: "follow"
      });

      const res = await fetch(upstreamReq);

      // 只有成功响应才写入内存缓存，429/404等异常不缓存
      if (res.ok) {
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("json") || contentType.includes("text")) {
          const resText = await res.text();
          const cacheItem = {
            status: res.status,
            headers: Object.fromEntries(res.headers),
            body: resText,
            expire: Date.now() + MEM_CACHE_TTL * 1000
          };
          cacheMap.set(cacheKey, cacheItem);

          const selfHost = reqUrl.host;
          const newBody = resText.replaceAll("https://image.tmdb.org", `https://${selfHost}/image`);
          return new Response(newBody, {
            status: res.status,
            headers: res.headers
          });
        }
      }
      return res;
    }

    // ========== 图片接口逻辑，走CF边缘缓存，不进内存缓存 ==========
    if (targetHost === "image.tmdb.org") {
      const upstreamUrl = new URL(`https://image.tmdb.org${path.replace(/^\/image/, "")}`);
      upstreamUrl.search = reqUrl.search;

      const headers = new Headers(request.headers);
      headers.set("Host", "image.tmdb.org");
      headers.set("Referer", "https://www.themoviedb.org");

      const upstreamReq = new Request(upstreamUrl, {
        method: request.method,
        headers: headers,
        body: request.body,
        redirect: "follow"
      });

      return fetch(upstreamReq, {
        cf: {
          cacheTtl: 86400 * 7,
          cacheEverything: true
        }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
