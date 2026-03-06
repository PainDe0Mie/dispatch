/**
 * Discord Dataminer — Cloudflare Worker Proxy v2
 * 
 * MISE À JOUR :
 * 1. Va sur https://workers.cloudflare.com/
 * 2. Ouvre ton worker "dispatch" → Edit Code
 * 3. Remplace TOUT le code par celui-ci → Save & Deploy
 */

export default {
    async fetch(request) {
        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        const url    = new URL(request.url);
        const target = url.searchParams.get('url');

        if (!target) {
            return new Response('Missing ?url= parameter', { status: 400 });
        }

        // Sécurité : seulement les assets Discord
        if (!target.startsWith('https://canary.discord.com/assets/') &&
            !target.startsWith('https://discord.com/assets/')) {
            return new Response('Origin not allowed', { status: 403 });
        }

        try {
            const upstream = await fetch(target, {
                method: 'GET',
                headers: {
                    // Headers qui imitent un vrai navigateur Chrome
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Referer': 'https://canary.discord.com/',
                    'Origin': 'https://canary.discord.com',
                    'Sec-Fetch-Dest': 'script',
                    'Sec-Fetch-Mode': 'no-cors',
                    'Sec-Fetch-Site': 'same-origin',
                    'Sec-CH-UA': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
                    'Sec-CH-UA-Mobile': '?0',
                    'Sec-CH-UA-Platform': '"Windows"',
                    'Connection': 'keep-alive',
                },
                cf: {
                    // Cache Cloudflare côté edge pendant 1h
                    cacheEverything: true,
                    cacheTtl: 3600,
                },
                redirect: 'follow',
            });

            if (!upstream.ok) {
                return new Response(
                    `Discord returned HTTP ${upstream.status} for ${target}`,
                    { status: upstream.status }
                );
            }

            // Vérifier que c'est bien du JS/CSS et pas une page d'erreur HTML
            const contentType = upstream.headers.get('Content-Type') || '';
            if (contentType.includes('text/html')) {
                return new Response(
                    'Discord returned an HTML error page — the file may not exist or Discord is rate-limiting',
                    { status: 503 }
                );
            }

            const body = await upstream.arrayBuffer();

            return new Response(body, {
                status: 200,
                headers: {
                    'Content-Type': contentType || 'application/javascript',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'public, max-age=3600',
                    'X-Proxied-From': target,
                    'X-Content-Length': body.byteLength.toString(),
                },
            });

        } catch (err) {
            return new Response(`Worker error: ${err.message}`, {
                status: 500,
                headers: { 'Access-Control-Allow-Origin': '*' },
            });
        }
    },
};
