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
const CHANGELOG_FILE  = path.join(ROOT, 'static/changelog.json');

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://canary.discord.com/',
};

const log = (m) => console.log(`[${new Date().toISOString().split('T')[1].split('.')[0]}] ${m}`);

function loadJSON(file, def) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return def; }
}

async function downloadDiscordFile(filename) {
    const res = await fetch(`${DISCORD_CANARY}/assets/${filename}`, { headers: BROWSER_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

async function run() {
    if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

    const state = loadJSON(STATE_FILE, { lastSha: null, knownFiles: {} });
    const existingChangelog = loadJSON(CHANGELOG_FILE, []);
    
    // On liste les builds qu'on a déjà pour ne pas créer de doublons
    const processedBuilds = new Set(existingChangelog.map(e => String(e.buildNumber)));

    log(`Vérification des builds sur ${DATAMINING_REPO}...`);
    const res = await fetch(`https://api.github.com/repos/${DATAMINING_REPO}/commits?per_page=15`, {
        headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` }
    });
    
    if (!res.ok) throw new Error(`GitHub API Error: ${res.status}`);
    const commits = await res.json();

    const newEntries = [];

    // On parcourt les commits du plus vieux au plus récent
    for (const commit of commits.reverse()) {
        const msg = commit.commit.message;
        const buildMatch = msg.match(/Build (\d+)/);
        
        if (!buildMatch) continue;
        const buildNumber = buildMatch[1];

        // SÉCURITÉ : On ne traite que si le build n'est pas déjà dans le changelog
        if (processedBuilds.has(buildNumber)) continue;

        log(`✨ NOUVEAU : Build ${buildNumber}`);

        const allFiles = [...msg.matchAll(/- ([a-f0-9]+\.(js|css))/g)].map(m => m[1]);
        
        // ON GARDE TA STRUCTURE EXACTE ICI
        const entry = {
            buildNumber,
            sha: commit.sha,
            date: commit.commit.author.date,
            message: msg,
            files: { js: [], css: [] }, // <--- C'est ça qui manquait !
            savedFiles: [],
            failedFiles: [],
        };

        for (const filename of allFiles) {
            const dest = path.join(ASSETS_DIR, filename);
            const ext = filename.endsWith('.js') ? 'js' : 'css';

            if (fs.existsSync(dest)) {
                entry.files[ext].push(filename);
                entry.savedFiles.push(filename);
                continue;
            }

            try {
                log(`  ⬇ ${filename}`);
                const content = await downloadDiscordFile(filename);
                fs.writeFileSync(dest, content, 'utf8');
                
                entry.files[ext].push(filename);
                entry.savedFiles.push(filename);
                
                await new Promise(r => setTimeout(r, 400));
            } catch(err) {
                log(`  ✗ ERREUR ${filename}: ${err.message}`);
                entry.failedFiles.push({ filename, error: err.message });
            }
        }

        newEntries.push(entry);
    }

    if (newEntries.length > 0) {
        // On remet les nouveaux au début de la liste
        const merged = [...newEntries.reverse(), ...existingChangelog].slice(0, 300);
        fs.writeFileSync(CHANGELOG_FILE, JSON.stringify(merged, null, 2));
        
        state.lastSha = commits[0].sha;
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        log(`✅ Terminé : ${newEntries.length} builds ajoutés.`);
    } else {
        log("☕ Tout est à jour.");
    }
}

run().catch(err => {
    log(`FATAL ERROR: ${err.message}`);
    process.exit(1);
});
