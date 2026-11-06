/**
 * Cloudflare Pages Functions - API Proxy to Worker
 * Routes /api/* and /r2/* to Worker; rewrites pretty post URLs to /post?id=
 * Also closes the legacy /admin entry.
 */

export const onRequest: PagesFunction<{
	WORKER_URL?: string;
	ADMIN_PANEL_PATH?: string;
	ASSETS: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
}> = async (context) => {
	const { request, env } = context;
	const url = new URL(request.url);
	const pathname = url.pathname;

	const postMatch = pathname.match(/^\/posts\/(\d+)$/) || pathname.match(/^\/post\/(\d+)$/);
	if (postMatch) {
		const dest = new URL('/post', url.origin);
		dest.searchParams.set('id', postMatch[1]);
		for (const [key, value] of url.searchParams.entries()) {
			if (key === 'id' || key === 'post_id') continue;
			dest.searchParams.set(key, value);
		}
		return Response.redirect(dest.toString(), 302);
	}

	// Legacy admin entry: do not serve (obscure path is a static HTML asset)
	if (pathname === '/admin' || pathname === '/admin.html') {
		return new Response('Not Found', {
			status: 404,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'X-Robots-Tag': 'noindex, nofollow',
				'Cache-Control': 'no-store'
			}
		});
	}

	const isApiRoute = pathname.startsWith('/api/');
	const isR2Route = pathname.startsWith('/r2/');

	// Let Pages serve static HTML (incl. obscure admin entry). Do NOT ASSETS.fetch
	// `*.html` here — Pages returns 308 → extensionless URL and that loops forever.
	if (!isApiRoute && !isR2Route) {
		return context.next();
	}

	const corsHeaders = {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS, PUT, DELETE',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Timestamp, X-Nonce'
	};

	if (request.method === 'OPTIONS') {
		return new Response(null, { headers: corsHeaders });
	}

	try {
		const isLocalDev = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
		let workerUrl = env.WORKER_URL || (isLocalDev ? 'http://localhost:8787' : '');

		if (!workerUrl || !workerUrl.startsWith('http')) {
			console.error('WORKER_URL is missing or invalid. Set Pages env WORKER_URL to your Worker URL.');
			return Response.json(
				{
					error: 'Forum API proxy is not configured',
					message: 'Missing WORKER_URL on Cloudflare Pages'
				},
				{ status: 500, headers: corsHeaders }
			);
		}

		const forwardUrl = new URL(pathname + url.search, workerUrl);
		const forwardHeaders = new Headers(request.headers);
		forwardHeaders.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
		forwardHeaders.set('X-Forwarded-Host', url.hostname);
		forwardHeaders.set('X-Original-URL', url.origin);

		const response = await fetch(
			new Request(forwardUrl.toString(), {
				method: request.method,
				headers: forwardHeaders,
				body: request.body
			})
		);

		const headers = new Headers(response.headers);
		Object.entries(corsHeaders).forEach(([key, val]) => headers.set(key, val));

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers
		});
	} catch (error) {
		console.error('❌ API proxy error:', error);
		return Response.json({ error: 'Upstream API unavailable' }, { status: 502, headers: corsHeaders });
	}
};
