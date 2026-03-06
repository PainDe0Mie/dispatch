/**
 * Discord Dataminer — Cloudflare Worker Proxy
 * 
 * DÉPLOIEMENT (5 minutes) :
 * 1. Va sur https://workers.cloudflare.com/ → crée un compte gratuit
 * 2. "Create a Worker" → colle ce code → "Save & Deploy"
 * 3. Copie l'URL du worker (ex: https://discord-proxy.TON-NOM.workers.dev)
 * 4. Dans script.js, remplace PROXY_URL par ton URL
 * 
 * Gratuit : 100 000 requêtes/jour, pas de carte bancaire requise.
 */

const ALLOWED_ORIGINS = [
    'https://canary.discord.com',
    'https://discord.com',
];

export default {
    async fetch(request) {
        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        const url    = new URL(request.url);
        // Le fichier à fetcher est passé en query param: ?url=https://canary.discord.com/assets/web.abc.js
        const target = url.searchParams.get('url');

        if (!target) {
            return new Response('Missing ?url= parameter', { status: 400 });
        }

        // Sécurité : on autorise seulement les assets Discord
        const isAllowed = ALLOWED_ORIGINS.some(o => target.startsWith(o));
        if (!isAllowed) {
            return new Response('Origin not allowed', { status: 403 });
        }

        try {
            const upstream = await fetch(target, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; DiscordDataminer/1.0)',
                },
                cf: { cacheEverything: true, cacheTtl: 3600 }, // Cache 1h côté Cloudflare
            });

            if (!upstream.ok) {
                return new Response(`Upstream error: ${upstream.status}`, { status: upstream.status });
            }

            const body = await upstream.arrayBuffer();

            return new Response(body, {
                status: 200,
                headers: {
                    'Content-Type': upstream.headers.get('Content-Type') || 'application/javascript',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'public, max-age=3600',
                    'X-Proxied-From': target,
                },
            });

        } catch (err) {
            return new Response(`Worker error: ${err.message}`, { status: 500 });
        }
    },
};
