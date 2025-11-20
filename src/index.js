const CUSTOM_DOMAIN = "cf.20220625.xyz";

const dockerHub = "https://registry-1.docker.io";

// 路由映射：自定义子域名 → 上游 registry
const routes = {
  ["docker-" + CUSTOM_DOMAIN]: dockerHub,
  ["quay-" + CUSTOM_DOMAIN]: "https://quay.io",
  ["k8s-" + CUSTOM_DOMAIN]: "https://registry.k8s.io",
  ["k8s-gcr-" + CUSTOM_DOMAIN]: "https://k8s.gcr.io",
  // ["gcr-" + CUSTOM_DOMAIN]: "https://cloudcone-gcr.20220625.xyz",
  // ["ghcr-" + CUSTOM_DOMAIN]: "https://cloudcone-ghcr.20220625.xyz",
  ["gcr-" + CUSTOM_DOMAIN]: "https://gcr.io",
  ["ghcr-" + CUSTOM_DOMAIN]: "https://ghcr.io",
  ["cloudsmith-" + CUSTOM_DOMAIN]: "https://docker.cloudsmith.io",
  ["ecr-" + CUSTOM_DOMAIN]: "https://public.ecr.aws",
  ["docker-staging-" + CUSTOM_DOMAIN]: dockerHub,
};

// 为特定上游设置额外请求头（关键：Host 透传）
const extraHeaders = {
  ["gcr-" + CUSTOM_DOMAIN]: { Host: "gcr.io" },
  ["ghcr-" + CUSTOM_DOMAIN]: { Host: "ghcr.io" },
  // 其他 registry 如需 Host 透传可在此添加
};

function routeByHosts(host) {
  return routes[host] || "";
}

function responseUnauthorized(url) {
  const realm = url.protocol === "https:" 
    ? `https://${url.hostname}/v2/auth`
    : `http://${url.host}/v2/auth`;
  const headers = new Headers();
  headers.set("WWW-Authenticate", `Bearer realm="${realm}",service="cloudflare-docker-proxy"`);
  return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
    status: 401,
    headers,
  });
}

function parseAuthenticate(authenticateStr) {
  // Bearer realm="...",service="..."
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
  const matches = authenticateStr.match(re);
  if (!matches || matches.length < 2) {
    throw new Error(`Invalid WWW-Authenticate: ${authenticateStr}`);
  }
  return { realm: matches[0], service: matches[1] };
}

async function fetchToken(wwwAuthenticate, scope, authorization) {
  const url = new URL(wwwAuthenticate.realm);
  if (wwwAuthenticate.service) url.searchParams.set("service", wwwAuthenticate.service);
  if (scope) url.searchParams.set("scope", scope);
  const headers = new Headers();
  if (authorization) headers.set("Authorization", authorization);
  return fetch(url, { method: "GET", headers });
}

async function handleRequest(request) {
  const url = new URL(request.url);

  // 根路径重定向到 /v2/
  if (url.pathname === "/") {
    return Response.redirect(url.origin + "/v2/", 301);
  }

  const host = url.hostname;
  const upstream = routeByHosts(host);
  if (!upstream) {
    return new Response(JSON.stringify({ routes }), { status: 404 });
  }

  const upstreamExtraHeader = extraHeaders[host] || {};
  const isDockerHub = upstream === dockerHub;
  const isGHCR = host === "ghcr-" + CUSTOM_DOMAIN;
  const isGCR = host === "gcr-" + CUSTOM_DOMAIN;
  const isOCIRegistry = isDockerHub || isGHCR || isGCR;

  const authorization = request.headers.get("Authorization");

  // === /v2/ endpoint ===
  if (url.pathname === "/v2/") {
    const newUrl = new URL(upstream + "/v2/");
    const headers = new Headers();
    if (authorization) headers.set("Authorization", authorization);
    for (const [k, v] of Object.entries(upstreamExtraHeader)) headers.set(k, v);

    const resp = await fetch(newUrl, { method: "GET", headers, redirect: "follow" });
    if (resp.status === 401) return responseUnauthorized(url);
    return resp;
  }

  // === /v2/auth token endpoint ===
  if (url.pathname === "/v2/auth") {
    const newUrl = new URL(upstream + "/v2/");
    const headers = new Headers();
    if (authorization) headers.set("Authorization", authorization);
    for (const [k, v] of Object.entries(upstreamExtraHeader)) headers.set(k, v);

    const resp = await fetch(newUrl, { method: "GET", headers, redirect: "follow" });
    if (resp.status !== 401) return resp;

    const authHeader = resp.headers.get("WWW-Authenticate");
    if (!authHeader) return resp;

    try {
      const wwwAuth = parseAuthenticate(authHeader);
      let scope = url.searchParams.get("scope");

      // Docker Hub library 补全
      if (scope && isDockerHub) {
        const parts = scope.split(":");
        if (parts.length === 3 && !parts[1].includes("/")) {
          parts[1] = "library/" + parts[1];
          scope = parts.join(":");
        }
      }

      return await fetchToken(wwwAuth, scope, authorization);
    } catch (e) {
      console.error("Auth parse error:", e);
      return resp;
    }
  }

  // === Docker Hub library 路径重写 ===
  if (isDockerHub) {
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length === 3) { // e.g., /v2/busybox/manifests/latest → 4 parts including "v2"
      // Actually: /v2/<name>/... → if <name> has no slash, prepend "library"
      const name = pathParts[1];
      if (name && !name.includes("/")) {
        const newPath = `/v2/library/${url.pathname.slice(4)}`; // skip "/v2/"
        return Response.redirect(new URL(newPath, url).href, 301);
      }
    }
  }

  // === 通用请求转发 ===
  const newUrl = new URL(upstream + url.pathname + url.search);
  const newHeaders = new Headers(request.headers);
  for (const [k, v] of Object.entries(upstreamExtraHeader)) {
    newHeaders.set(k, v);
  }

  const newReq = new Request(newUrl, {
    method: request.method,
    headers: newHeaders,
    redirect: isOCIRegistry ? "manual" : "follow",
  });

  const resp = await fetch(newReq);

  if (resp.status === 401) {
    return responseUnauthorized(url);
  }

  // === 关键：将 307/308 重定向原样返回给 Docker 客户端 ===
  if (isOCIRegistry && (resp.status === 307 || resp.status === 308)) {
    const location = resp.headers.get("Location");
    if (location) {
      // 确保 Location 是绝对 URL（某些 registry 返回相对路径）
      const absoluteLocation = new URL(location, upstream).href;
      const newResp = new Response(resp.body, resp);
      newResp.headers.set("Location", absoluteLocation);
      return newResp;
    }
  }

  return resp;
}

export default {
  async fetch(request, env, ctx) {
    ctx.passThroughOnException();
    return handleRequest(request);
  },
};