
interface Env {
    CUSTOM_DOMAIN: string;
    TARGET_UPSTREAM: string;
    MODE: string;
}

const dockerHub = "https://registry-1.docker.io";

const routes: Record<string, string> = {
    "docker.io": dockerHub,
    "quay.io": "https://quay.io",
    "gcr.io": "https://gcr.io",
    "k8s.gcr.io": "https://k8s.gcr.io",
    "registry.k8s.io": "https://registry.k8s.io",
    "ghcr.io": "https://ghcr.io",
    "docker.cloudsmith.io": "https://docker.cloudsmith.io",
    "public.ecr.aws": "https://public.ecr.aws",
};

function responseUnauthorized(url: URL): Response {
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

function parseAuthenticate(authenticateStr: string): { realm: string; service: string } {
    const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
    const matches = authenticateStr.match(re);
    if (!matches || matches.length < 2) {
        throw new Error(`Invalid WWW-Authenticate: ${authenticateStr}`);
    }
    return { realm: matches[0], service: matches[1] };
}

async function fetchToken(wwwAuthenticate: { realm: string; service: string }, scope: string | null, authorization: string | null): Promise<Response> {
    const url = new URL(wwwAuthenticate.realm);
    if (wwwAuthenticate.service) url.searchParams.set("service", wwwAuthenticate.service);
    if (scope) url.searchParams.set("scope", scope);
    const headers = new Headers();
    if (authorization) headers.set("Authorization", authorization);
    return fetch(url, { method: "GET", headers });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle root redirect
    if (url.pathname === "/") {
        return Response.redirect(url.origin + "/v2/", 301);
    }

    // Determine upstream and path prefix
    let upstream = dockerHub;
    let pathPrefix = "";

    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length > 0) {
        const potentialHost = pathParts[0];
        if (routes[potentialHost]) {
            upstream = routes[potentialHost];
            pathPrefix = "/" + potentialHost;
        }
    }

    // Construct upstream URL
    let upstreamPath = url.pathname;
    if (pathPrefix) {
        upstreamPath = upstreamPath.slice(pathPrefix.length);
        if (!upstreamPath.startsWith("/")) {
            upstreamPath = "/" + upstreamPath;
        }
    }

    const isDockerHub = upstream === dockerHub;

    const authorization = request.headers.get("Authorization");

    // === /v2/ endpoint ===
    if (upstreamPath === "/v2/" || upstreamPath === "/v2") {
        const newUrl = new URL(upstream + "/v2/");
        const headers = new Headers();
        if (authorization) headers.set("Authorization", authorization);

        const resp = await fetch(newUrl, { method: "GET", headers, redirect: "follow" });
        if (resp.status === 401) return responseUnauthorized(url);
        return resp;
    }

    // === /v2/auth token endpoint ===
    if (upstreamPath === "/v2/auth") {
        const newUrl = new URL(upstream + "/v2/");
        const headers = new Headers();
        if (authorization) headers.set("Authorization", authorization);

        const resp = await fetch(newUrl, { method: "GET", headers, redirect: "follow" });
        if (resp.status !== 401) return resp;

        const authHeader = resp.headers.get("WWW-Authenticate");
        if (!authHeader) return resp;

        try {
            const wwwAuth = parseAuthenticate(authHeader);
            let scope = url.searchParams.get("scope");

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

    // === Docker Hub library path rewrite ===
    if (isDockerHub) {
        const parts = upstreamPath.split("/").filter(Boolean);
        if (parts.length >= 3) { // /v2/name/manifests/... or /v2/name/blobs/...
            const name = parts[1];
            if (name && !name.includes("/") && name !== "library") {
                const newUpstreamPath = `/v2/library/${upstreamPath.slice(4)}`;
                const newUrlPath = pathPrefix + newUpstreamPath;
                return Response.redirect(new URL(newUrlPath, url.origin).href, 301);
            }
        }
    }

    // === Forward Request ===
    const newUrl = new URL(upstream + upstreamPath + url.search);
    const newHeaders = new Headers(request.headers);

    const newReq = new Request(newUrl, {
        method: request.method,
        headers: newHeaders,
        redirect: "manual",
    });

    const resp = await fetch(newReq);

    if (resp.status === 401) {
        return responseUnauthorized(url);
    }

    if (resp.status === 307 || resp.status === 308) {
        const location = resp.headers.get("Location");
        if (location) {
            const absoluteLocation = new URL(location, upstream).href;
            const newResp = new Response(resp.body, resp);
            newResp.headers.set("Location", absoluteLocation);
            return newResp;
        }
    }

    return resp;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        ctx.passThroughOnException();
        return handleRequest(request, env);
    },
};
