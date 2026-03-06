// ═══════════════════════════════════════════════════════════════════════════════
// Discord Dataminer — Diff Tracker
// Proxy: https://dispatch.lapinou5414.workers.dev
// ═══════════════════════════════════════════════════════════════════════════════

const PROXY_URL   = 'https://dispatch.lapinou5414.workers.dev';
const DISCORD_CDN = 'https://canary.discord.com/assets/';
const REPO        = 'Discord-Datamining/Discord-Datamining';
const API_URL     = `https://api.github.com/repos/${REPO}/commits`;

const SIZE_FULL = 400_000;   // < 400 KB → beautify + diffLines (meilleure qualité)
const SIZE_FAST = 4_000_000; // < 4 MB  → smart split
// > 4 MB → aperçu 300 Ko

let globalCommits = [];
let activeFilter  = 'all';
let diffCache     = new Map();

// ── FETCH ─────────────────────────────────────────────────────────────────────
async function githubGet(url) {
    const res = await fetch(url, {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
        signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
        if (res.headers.get('X-RateLimit-Remaining') === '0')
            throw new Error('Rate limit GitHub (60/h) — réessaie dans quelques minutes.');
        throw new Error(`GitHub API HTTP ${res.status}`);
    }
    return res.json();
}

async function fetchDiscord(filename) {
    const target = `${DISCORD_CDN}${filename}`;
    const url    = `${PROXY_URL}?url=${encodeURIComponent(target)}`;
    const res    = await fetch(url, { signal: AbortSignal.timeout(40000) });
    if (!res.ok) throw new Error(`Proxy HTTP ${res.status} pour ${filename}`);
    return res.text();
}

// ── PARSE COMMIT ──────────────────────────────────────────────────────────────
function parseCommitMessage(message) {
    const lines  = message.split('\n').map(l => l.trim());
    const result = { buildNumber: null, branches: {}, files: {} };
    const m      = lines[0].match(/(\d{5,})/);
    result.buildNumber = m ? m[1] : lines[0].replace(/-/g,'|').slice(0,40);

    const SECTIONS = { 'Scripts':'js','Stylesheet':'css','Stylesheets':'css',
        'Workers':'worker','Assets':'asset','Manifests':'manifest','Other':'other' };
    for (const line of lines) {
        const bm = line.match(/^(Stable|PTB|Canary|Alpha):\s*(\d+)/i);
        if (bm) result.branches[bm[1]] = bm[2];
    }
    let section = null;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i]; if (!line) continue;
        const sk = Object.keys(SECTIONS).find(k => line === k+':');
        if (sk) { section = SECTIONS[sk]; result.files[section] ??= []; continue; }
        if (line.startsWith('- ') && section) result.files[section].push(line.slice(2).trim());
    }
    return result;
}

// ── FIND PREVIOUS ─────────────────────────────────────────────────────────────
function findPrevious(baseName, ext, currentIndex) {
    for (let i = currentIndex + 1; i < globalCommits.length; i++) {
        for (const line of globalCommits[i].commit.message.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('- ')) continue;
            const fname = t.slice(2).trim();
            const p = fname.split('.');
            if (p[0] === baseName && p[p.length-1] === ext) return fname;
        }
    }
    return null;
}

// ── SMART SPLIT ───────────────────────────────────────────────────────────────
function smartSplit(code) {
    return code
        .replace(/;(?!\s*\n)/g,';\n')
        .replace(/\{/g,'{\n').replace(/\}/g,'\n}\n')
        .replace(/,(?=\s*["'{[`])/g,',\n')
        .split('\n').map(l=>l.trim()).filter(l=>l.length>0);
}
const yield2 = () => new Promise(r => setTimeout(r, 0));

// ── NOISE DETECTION (smart) ───────────────────────────────────────────────────
// Un "bruit" = deux lignes qui sont IDENTIQUES une fois qu'on remplace
// les identifiants 1-2 chars, ET où les seuls tokens différents sont
// des identifiants courts swappés entre eux (jamais de vrais mots/strings).
function diffTokens(a, b) {
    // tokenise grossièrement
    const tok = s => s.match(/[a-zA-Z_$][a-zA-Z0-9_$]*|[0-9]+|"[^"]*"|'[^']*'|`[^`]*`|[^\s]/g) || [];
    const ta = tok(a), tb = tok(b);
    if (ta.length !== tb.length) return null; // structures différentes → pas noisy
    const diffs = [];
    for (let i = 0; i < ta.length; i++) {
        if (ta[i] !== tb[i]) diffs.push({ from: ta[i], to: tb[i] });
    }
    return diffs;
}

function isNoisyPair(a, b) {
    if (Math.abs(a.length - b.length) > 3) return false;
    const diffs = diffTokens(a, b);
    if (!diffs) return false;
    if (diffs.length === 0) return true; // identiques
    if (diffs.length > 4) return false;  // trop de différences → vrai changement

    // Toutes les différences doivent être des swaps d'identifiants courts (1-2 chars)
    return diffs.every(d =>
        /^[a-zA-Z_$]{1,2}$/.test(d.from) &&
        /^[a-zA-Z_$]{1,2}$/.test(d.to)
    );
}

function buildChanges(diff) {
    // Extraire toutes les lignes ajoutées/supprimées
    const raw = [];
    diff.forEach(part => {
        if (!part.added && !part.removed) return;
        const type  = part.added ? 'add' : 'rem';
        const lines = Array.isArray(part.value) ? part.value : part.value.split('\n');
        lines.forEach(line => { if (line.trim()) raw.push({ type, line }); });
    });

    // Apparier les blocs rem/add consécutifs pour détecter le bruit
    const out = []; let i = 0;
    while (i < raw.length) {
        if (raw[i].type === 'rem' && i+1 < raw.length && raw[i+1].type === 'add') {
            const noisy = isNoisyPair(raw[i].line, raw[i+1].line);
            out.push({ ...raw[i], noisy });
            out.push({ ...raw[i+1], noisy });
            i += 2;
        } else {
            out.push({ ...raw[i], noisy: false });
            i++;
        }
    }
    return out;
}

// ── COMPUTE DIFF ─────────────────────────────────────────────────────────────
async function computeDiff(oldRaw, newRaw, onProgress) {
    const total = oldRaw.length + newRaw.length;
    if (total < SIZE_FULL * 2) {
        onProgress('✨ Beautification…'); await yield2();
        const oc = js_beautify(oldRaw, { indent_size: 2 }); await yield2();
        const nc = js_beautify(newRaw, { indent_size: 2 });
        onProgress('🔍 Calcul du diff…'); await yield2();
        return { diff: Diff.diffLines(oc, nc), mode: 'full' };
    } else if (total < SIZE_FAST * 2) {
        onProgress('⚡ Smart split (fichier volumineux)…'); await yield2();
        const ol = smartSplit(oldRaw), nl = smartSplit(newRaw);
        onProgress('🔍 Calcul du diff…'); await yield2();
        return { diff: Diff.diffArrays(ol, nl), mode: 'fast' };
    } else {
        onProgress('⚠️ Aperçu 300 Ko (fichier énorme)…'); await yield2();
        const ol = smartSplit(oldRaw.slice(0, 300_000));
        const nl = smartSplit(newRaw.slice(0, 300_000));
        onProgress('🔍 Calcul diff aperçu…'); await yield2();
        return { diff: Diff.diffArrays(ol, nl), mode: 'preview', truncated: true };
    }
}

// ── RENDER DIFF ───────────────────────────────────────────────────────────────
const BATCH = 500;

function renderDiffFromChanges(container, allChanges, mode, showNoise) {
    const changes    = showNoise ? allChanges : allChanges.filter(c => !c.noisy);
    const noisyCount = allChanges.filter(c => c.noisy).length;
    const realCount  = allChanges.filter(c => !c.noisy).length;
    container.dataset.showNoise = showNoise;

    if (changes.length === 0) {
        container.innerHTML = `
            <div class="diff-status status-empty">
                ✓ Aucun vrai changement de logique.
                ${noisyCount > 0 ? `<br><span style="opacity:0.6;font-size:0.8rem">${noisyCount} lignes de bruit (renommage de variables par le minifieur) filtrées.</span>
                <br><button class="btn-load-more" style="margin-top:10px" onclick="toggleNoise('${container.id}')">Voir le bruit quand même</button>` : ''}
            </div>`;
        return;
    }

    const added   = changes.filter(c => c.type === 'add').length;
    const removed = changes.filter(c => c.type === 'rem').length;
    const modeMap = { full:['full','Full ✨'], fast:['fast','Fast ⚡'], preview:['preview','Aperçu ⚠️'] };
    const [cls, label] = modeMap[mode] || ['fast','Fast'];

    const noiseBtn = noisyCount > 0
        ? `<button class="noise-toggle" onclick="toggleNoise('${container.id}')">
               ${showNoise ? '🙈 Masquer bruit' : `👁 +${noisyCount} bruit`}
           </button>` : '';

    const copyBtn = `<button class="noise-toggle" onclick="copyDiff('${container.id}')">📋 Copier</button>`;

    let html = `
        <div class="diff-header-bar">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <span class="diff-title">${realCount} vrai${realCount>1?'s':''} changement${realCount>1?'s':''}</span>
                <span class="diff-mode-badge mode-${cls}">${label}</span>
            </div>
            <div class="diff-stats">
                <span class="diff-stat-add">+${added}</span>
                <span class="diff-stat-rem">−${removed}</span>
                ${noiseBtn}
                ${copyBtn}
            </div>
        </div>
        <div class="diff-body" id="${container.id}-body">`;

    changes.slice(0, BATCH).forEach(({ type, line, noisy }) => {
        const esc = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        html += `<div class="diff-line diff-line-${type==='add'?'add':'rem'}${noisy?' diff-noisy':''}">${esc}</div>`;
    });
    html += `</div>`;
    container.innerHTML = html;
    if (changes.length > BATCH) appendLoadMore(container, changes, BATCH);
}

window.copyDiff = function(cid) {
    const body = document.getElementById(`${cid}-body`);
    if (!body) return;
    const text = [...body.querySelectorAll('.diff-line')].map(el => {
        const prefix = el.classList.contains('diff-line-add') ? '+ ' : '- ';
        return prefix + el.textContent;
    }).join('\n');
    navigator.clipboard.writeText(text).then(() => {
        const btn = body.closest('.diff-container').querySelector('.noise-toggle:last-child');
        if (btn) { btn.textContent = '✓ Copié !'; setTimeout(() => btn.textContent = '📋 Copier', 2000); }
    });
};

function appendLoadMore(container, changes, nextIdx) {
    document.getElementById(`lm-${container.id}`)?.remove();
    if (nextIdx >= changes.length) return;
    const rem = changes.length - nextIdx;
    const div = document.createElement('div');
    div.id = `lm-${container.id}`; div.className = 'diff-load-more';
    div.innerHTML = `<button class="btn-load-more" onclick="loadMore('${container.id}',${nextIdx})">
        Afficher ${Math.min(BATCH, rem)} de plus (${rem} restantes)
    </button>`;
    container.appendChild(div);
}

window.loadMore = function(cid, from) {
    const c = document.getElementById(cid); if (!c) return;
    const showNoise = c.dataset.showNoise === 'true';
    const all = JSON.parse(c.dataset.diffAll || '[]');
    const changes = showNoise ? all : all.filter(x => !x.noisy);
    const body = document.getElementById(`${cid}-body`); if (!body) return;
    changes.slice(from, from+BATCH).forEach(({ type, line, noisy }) => {
        const el = document.createElement('div');
        el.className = `diff-line diff-line-${type==='add'?'add':'rem'}${noisy?' diff-noisy':''}`;
        el.textContent = line; body.appendChild(el);
    });
    appendLoadMore(c, changes, from+BATCH);
};

window.toggleNoise = function(cid) {
    const c = document.getElementById(cid); if (!c) return;
    renderDiffFromChanges(c, JSON.parse(c.dataset.diffAll||'[]'), c.dataset.diffMode||'fast', c.dataset.showNoise!=='true');
};

// ── SHOW DIFF ─────────────────────────────────────────────────────────────────
window.showDiff = async function(baseName, currentFile, fileExt, currentIndex, currentSha, containerId) {
    const container = document.getElementById(containerId); if (!container) return;

    if (container.dataset.visible === 'true') {
        container.innerHTML=''; container.dataset.visible='false'; container.style.display='none'; return;
    }
    container.style.display='block'; container.dataset.visible='true';

    const cacheKey = `${currentSha}::${currentFile}`;
    if (diffCache.has(cacheKey)) {
        const { allChanges, mode } = diffCache.get(cacheKey);
        container.dataset.diffAll  = JSON.stringify(allChanges);
        container.dataset.diffMode = mode;
        renderDiffFromChanges(container, allChanges, mode, false);
        return;
    }

    const prevFile = findPrevious(baseName, fileExt, currentIndex);
    if (!prevFile) {
        container.innerHTML = `<div class="diff-status status-error">
            ℹ️ Version précédente introuvable dans les ${globalCommits.length} commits chargés.<br>
            <span style="font-size:0.75rem;opacity:0.6">Nouveau fichier, ou charge plus de commits.</span>
        </div>`; return;
    }

    container.innerHTML = `
        <div class="diff-status status-loading">
            <div id="${containerId}-msg">⏳ Téléchargement…</div>
            <div class="diff-file-label">${prevFile} → ${currentFile}</div>
            <div class="progress-bar-wrap"><div class="progress-bar"></div></div>
        </div>`;
    const setMsg = msg => { const el = document.getElementById(`${containerId}-msg`); if (el) el.textContent = msg; };

    try {
        setMsg('⏳ Téléchargement des deux versions via proxy…');
        const [oldRaw, newRaw] = await Promise.all([
            fetchDiscord(prevFile),
            fetchDiscord(currentFile),
        ]);

        const sizeMB = ((oldRaw.length + newRaw.length) / 1024 / 1024).toFixed(1);
        setMsg(`⚙️ Analyse de ${sizeMB} Mo…`);

        const { diff, mode, truncated } = await computeDiff(oldRaw, newRaw, setMsg);
        const allChanges = buildChanges(diff);
        diffCache.set(cacheKey, { allChanges, mode });

        container.innerHTML = '';
        if (truncated) container.insertAdjacentHTML('beforeend',
            `<div class="diff-truncated-warning">⚠ Aperçu : seuls les 300 premiers Ko ont été analysés (fichier trop volumineux).</div>`);

        container.dataset.diffAll  = JSON.stringify(allChanges);
        container.dataset.diffMode = mode;
        renderDiffFromChanges(container, allChanges, mode, false);

    } catch (err) {
        container.innerHTML = `<div class="diff-status status-error">❌ ${err.message}</div>`;
    }
};

window.toggleDiff = function(baseName, fileName, fileExt, index, sha, diffId) {
    showDiff(baseName, fileName, fileExt, index, sha, diffId);
};

// ── COMMIT CARD ───────────────────────────────────────────────────────────────
function createCommitCard(commitData, index) {
    const parsed = parseCommitMessage(commitData.commit.message);
    const sha    = commitData.sha;
    const date   = new Date(commitData.commit.author.date).toLocaleString('fr-FR',
        { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });

    const jsFiles    = parsed.files['js']||[];
    const cssFiles   = parsed.files['css']||[];
    const otherFiles = [
        ...(parsed.files['worker']||[]), ...(parsed.files['asset']||[]),
        ...(parsed.files['manifest']||[]), ...(parsed.files['other']||[])
    ];
    const allFiles = [...jsFiles, ...cssFiles, ...otherFiles];

    let badges = '';
    if (jsFiles.length)    badges += `<span class="count-badge count-js">${jsFiles.length} JS</span>`;
    if (cssFiles.length)   badges += `<span class="count-badge count-css">${cssFiles.length} CSS</span>`;
    if (otherFiles.length) badges += `<span class="count-badge count-other">${otherFiles.length} autres</span>`;

    const branchStr = Object.entries(parsed.branches).map(([b,v]) => `${b}: ${v}`).join(' · ');

    // Temps relatif
    function relTime(dateStr) {
        const diff = Date.now() - new Date(dateStr);
        const m = Math.floor(diff/60000);
        if (m < 1)  return 'à l\'instant';
        if (m < 60) return `il y a ${m} min`;
        const h = Math.floor(m/60);
        if (h < 24) return `il y a ${h}h`;
        return `il y a ${Math.floor(h/24)}j`;
    }

    function fileSection(files, type, dotClass, label) {
        if (!files.length) return '';
        let html = `<div class="section-label">${label} <span class="section-count">${files.length}</span></div>`;
        files.forEach(fileName => {
            const parts    = fileName.split('.');
            const baseName = parts[0];
            const fileExt  = parts[parts.length-1];
            const hash     = parts.length > 2 ? parts[1] : '';
            const diffId   = `diff-${sha}-${fileName.replace(/[^a-zA-Z0-9]/g,'_')}`;
            const isCode   = type === 'js' || type === 'css';

            html += `
                <div class="file-row">
                    <div class="file-type-dot ${dotClass}"></div>
                    <div class="file-info">
                        <span class="file-basename">${baseName}</span>
                        ${hash ? `<span class="file-hash">.${hash}</span>` : ''}
                        <span class="file-ext">.${fileExt}</span>
                    </div>
                    <div class="file-actions">
                        ${isCode ? `<button class="btn-diff" id="btn-${diffId}"
                            onclick="handleDiffBtn('${baseName}','${fileName}','${fileExt}',${index},'${sha}','${diffId}',this)">
                            ↕ Diff
                        </button>` : ''}
                        <a class="btn-icon-link" href="${commitData.html_url}" target="_blank" title="Voir sur GitHub">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.73.084-.73 1.205.085 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12"/></svg>
                        </a>
                        <a class="btn-icon-link" href="${DISCORD_CDN}${fileName}" target="_blank" title="Voir le fichier brut">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                        </a>
                    </div>
                </div>
                <div class="diff-container" id="${diffId}" style="display:none;"></div>`;
        });
        return html;
    }

    const allHTML = fileSection(jsFiles,'js','dot-js','JavaScript')
                  + fileSection(cssFiles,'css','dot-css','Stylesheet')
                  + fileSection(otherFiles,'other','dot-other','Autres');

    const card = document.createElement('div');
    card.className = 'update-card';
    card.dataset.sha      = sha;
    card.dataset.files    = allFiles.join(',');
    card.dataset.jsHTML   = fileSection(jsFiles,'js','dot-js','JavaScript');
    card.dataset.cssHTML  = fileSection(cssFiles,'css','dot-css','Stylesheet');
    card.dataset.otherHTML= fileSection(otherFiles,'other','dot-other','Autres');
    card.dataset.allHTML  = allHTML;

    card.innerHTML = `
        <div class="card-header" onclick="toggleCard('${sha}')">
            <div class="card-header-left">
                <span class="build-number">#${parsed.buildNumber}</span>
                <div class="card-meta">
                    <span class="card-title">${allFiles.length} fichier${allFiles.length>1?'s':''} modifié${allFiles.length>1?'s':''}</span>
                    <span class="card-date" title="${date}">${relTime(commitData.commit.author.date)} · ${date}</span>
                </div>
            </div>
            <div class="card-header-right">
                <div class="file-counts">${badges}</div>
                ${branchStr ? `<span class="branch-str">${branchStr}</span>` : ''}
                <svg class="toggle-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="9 18 15 12 9 6"/>
                </svg>
            </div>
        </div>
        <div class="files-panel" id="panel-${sha}">
            <div class="panel-tabs" id="tabs-${sha}">
                <button class="panel-tab active" onclick="switchTab('${sha}','all',this)">Tous (${allFiles.length})</button>
                ${jsFiles.length    ? `<button class="panel-tab" onclick="switchTab('${sha}','js',this)">JS (${jsFiles.length})</button>` : ''}
                ${cssFiles.length   ? `<button class="panel-tab" onclick="switchTab('${sha}','css',this)">CSS (${cssFiles.length})</button>` : ''}
                ${otherFiles.length ? `<button class="panel-tab" onclick="switchTab('${sha}','other',this)">Autres (${otherFiles.length})</button>` : ''}
            </div>
            <div class="panel-content" id="content-${sha}">
                ${allFiles.length ? allHTML : '<div class="diff-status status-empty">Aucun fichier modifié.</div>'}
            </div>
        </div>`;
    return card;
}

window.handleDiffBtn = function(baseName, fileName, fileExt, index, sha, diffId, btn) {
    const container = document.getElementById(diffId);
    if (container && container.dataset.visible === 'true') {
        btn.textContent = '↕ Diff';
        btn.classList.remove('active-diff');
    } else {
        btn.textContent = '✕ Fermer';
        btn.classList.add('active-diff');
    }
    showDiff(baseName, fileName, fileExt, index, sha, diffId);
};

window.toggleCard = function(sha) {
    const panel = document.getElementById(`panel-${sha}`);
    const arrow = panel.closest('.update-card').querySelector('.toggle-arrow');
    const open  = panel.classList.toggle('open');
    arrow.classList.toggle('open', open);
};

window.switchTab = function(sha, type, tabEl) {
    const card = document.getElementById(`panel-${sha}`).closest('.update-card');
    document.getElementById(`tabs-${sha}`).querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    tabEl.classList.add('active');
    document.getElementById(`content-${sha}`).innerHTML =
        ({ all:card.dataset.allHTML, js:card.dataset.jsHTML, css:card.dataset.cssHTML, other:card.dataset.otherHTML })[type] || '';
};

window.setFilter = function(type, btn) {
    activeFilter = type;
    document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filterCommits();
};

window.filterCommits = function() {
    const query = document.getElementById('search-input').value.toLowerCase().trim();
    let visible = 0;
    document.querySelectorAll('.update-card').forEach(card => {
        const text  = (card.dataset.sha + ' ' + card.dataset.files).toLowerCase();
        const f     = card.dataset.files;
        const matchQ = !query || text.includes(query);
        const matchT = activeFilter==='all'
            || (activeFilter==='js'    && f.includes('.js'))
            || (activeFilter==='css'   && f.includes('.css'))
            || (activeFilter==='other' && !f.includes('.js') && !f.includes('.css'));
        const show = matchQ && matchT;
        card.style.display = show ? '' : 'none';
        if (show) visible++;
    });
    let nr = document.getElementById('no-results');
    if (!visible && !nr) {
        nr = document.createElement('div'); nr.id='no-results'; nr.className='no-results';
        nr.textContent = 'Aucun résultat.';
        document.getElementById('updates-list').appendChild(nr);
    } else if (visible && nr) nr.remove();
};

// ── FETCH COMMITS ─────────────────────────────────────────────────────────────
async function fetchUpdates() {
    const container   = document.getElementById('updates-list');
    const statusDot   = document.getElementById('status-dot');
    const lastUpdated = document.getElementById('last-updated');
    const btnRefresh  = document.getElementById('btn-refresh');
    btnRefresh.classList.add('loading'); statusDot.className = 'status-dot';

    try {
        const data = await githubGet(`${API_URL}?per_page=25`);
        globalCommits = data; diffCache.clear();
        container.innerHTML = '';
        let totalFiles = 0;
        globalCommits.forEach((c, i) => {
            const p = parseCommitMessage(c.commit.message);
            totalFiles += Object.values(p.files).flat().length;
            container.appendChild(createCommitCard(c, i));
        });
        document.getElementById('stats-bar').style.display = 'flex';
        document.getElementById('stat-commits').textContent = `${globalCommits.length} commits`;
        document.getElementById('stat-files').textContent   = `${totalFiles} fichiers modifiés`;
        statusDot.className = 'status-dot online';
        lastUpdated.textContent = 'Mis à jour ' + new Date().toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
    } catch(err) {
        statusDot.className = 'status-dot error';
        container.innerHTML = `<div class="diff-status status-error" style="padding:60px 20px">❌ ${err.message}</div>`;
    } finally {
        btnRefresh.classList.remove('loading');
    }
}

fetchUpdates();
setInterval(fetchUpdates, 5*60*1000);