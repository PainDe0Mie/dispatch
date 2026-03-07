import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DISCORD_CANARY = 'https://canary.discord.com';
const DATAMINING_REPO = 'Discord-Datamining/Discord-Datamining';
const ASSETS_DIR = path.join(ROOT, 'assets');
const STATE_FILE = path.join(ROOT, 'state.json');
const CHANGELOG_FILE = path.join(ROOT, 'static/changelog.json');

const log = (m) => console.log(`[${new Date().toISOString().split('T')[1].split('.')[0]}] ${m}`);

function loadJSON(file, def) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return def; }
}

async function downloadDiscordFile(filename) {
    const res = await fetch(`${DISCORD_CANARY}/assets/${filename}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

async function run() {
    if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

    const state = loadJSON(STATE_FILE, { lastSha: null, knownFiles: {} });
    const existingChangelog = loadJSON(CHANGELOG_FILE, []);
    
    // On crée un Set des builds déjà enregistrés pour un check ultra-rapide
    const processedBuilds = new Set(existingChangelog.map(e => String(e.buildNumber || e.build)));

    log(`Vérification des builds sur ${DATAMINING_REPO}...`);
    const res = await fetch(`https://api.github.com/repos/${DATAMINING_REPO}/commits?per_page=15`, {
        headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}` }
    });
    
    if (!res.ok) {
        log(`Erreur API GitHub: ${res.status}`);
        return;
    }

    const commits = await res.json();
    const newEntries = [];

    // On parcourt du plus vieux au plus récent pour garder l'ordre chronologique
    for (const commit of commits.reverse()) {
        const msg = commit.commit.message;
        const buildMatch = msg.match(/Build (\d+)/);
        
        if (!buildMatch) continue;
        const buildNumber = buildMatch[1];

        if (processedBuilds.has(buildNumber)) {
            continue; // On connaît déjà ce build, on passe au suivant
        }

        log(`✨ NOUVEAU BUILD TROUVÉ : ${buildNumber}`);

        // Extraction des fichiers JS/CSS
        const files = [...msg.matchAll(/- ([a-f0-9]+\.(js|css))/g)].map(m => m[1]);
        const entry = {
            build: buildNumber,
            sha: commit.sha,
            date: commit.commit.author.date,
            message: msg,
            savedFiles: []
        };

        for (const filename of files) {
            const dest = path.join(ASSETS_DIR, filename);
            if (fs.existsSync(dest)) {
                entry.savedFiles.push(filename);
                continue;
            }
            try {
                log(`  ⬇  ${filename}`);
                const content = await downloadDiscordFile(filename);
                fs.writeFileSync(dest, content, 'utf8');
                entry.savedFiles.push(filename);
                await new Promise(r => setTimeout(r, 300)); // Petit délai anti-spam
            } catch (err) {
                log(`  ❌ Erreur ${filename}: ${err.message}`);
            }
        }

        newEntries.push(entry);
    }

    if (newEntries.length > 0) {
        const updatedChangelog = [...newEntries.reverse(), ...existingChangelog].slice(0, 200);
        fs.writeFileSync(CHANGELOG_FILE, JSON.stringify(updatedChangelog, null, 2));
        log(`✅ Mise à jour terminée : ${newEntries.length} nouveaux builds ajoutés.`);
    } else {
        log("☕ Aucun nouveau build à ajouter.");
    }

    // On met à jour le dernier SHA pour la forme
    state.lastSha = commits[0].sha;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

run().catch(console.error);
