import fetch from 'node-fetch';
import fs    from 'fs';
import path  from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

const DISCORD_CANARY  = 'https://canary.discord.com';
const DATAMINING_REPO = 'Discord-Datamining/Discord-Datamining';
const ASSETS_DIR      = path.join(ROOT, 'assets');
const STATE_FILE      = path.join(ROOT, 'state.json');
const CHANGELOG_FILE  = path.join(ROOT, 'changelog.json');

const BROWSER_HEADERS = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept':          '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer':         'https://canary.discord.com/',
    'Origin':          'https://canary.discord.com',
    'Sec-Fetch-Dest':  'script',
    'Sec-Fetch-Mode':  'no-cors',
    'Sec-Fetch-Site':  'same-origin',
};

function loadJSON(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
}
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function parseCommit(message) {
    // Normalise les fins de ligne Windows/Mac
    const lines = message.replace(/\r/g, '').split('\n').map(l => l.trim());
    const result = { buildNumber: null, files: {} };
    const m = lines[0].match(/(\d{5,})/);
    result.buildNumber = m ? m[1] : lines[0];

    // Supporte tous les formats de section connus
    const SECS = {
        'Scripts':'js', 'Script':'js', 'JavaScript':'js', 'JS':'js',
        'Stylesheet':'css', 'Stylesheets':'css', 'CSS':'css',
        'Workers':'worker', 'Worker':'worker',
        'Assets':'asset', 'Asset':'asset',
        'Manifests':'manifest', 'Manifest':'manifest',
        'Other':'other',
    };
    let sec = null;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i]; if (!line) continue;

        // Détection de section (avec ou sans ":")
        const sKey = Object.keys(SECS).find(k => line === k+':' || line === k);
        if (sKey) { sec = SECS[sKey]; result.files[sec] ??= []; continue; }

        // Ligne de fichier : supporte "- file.js" ET "file.js" (nouveau format)
        if (sec) {
            let fname = null;
            if (line.startsWith('- ')) fname = line.slice(2).trim();
            else if (/^[\w\-]+\.[\w\-\.]+$/.test(line)) fname = line; // bare filename
            if (fname && fname.length > 0) {
                result.files[sec].push(fname);
            }
        }
    }
    return result;
}

async function githubGet(url) {
    const res = await fetch(url, {
        headers: {
            'Accept':        'application/vnd.github.v3+json',
            'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
            'User-Agent':    'discord-tracker-bot/1.0',
        }
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`GitHub API ${res.status}: ${body.slice(0,200)}`);
    }
    return res.json();
}

async function downloadDiscordFile(filename) {
    const url = `${DISCORD_CANARY}/assets/${filename}`;
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/html')) throw new Error('Discord a retourné du HTML (rate-limited?)');
    return res.text();
}

async function main() {
    const state = loadJSON(STATE_FILE, { lastSha: null, knownFiles: {} });
    log(`Dernier commit traité: ${state.lastSha || 'aucun'}`);
    fs.mkdirSync(ASSETS_DIR, { recursive: true });

    // 1. Récupère les commits récents de Discord-Datamining
    const allCommits = await githubGet(`https://api.github.com/repos/${DATAMINING_REPO}/commits?per_page=50`);

    let toProcess = [];
    if (!state.lastSha) {
        // Premier run : prend les 30 derniers commits
        toProcess = allCommits.slice(0, 30).reverse();
    } else {
        const idx = allCommits.findIndex(c => c.sha === state.lastSha);

        if (idx === 0) {
            // lastSha est déjà le commit le plus récent → rien à faire
            log('✅ Déjà à jour.');
            return;
        }

        if (idx === -1) {
            // lastSha introuvable dans la fenêtre de 50 commits.
            // Ça arrive si Discord a poussé >50 builds depuis le dernier run,
            // ou si le workflow a été inactif longtemps.
            // → On prend tous les commits disponibles dans la fenêtre.
            log(`⚠️  lastSha introuvable dans les ${allCommits.length} commits récupérés.`);
            log(`   Probable gap > ${allCommits.length} commits. On traite toute la fenêtre.`);
            toProcess = [...allCommits].reverse();
        } else {
            // Cas normal : on prend tout ce qui est après lastSha
            toProcess = allCommits.slice(0, idx).reverse();
        }
    }

    log(`${toProcess.length} commit(s) à traiter.`);
    const newEntries = [];

    for (const commit of toProcess) {
        const parsed = parseCommit(commit.commit.message);
        log(`\n── Commit ${commit.sha.slice(0,7)} · Build #${parsed.buildNumber}`);
        const allSections = Object.entries(parsed.files).map(([k,v])=>`${k}:${v.length}`).join(' ');
        log(`   Sections: ${allSections || '⚠️ AUCUNE — vérifier format commit'}`);
        if (!allSections) {
            // Log les 5 premières lignes du message pour debug
            const preview = commit.commit.message.replace(/\r/g,'').split('\n').slice(0,8).join(' | ');
            log(`   Message: ${preview}`);
        }

        const allFiles = Object.values(parsed.files).flat();
        const entry = {
            sha: commit.sha, date: commit.commit.author.date,
            buildNumber: parsed.buildNumber, files: parsed.files,
            savedFiles: [], failedFiles: [],
        };

        for (const filename of allFiles) {
            const dest = path.join(ASSETS_DIR, filename);
            if (fs.existsSync(dest)) {
                log(`  ✓ Déjà présent: ${filename}`);
                entry.savedFiles.push(filename);
                continue;
            }
            try {
                log(`  ⬇ ${filename}`);
                const content = await downloadDiscordFile(filename);
                fs.writeFileSync(dest, content, 'utf8');
                entry.savedFiles.push(filename);
                state.knownFiles[filename] = commit.sha;
                await new Promise(r => setTimeout(r, 400)); // anti-spam
            } catch(err) {
                log(`  ✗ ERREUR ${filename}: ${err.message}`);
                entry.failedFiles.push({ filename, error: err.message });
            }
        }

        newEntries.push(entry);
        state.lastSha = commit.sha;
    }

    // 2. Met à jour le changelog.json (utilisé par le site web)
    const existing = loadJSON(CHANGELOG_FILE, []);
    const merged   = [...newEntries, ...existing].slice(0, 300);
    fs.writeFileSync(CHANGELOG_FILE, JSON.stringify(merged, null, 2));
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

    log(`\n✅ Terminé!`);
    newEntries.forEach(e => log(`  Build #${e.buildNumber}: ${e.savedFiles.length} sauvés, ${e.failedFiles.length} échecs`));
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
