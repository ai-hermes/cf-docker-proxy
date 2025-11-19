const CUSTOM_DOMAIN = "cf.20220625.xyz"
const dockerHub = "https://registry-1.docker.io";

const routes = {
  // production
  ["docker-" + CUSTOM_DOMAIN]: dockerHub,
  ["quay-" + CUSTOM_DOMAIN]: "https://quay.io",
  ["k8s-" + CUSTOM_DOMAIN]: "https://registry.k8s.io",
  ["k8s-gcr-" + CUSTOM_DOMAIN]: "https://k8s.gcr.io",
  // ["gcr-" + CUSTOM_DOMAIN]: "https://gcr.io",
  // ["ghcr-" + CUSTOM_DOMAIN]: "https://ghcr.io",
  ["gcr-" + CUSTOM_DOMAIN]: "https://cloudcone-gcr.20220625.xyz",
  ["ghcr-" + CUSTOM_DOMAIN]: "https://cloudcone-ghcr.20220625.xyz",
  ["cloudsmith-" + CUSTOM_DOMAIN]: "https://docker.cloudsmith.io",
  ["ecr-" + CUSTOM_DOMAIN]: "https://public.ecr.aws",

  // staging
  ["docker-staging-" + CUSTOM_DOMAIN]: dockerHub,
};


const extraHeaders = {
  // ["gcr-" + CUSTOM_DOMAIN] : {
  //   "Host": "gcr.20220625.xyz"
  // },
  // ["ghcr-" + CUSTOM_DOMAIN] : {
  //   "Host": "ghcr.20220625.xyz"
  // },
}

function routeByHosts(host) {
  if (host in routes) {
    return routes[host];
  }
  if (MODE == "debug") {
    return TARGET_UPSTREAM;
  }
  return "";
}

async function handleRequest(request) {
  const url = new URL(request.url);
  if (url.pathname == "/") {
    return Response.redirect(url.protocol + "//" + url.host + "/v2/", 301);
  }
  const upstream = routeByHosts(url.hostname);
  if (upstream === "") {
    return new Response(
      JSON.stringify({
        routes: routes,
      }),
      {
        status: 404,
      }
    );
  }
  const upstreamExtraHeader = extraHeaders[url.hostname] || {};
  console.log('upstreamExtraHeader', upstreamExtraHeader)
  const isDockerHub = upstream == dockerHub;
  const authorization = request.headers.get("Authorization");
  if (url.pathname == "/v2/") {
    const newUrl = new URL(upstream + "/v2/");
    const headers = new Headers();
    if (authorization) {
      headers.set("Authorization", authorization);
    }
    // add upstream extra headers
    for (const [key, value] of Object.entries(upstreamExtraHeader)) {
      headers.set(key, value);
    }
    // check if need to authenticate
    const resp = await fetch(newUrl.toString(), {
      method: "GET",
      headers: headers,
      redirect: "follow",
    });
    if (resp.status === 401) {
      return responseUnauthorized(url);
    }
    return resp;
  }
  // get token
  if (url.pathname == "/v2/auth") {
    const newUrl = new URL(upstream + "/v2/");
    const headers = new Headers();
    if (authorization) {
      headers.set("Authorization", authorization);
    }
    // add upstream extra headers
    for (const [key, value] of Object.entries(upstreamExtraHeader)) {
      headers.set(key, value);
    }
    const resp = await fetch(newUrl.toString(), {
      method: "GET",
      headers: headers,
      redirect: "follow",
    });
    if (resp.status !== 401) {
      return resp;
    }
    const authenticateStr = resp.headers.get("WWW-Authenticate");
    if (authenticateStr === null) {
      return resp;
    }
    const wwwAuthenticate = parseAuthenticate(authenticateStr);
    let scope = url.searchParams.get("scope");
    // autocomplete repo part into scope for DockerHub library images
    // Example: repository:busybox:pull => repository:library/busybox:pull
    if (scope && isDockerHub) {
      let scopeParts = scope.split(":");
      if (scopeParts.length == 3 && !scopeParts[1].includes("/")) {
        scopeParts[1] = "library/" + scopeParts[1];
        scope = scopeParts.join(":");
      }
    }
    return await fetchToken(wwwAuthenticate, scope, authorization);
  }
  // redirect for DockerHub library images
  // Example: /v2/busybox/manifests/latest => /v2/library/busybox/manifests/latest
  if (isDockerHub) {
    const pathParts = url.pathname.split("/");
    if (pathParts.length == 5) {
      pathParts.splice(2, 0, "library");
      const redirectUrl = new URL(url);
      redirectUrl.pathname = pathParts.join("/");
      return Response.redirect(redirectUrl, 301);
    }
  }
  // foward requests
  const newUrl = new URL(upstream + url.pathname);
  // copy existing headers and add upstream extra headers
  const newHeaders = new Headers(request.headers);
  for (const [key, value] of Object.entries(upstreamExtraHeader)) {
    newHeaders.set(key, value);
  }
  const newReq = new Request(newUrl, {
    method: request.method,
    headers: newHeaders,
    // don't follow redirect to dockerhub blob upstream
    redirect: isDockerHub ? "manual" : "follow",
  });
  const resp = await fetch(newReq);
  if (resp.status == 401) {
    return responseUnauthorized(url);
  }
  // handle dockerhub blob redirect manually
  if (isDockerHub && resp.status == 307) {
    const location = new URL(resp.headers.get("Location"));
    const redirectResp = await fetch(location.toString(), {
      method: "GET",
      redirect: "follow",
    });
    return redirectResp;
  }
  return resp;
}

function parseAuthenticate(authenticateStr) {
  // sample: Bearer realm="https://auth.ipv6.docker.com/token",service="registry.docker.io"
  // match strings after =" and before "
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
  const matches = authenticateStr.match(re);
  if (matches == null || matches.length < 2) {
    throw new Error(`invalid Www-Authenticate Header: ${authenticateStr}`);
  }
  return {
    realm: matches[0],
    service: matches[1],
  };
}

async function fetchToken(wwwAuthenticate, scope, authorization) {
  const url = new URL(wwwAuthenticate.realm);
  if (wwwAuthenticate.service.length) {
    url.searchParams.set("service", wwwAuthenticate.service);
  }
  if (scope) {
    url.searchParams.set("scope", scope);
  }
  const headers = new Headers();
  if (authorization) {
    headers.set("Authorization", authorization);
  }
  return await fetch(url, { method: "GET", headers: headers });
}

function responseUnauthorized(url) {
  const headers = new Headers();
  if (MODE == "debug") {
    headers.set(
      "Www-Authenticate",
      `Bearer realm="http://${url.host}/v2/auth",service="cloudflare-docker-proxy"`
    );
  } else {
    headers.set(
      "Www-Authenticate",
      `Bearer realm="https://${url.hostname}/v2/auth",service="cloudflare-docker-proxy"`
    );
  }
  return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
    status: 401,
    headers: headers,
  });
}

/*
addEventListener("fetch", (event) => {
  event.passThroughOnException();
  event.respondWith(handleRequest(event.request));
});
*/
export default {
  async fetch(request, env, ctx) {
    ctx.passThroughOnException();
    return handleRequest(request)
  },
};