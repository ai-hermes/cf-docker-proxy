# cloudflare-docker-proxy

> ### ⚠️ **Important Notice**
> <span style="color:#d73a49;font-weight:bold">Docker Hub is rate-limiting Cloudflare Worker IPs, causing frequent <code>429</code> errors.</span>  
> <span style="color:#d73a49;font-weight:bold">This project is currently NOT recommended for production use.</span>


Due to the current instability, this project is not recommended for production use.
We will provide updates as soon as more information becomes available.


![deploy](https://github.com/ciiiii/cloudflare-docker-proxy/actions/workflows/deploy.yaml/badge.svg)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ciiiii/cloudflare-docker-proxy)

> If you're looking for proxy for helm, maybe you can try [cloudflare-helm-proxy](https://github.com/ciiiii/cloudflare-helm-proxy).

## Deploy

1. Fork this repository.
2. Edit `wrangler.toml` and set `CUSTOM_DOMAIN` to your domain.
3. Run `pnpm install` to install dependencies.
4. Run `pnpm run deploy` to deploy to Cloudflare Workers.

## Configuration

You can configure the following environment variables in `wrangler.toml` or via the Cloudflare Dashboard:

- `CUSTOM_DOMAIN`: Your custom domain (e.g., `example.com`).
- `TARGET_UPSTREAM`: The default upstream registry (default: `https://registry-1.docker.io`).
- `MODE`: The mode of operation (e.g., `production`, `staging`, `debug`).

## Usage

This proxy uses path-based routing. The default registry is Docker Hub.

- **Docker Hub**: `https://your-domain.com/image` (e.g., `https://your-domain.com/busybox`)
- **GitHub Container Registry**: `https://your-domain.com/ghcr.io/user/image`
- **Google Container Registry**: `https://your-domain.com/gcr.io/project/image`
- **Quay.io**: `https://your-domain.com/quay.io/user/image`
- **Kubernetes Registry**: `https://your-domain.com/registry.k8s.io/image`

## Development

To run the worker locally:

```bash
pnpm run dev
```
