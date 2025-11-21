
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleRequest } from './index';

// Mock fetch
const fetchMock = vi.fn();
global.fetch = fetchMock;

// Mock Env
const env = {
    CUSTOM_DOMAIN: 'example.com',
    TARGET_UPSTREAM: 'https://registry-1.docker.io',
    MODE: 'production',
};

describe('handleRequest', () => {
    beforeEach(() => {
        fetchMock.mockReset();
    });

    it('should redirect root to /v2/', async () => {
        const request = new Request('https://example.com/');
        const response = await handleRequest(request, env);
        expect(response.status).toBe(301);
        expect(response.headers.get('Location')).toBe('https://example.com/v2/');
    });

    it('should route to Docker Hub by default', async () => {
        const request = new Request('https://example.com/v2/');
        fetchMock.mockResolvedValue(new Response('OK'));

        await handleRequest(request, env);

        expect(fetchMock).toHaveBeenCalledWith(
            expect.objectContaining({
                href: 'https://registry-1.docker.io/v2/',
            }),
            expect.anything()
        );
    });

    it('should route to GHCR based on path prefix', async () => {
        const request = new Request('https://example.com/ghcr.io/v2/');
        fetchMock.mockResolvedValue(new Response('OK'));

        await handleRequest(request, env);

        expect(fetchMock).toHaveBeenCalledWith(
            expect.objectContaining({
                href: 'https://ghcr.io/v2/',
            }),
            expect.anything()
        );
    });

    it('should rewrite Docker Hub library paths', async () => {
        const request = new Request('https://example.com/v2/busybox/manifests/latest');
        const response = await handleRequest(request, env);

        expect(response.status).toBe(301);
        expect(response.headers.get('Location')).toBe('https://example.com/v2/library/busybox/manifests/latest');
    });

    it('should not rewrite Docker Hub paths that already have library', async () => {
        const request = new Request('https://example.com/v2/library/busybox/manifests/latest');
        fetchMock.mockResolvedValue(new Response('OK'));

        await handleRequest(request, env);

        expect(fetchMock).toHaveBeenCalledWith(
            expect.any(Request),
        );
        const req = fetchMock.mock.calls[0][0] as Request;
        expect(req.url).toBe('https://registry-1.docker.io/v2/library/busybox/manifests/latest');
    });

    it('should handle 401 Unauthorized', async () => {
        const request = new Request('https://example.com/v2/');
        fetchMock.mockResolvedValue(new Response('Unauthorized', { status: 401 }));

        const response = await handleRequest(request, env);

        expect(response.status).toBe(401);
        expect(response.headers.get('WWW-Authenticate')).toContain('Bearer realm="https://example.com/v2/auth"');
    });

    it('should handle 307 redirects manually', async () => {
        const request = new Request('https://example.com/v2/library/blobs/sha256:123');
        fetchMock.mockResolvedValue(new Response('Redirect', {
            status: 307,
            headers: { Location: '/v2/library/blobs/sha256:123/data' }
        }));

        const response = await handleRequest(request, env);

        expect(response.status).toBe(307);
        expect(response.headers.get('Location')).toBe('https://registry-1.docker.io/v2/library/blobs/sha256:123/data');
    });
});
