// ═══════════════════════════════════════════════════════════════════════════════
// Dispatch — app.js  (v3 — 7 new features)
// ═══════════════════════════════════════════════════════════════════════════════

const MY_REPO     = 'PainDe0Mie/dispatch';
const RAW         = `https://raw.githubusercontent.com/${MY_REPO}/main`;
const DISCORD_CDN = 'https://canary.discord.com/assets/';

const SIZE_FULL = 400_000;
const SIZE_FAST = 4_000_000;

let changelog      = [];
let activeFilter   = 'all';
let activePage     = 'builds';
let compactMode    = false;
let diffCache      = new Map();
let _searchCache   = null;  // { webJs, buildNumber, code } — web.js gardé en mémoire
let _featFilter    = 'all';
let _featSearch    = '';
let _focusedCard   = -1;   // keyboard nav index

// ── FETCH ─────────────────────────────────────────────────────────────────────
async function getChangelog() {
    const res = await fetch(`${RAW}/static/changelog.json?_=${Date.now()}`);
    if (!res.ok) throw new Error(`changelog.json introuvable (HTTP ${res.status})`);
    return res.json();
}
async function getRawFile(filename) {
    const res = await fetch(`${RAW}/assets/${filename}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${filename} non disponible.`);
    return res.text();
}

// ── PERMALIENS ────────────────────────────────────────────────────────────────
function parseHash() {
    const h = location.hash.slice(1);
    const params = {};
    h.split('&').forEach(p => { const [k,v] = p.split('='); if(k) params[k] = decodeURIComponent(v||''); });
    return params;
}
function setHash(key, value) {
    const params = parseHash();
    if (value == null) delete params[key];
    else params[key] = value;
    const str = Object.entries(params).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join('&');
    history.replaceState(null, '', str ? '#' + str : location.pathname);
}
function applyPermalink() {
    const p = parseHash();
    if (p.build) {
        const entry = changelog.find(e => String(e.buildNumber) === p.build || e.sha.startsWith(p.build));
        if (entry) {
            const panel = document.getElementById(`panel-${entry.sha}`);
            if (panel && !panel.classList.contains('open')) {
                toggleCard(entry.sha);
                setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
            }
        }
    }
    if (p.page) {
        const btn = document.querySelector(`.page-tab[data-page="${p.page}"]`);
        if (btn) switchPage(p.page, btn);
    }
    if (p.search) {
        const page = document.getElementById('page-search');
        if (p.page === 'search') {
            document.getElementById('code-search-input').value = p.search;
            runCodeSearch();
        }
    }
}

// ── PAGE NAVIGATION ───────────────────────────────────────────────────────────
window.switchPage = function(page, btn) {
    activePage = page;
    document.querySelectorAll('.page-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ['builds','assets','features','search'].forEach(p => {
        const el = document.getElementById(`page-${p}`);
        if (el) el.style.display = p === page ? '' : 'none';
    });
    document.getElementById('builds-filters').style.display = page === 'builds' ? '' : 'none';
    setHash('page', page === 'builds' ? null : page);
    if (page === 'assets'   && !document.getElementById('page-assets').dataset.loaded)   renderAssetsPage();
    if (page === 'features' && !document.getElementById('page-features').dataset.loaded) renderFeaturesPage();
};

// ── GRAPH ─────────────────────────────────────────────────────────────────────
function renderGraph(data) {
    const el = document.getElementById('activity-graph');
    if (!el) return;
    const days = {}, labels = {};
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const key = d.toISOString().split('T')[0];
        days[key] = 0;
        labels[key] = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' });
    }
    data.forEach(e => { const k = new Date(e.date).toISOString().split('T')[0]; if (k in days) days[k]++; });
    const max = Math.max(...Object.values(days), 1);
    const INNER_H = 52;
    el.innerHTML = Object.entries(days).map(([date, count]) => {
        const px  = count === 0 ? 3 : Math.max(6, Math.round((count / max) * INNER_H));
        const pct = count === 0 ? 0.18 : 0.35 + (count / max) * 0.65;
        const isToday = date === new Date().toISOString().split('T')[0];
        return `<div class="graph-col">
            <div class="graph-bar-wrap">
                <div class="graph-bar${isToday?' graph-bar-today':''}" style="height:${px}px;opacity:${pct}" data-tip="${count} build${count>1?'s':''} · ${labels[date]}"></div>
            </div>
            <div class="graph-label${isToday?' graph-label-today':''}">${labels[date]}</div>
        </div>`;
    }).join('');
}

// ── SMART SPLIT & DIFF ENGINE ─────────────────────────────────────────────────
function smartSplit(code) {
    return code.replace(/;(?!\s*\n)/g,';\n').replace(/\{/g,'{\n').replace(/\}/g,'\n}\n')
        .replace(/,(?=\s*["'{[`])/g,',\n').split('\n').map(l=>l.trim()).filter(Boolean);
}
const yield2 = () => new Promise(r => setTimeout(r, 0));

function isNoisyPair(a, b) {
    if (Math.abs(a.length - b.length) > 3) return false;
    const tok = s => s.match(/[a-zA-Z_$][a-zA-Z0-9_$]*|[0-9]+|"[^"]*"|'[^']*'|[^\s]/g) || [];
    const ta = tok(a), tb = tok(b);
    if (ta.length !== tb.length) return false;
    const diffs = ta.map((t,i) => t !== tb[i] ? {a:t,b:tb[i]} : null).filter(Boolean);
    if (diffs.length === 0) return true;
    if (diffs.length > 4)   return false;
    return diffs.every(d => /^[a-zA-Z_$]{1,2}$/.test(d.a) && /^[a-zA-Z_$]{1,2}$/.test(d.b));
}
function buildChanges(diff) {
    const raw = [];
    diff.forEach(p => {
        if (!p.added && !p.removed) return;
        const type = p.added ? 'add' : 'rem';
        (Array.isArray(p.value) ? p.value : p.value.split('\n')).forEach(l => { if (l.trim()) raw.push({type, line:l}); });
    });
    const out = []; let i = 0;
    while (i < raw.length) {
        if (raw[i].type==='rem' && i+1<raw.length && raw[i+1].type==='add') {
            const noisy = isNoisyPair(raw[i].line, raw[i+1].line);
            out.push({...raw[i],noisy}); out.push({...raw[i+1],noisy}); i+=2;
        } else { out.push({...raw[i],noisy:false}); i++; }
    }
    return out;
}
async function computeDiff(oldRaw, newRaw, onProgress) {
    const total = oldRaw.length + newRaw.length;
    if (total < SIZE_FULL*2) {
        onProgress('✨ Beautification…'); await yield2();
        const oc = js_beautify(oldRaw,{indent_size:2}); await yield2();
        const nc = js_beautify(newRaw,{indent_size:2});
        onProgress('🔍 Calcul diff…'); await yield2();
        return { diff: Diff.diffLines(oc,nc), mode:'full' };
    } else if (total < SIZE_FAST*2) {
        onProgress('⚡ Smart split…'); await yield2();
        return { diff: Diff.diffArrays(smartSplit(oldRaw), smartSplit(newRaw)), mode:'fast' };
    } else {
        onProgress('⚠️ Aperçu 300 Ko…'); await yield2();
        return { diff: Diff.diffArrays(smartSplit(oldRaw.slice(0,300_000)), smartSplit(newRaw.slice(0,300_000))), mode:'preview', truncated:true };
    }
}
function findPrev(baseName, ext, currentEntryIndex) {
    for (let i = currentEntryIndex + 1; i < changelog.length; i++) {
        const found = Object.values(changelog[i].files).flat().find(f => {
            const p = f.split('.'); return p[0] === baseName && p[p.length-1] === ext;
        });
        if (found) return { filename: found, entryIndex: i };
    }
    return null;
}

// ── RENDER DIFF (unified + split view) ────────────────────────────────────────
const BATCH = 500;

function renderDiff(container, allChanges, mode, showNoise, splitView = false) {
    const changes    = showNoise ? allChanges : allChanges.filter(c=>!c.noisy);
    const noisyCount = allChanges.filter(c=>c.noisy).length;
    container.dataset.showNoise  = showNoise;
    container.dataset.splitView  = splitView;

    if (changes.length === 0) {
        container.innerHTML = `<div class="diff-status status-empty">✓ Aucun vrai changement.${noisyCount>0?`<br><small style="opacity:.6">${noisyCount} renommages de vars filtrés</small><br><button class="btn-load-more" style="margin-top:8px" onclick="toggleNoise('${container.id}')">Afficher quand même</button>`:''}</div>`;
        return;
    }
    const added   = changes.filter(c=>c.type==='add').length;
    const removed = changes.filter(c=>c.type==='rem').length;
    const [cls,label] = {full:['full','Full ✨'],fast:['fast','Fast ⚡'],preview:['preview','Aperçu ⚠️']}[mode]||['fast','Fast'];
    const nBtn   = noisyCount>0?`<button class="noise-toggle" onclick="toggleNoise('${container.id}')">${showNoise?'🙈 Masquer bruit':`👁 +${noisyCount} bruit`}</button>`:'';
    const svIcon = splitView
        ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/></svg>`
        : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;

    let html = `<div class="diff-header-bar">
        <div style="display:flex;align-items:center;gap:8px">
            <span class="diff-title">${changes.filter(c=>!c.noisy).length} changements</span>
            <span class="diff-mode-badge mode-${cls}">${label}</span>
        </div>
        <div class="diff-stats">
            <span class="diff-stat-add">+${added}</span>
            <span class="diff-stat-rem">−${removed}</span>
            ${nBtn}
            <button class="noise-toggle" onclick="toggleSplitView('${container.id}')" title="${splitView?'Vue unifiée':'Vue côte à côte'}">${svIcon} ${splitView?'Unifié':'Split'}</button>
            <button class="noise-toggle" onclick="copyDiff('${container.id}')">📋 Copier</button>
        </div>
    </div>`;

    if (splitView) {
        html += renderSplitView(changes, container.id);
    } else {
        html += `<div class="diff-body" id="${container.id}-body">`;
        changes.slice(0,BATCH).forEach(({type,line,noisy}) => {
            const esc = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            html += `<div class="diff-line diff-line-${type==='add'?'add':'rem'}${noisy?' diff-noisy':''}">${esc}</div>`;
        });
        html += `</div>`;
    }

    container.innerHTML = html;
    if (!splitView && changes.length > BATCH) appendLoadMore(container, changes, BATCH);
}

function renderSplitView(changes, cid) {
    // Pair up rem/add lines into columns
    const rows = [];
    let i = 0;
    while (i < changes.length) {
        if (changes[i].type==='rem' && i+1 < changes.length && changes[i+1].type==='add') {
            rows.push({ left: changes[i], right: changes[i+1] }); i+=2;
        } else if (changes[i].type==='rem') {
            rows.push({ left: changes[i], right: null }); i++;
        } else {
            rows.push({ left: null, right: changes[i] }); i++;
        }
    }
    const esc = s => s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : '';
    const rowsHtml = rows.slice(0, BATCH).map(({left, right}) => `
        <div class="split-row">
            <div class="split-cell split-rem${left?.noisy?' diff-noisy':''}">${left ? esc(left.line) : ''}</div>
            <div class="split-cell split-add${right?.noisy?' diff-noisy':''}">${right ? esc(right.line) : ''}</div>
        </div>`).join('');
    return `<div class="diff-body split-body" id="${cid}-body">${rowsHtml}</div>`;
}

window.toggleSplitView = function(cid) {
    const c = document.getElementById(cid); if (!c) return;
    const isSplit = c.dataset.splitView === 'true';
    const all = JSON.parse(c.dataset.diffAll || '[]');
    renderDiff(c, all, c.dataset.diffMode||'fast', c.dataset.showNoise==='true', !isSplit);
};

function appendLoadMore(container, changes, next) {
    document.getElementById(`lm-${container.id}`)?.remove();
    if (next >= changes.length) return;
    const rem = changes.length - next;
    const d = document.createElement('div'); d.id = `lm-${container.id}`; d.className='diff-load-more';
    d.innerHTML = `<button class="btn-load-more" onclick="loadMore('${container.id}',${next})">Afficher ${Math.min(BATCH,rem)} de plus (${rem} restantes)</button>`;
    container.appendChild(d);
}
window.loadMore = function(cid, from) {
    const c = document.getElementById(cid); if (!c) return;
    const sn = c.dataset.showNoise==='true', all = JSON.parse(c.dataset.diffAll||'[]');
    const ch = sn ? all : all.filter(x=>!x.noisy), body = document.getElementById(`${cid}-body`); if (!body) return;
    ch.slice(from, from+BATCH).forEach(({type,line,noisy}) => {
        const el = document.createElement('div');
        el.className = `diff-line diff-line-${type==='add'?'add':'rem'}${noisy?' diff-noisy':''}`;
        el.textContent = line; body.appendChild(el);
    });
    appendLoadMore(c, ch, from+BATCH);
};
window.toggleNoise = function(cid) {
    const c = document.getElementById(cid); if (!c) return;
    renderDiff(c, JSON.parse(c.dataset.diffAll||'[]'), c.dataset.diffMode||'fast', c.dataset.showNoise!=='true', c.dataset.splitView==='true');
};
window.copyDiff = function(cid) {
    const body = document.getElementById(`${cid}-body`); if (!body) return;
    const text = [...body.querySelectorAll('.diff-line')].map(el => (el.classList.contains('diff-line-add')?'+ ':'- ')+el.textContent).join('\n');
    navigator.clipboard.writeText(text).then(() => {
        const btns = body.closest('.diff-container')?.querySelectorAll('.noise-toggle');
        const btn = btns?.[btns.length-1]; if (!btn) return;
        btn.textContent='✓ Copié!'; setTimeout(()=>btn.textContent='📋 Copier',2000);
    });
};

// ── SHOW DIFF ─────────────────────────────────────────────────────────────────
window.showDiff = async function(baseName, fileName, fileExt, entryIndex, diffId) {
    const container = document.getElementById(diffId); if (!container) return;
    if (container.dataset.visible==='true') {
        container.innerHTML=''; container.dataset.visible='false'; container.style.display='none'; return;
    }
    container.style.display='block'; container.dataset.visible='true';
    const cacheKey = `${entryIndex}::${fileName}`;
    if (diffCache.has(cacheKey)) {
        const {allChanges,mode} = diffCache.get(cacheKey);
        container.dataset.diffAll=JSON.stringify(allChanges); container.dataset.diffMode=mode;
        renderDiff(container,allChanges,mode,false); return;
    }
    const prev = findPrev(baseName, fileExt, entryIndex);
    if (!prev) { container.innerHTML=`<div class="diff-status status-error">ℹ️ Première capture de ce fichier.</div>`; return; }
    container.innerHTML=`<div class="diff-status status-loading"><div id="${diffId}-msg">⏳ Chargement…</div><div class="diff-file-label">${prev.filename} → ${fileName}</div><div class="progress-bar-wrap"><div class="progress-bar"></div></div></div>`;
    const setMsg = msg => { const el = document.getElementById(`${diffId}-msg`); if (el) el.textContent = msg; };
    try {
        setMsg('⏳ Lecture depuis GitHub…');
        const [oldRaw,newRaw] = await Promise.all([getRawFile(prev.filename), getRawFile(fileName)]);
        setMsg(`⚙️ Analyse de ${((oldRaw.length+newRaw.length)/1024/1024).toFixed(1)} Mo…`);
        const {diff,mode,truncated} = await computeDiff(oldRaw, newRaw, setMsg);
        const allChanges = buildChanges(diff);
        diffCache.set(cacheKey,{allChanges,mode});
        container.innerHTML='';
        if (truncated) container.insertAdjacentHTML('beforeend',`<div class="diff-truncated-warning">⚠ Aperçu : 300 premiers Ko seulement.</div>`);
        container.dataset.diffAll=JSON.stringify(allChanges); container.dataset.diffMode=mode;
        renderDiff(container,allChanges,mode,false);
    } catch(err) { container.innerHTML=`<div class="diff-status status-error">❌ ${err.message}</div>`; }
};
window.toggleDiff = function(baseName,fileName,fileExt,entryIndex,diffId,btn) {
    const c = document.getElementById(diffId);
    if (c && c.dataset.visible==='true') { btn.textContent='↕ Diff'; btn.classList.remove('active-diff'); }
    else { btn.textContent='✕ Fermer'; btn.classList.add('active-diff'); }
    showDiff(baseName,fileName,fileExt,entryIndex,diffId);
};

// ── FILE HISTORY MODAL ────────────────────────────────────────────────────────
window.openFileHistory = function(baseName, ext) {
    // Collect all versions of this file across the changelog
    const versions = [];
    changelog.forEach((entry, idx) => {
        const all = Object.values(entry.files).flat();
        const file = all.find(f => { const p=f.split('.'); return p[0]===baseName && p[p.length-1]===ext; });
        if (file) versions.push({ filename:file, buildNumber:entry.buildNumber, date:entry.date, sha:entry.sha, entryIndex:idx, saved:(entry.savedFiles||[]).includes(file) });
    });
    if (!versions.length) return;

    closeModal('file-history-modal');
    const overlay = document.createElement('div');
    overlay.id = 'file-history-modal';
    overlay.className = 'modal-overlay';
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

    const rows = versions.map((v,i) => `
        <div class="fh-row" data-idx="${i}">
            <span class="fh-build">#${v.buildNumber}</span>
            <span class="fh-hash" title="${v.filename}">.${v.filename.split('.')[1]||'—'}</span>
            <span class="fh-date">${relTime(v.date)}</span>
            <span class="fh-saved ${v.saved?'saved':'unsaved'}">${v.saved?'✓ sauvegardé':'⚠ absent'}</span>
            <button class="fh-diff-btn ${v.saved&&i<versions.length-1?'':'fh-diff-btn-dis'}"
                onclick="openFileHistoryDiff('${baseName}','${ext}',${i})">↕ Diff</button>
        </div>`).join('');

    overlay.innerHTML = `
        <div class="modal-box modal-wide">
            <div class="modal-header">
                <div>
                    <span class="modal-title">${baseName}.${ext}</span>
                    <span class="modal-subtitle">${versions.length} versions dans le changelog</span>
                </div>
                <button class="modal-close" onclick="closeModal('file-history-modal')">✕</button>
            </div>
            <div id="fh-diff-zone"></div>
            <div class="fh-list">${rows}</div>
        </div>`;
    document.body.appendChild(overlay);
    window.__fhVersions = versions;
    requestAnimationFrame(() => overlay.classList.add('visible'));
};

window.openFileHistoryDiff = async function(baseName, ext, idx) {
    const versions = window.__fhVersions; if (!versions) return;
    const cur  = versions[idx];
    const prev = versions.slice(idx+1).find(v => v.saved);
    const zone = document.getElementById('fh-diff-zone'); if (!zone) return;

    if (!cur.saved)  { zone.innerHTML=`<div class="diff-status status-error" style="padding:14px">⚠ Fichier non sauvegardé.</div>`; return; }
    if (!prev)       { zone.innerHTML=`<div class="diff-status status-error" style="padding:14px">ℹ️ Pas de version précédente sauvegardée.</div>`; return; }

    zone.innerHTML = `<div class="diff-status status-loading" style="padding:14px"><div id="fh-diff-msg">⏳ Chargement…</div><div class="progress-bar-wrap"><div class="progress-bar"></div></div></div>`;
    const setMsg = msg => { const el = document.getElementById('fh-diff-msg'); if (el) el.textContent=msg; };

    // highlight selected row
    document.querySelectorAll('.fh-row').forEach((r,i) => r.classList.toggle('active', i===idx));
    try {
        setMsg(`⏳ Lecture de #${prev.buildNumber} → #${cur.buildNumber}…`);
        const [oldRaw, newRaw] = await Promise.all([getRawFile(prev.filename), getRawFile(cur.filename)]);
        const {diff,mode,truncated} = await computeDiff(oldRaw, newRaw, setMsg);
        const allChanges = buildChanges(diff);
        zone.innerHTML = truncated ? `<div class="diff-truncated-warning">⚠ Aperçu 300 Ko.</div>` : '';
        const dc = document.createElement('div');
        dc.className='diff-container'; dc.id='fh-diff-container';
        zone.appendChild(dc);
        dc.dataset.diffAll=JSON.stringify(allChanges); dc.dataset.diffMode=mode;
        renderDiff(dc, allChanges, mode, false);
    } catch(err) { zone.innerHTML=`<div class="diff-status status-error" style="padding:14px">❌ ${err.message}</div>`; }
};

function closeModal(id) { document.getElementById(id)?.remove(); }

// ── BUILD CARDS ───────────────────────────────────────────────────────────────
function relTime(dateStr) {
    const d=Date.now()-new Date(dateStr), m=Math.floor(d/60000);
    if(m<1) return 'à l\'instant'; if(m<60) return `il y a ${m} min`;
    const h=Math.floor(m/60); if(h<24) return `il y a ${h}h`;
    return `il y a ${Math.floor(h/24)}j`;
}

function createCard(entry, entryIndex) {
    const sha     = entry.sha;
    const date    = new Date(entry.date).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
    const jsFiles   = entry.files['js']  || [];
    const cssFiles  = entry.files['css'] || [];
    const otherFiles= [...(entry.files['worker']||[]),...(entry.files['asset']||[]),...(entry.files['manifest']||[])];
    const allFiles  = [...jsFiles,...cssFiles,...otherFiles];
    const savedSet  = new Set(entry.savedFiles||[]);

    let badges='';
    if(jsFiles.length)    badges+=`<span class="count-badge count-js">${jsFiles.length} JS</span>`;
    if(cssFiles.length)   badges+=`<span class="count-badge count-css">${cssFiles.length} CSS</span>`;
    if(otherFiles.length) badges+=`<span class="count-badge count-other">${otherFiles.length} autres</span>`;

    function fileSection(files, type, dotClass, label) {
        if (!files.length) return '';
        let html = `<div class="section-label">${label} <span class="section-count">${files.length}</span></div>`;
        files.forEach(fileName => {
            const parts    = fileName.split('.');
            const baseName = parts[0], fileExt = parts[parts.length-1], hash = parts.length>2?parts[1]:'';
            const diffId   = `d-${sha.slice(0,7)}-${fileName.replace(/[^a-zA-Z0-9]/g,'_')}`;
            const isCode   = type==='js' || type==='css';
            const isSaved  = savedSet.has(fileName);
            html += `<div class="file-row">
                <div class="file-type-dot ${dotClass}"></div>
                <div class="file-info">
                    <span class="file-basename file-history-link" onclick="openFileHistory('${baseName}','${fileExt}')" title="Voir l'historique">${baseName}</span>
                    ${hash?`<span class="file-hash">.${hash}</span>`:''}
                    <span class="file-ext">.${fileExt}</span>
                </div>
                <div class="file-status-dot" title="${isSaved?'Sauvegardé':'Non sauvegardé'}">${isSaved?'✓':'⚠'}</div>
                <div class="file-actions">
                    ${isCode&&isSaved ?`<button class="btn-diff" id="btn-${diffId}" onclick="toggleDiff('${baseName}','${fileName}','${fileExt}',${entryIndex},'${diffId}',this)">↕ Diff</button>`:''}
                    ${isCode&&!isSaved?`<span class="btn-diff disabled">↕ Diff</span>`:''}
                    <a class="btn-icon-link" href="https://github.com/${MY_REPO}/blob/main/assets/${fileName}" target="_blank" title="GitHub">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.73.084-.73 1.205.085 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12"/></svg>
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
    card.dataset.sha   = sha;
    card.dataset.files = allFiles.join(',');
    card.dataset.build = entry.buildNumber;
    card.dataset.jsHTML    = fileSection(jsFiles,'js','dot-js','JavaScript');
    card.dataset.cssHTML   = fileSection(cssFiles,'css','dot-css','Stylesheet');
    card.dataset.allHTML   = allHTML;
    const savedCount = entry.savedFiles?.length||0;

    // Permalink button
    const permUrl = `${location.origin}${location.pathname}#build=${entry.buildNumber}`;

    card.innerHTML = `
        <div class="card-header" onclick="toggleCard('${sha}')">
            <div class="card-header-left">
                <span class="build-number">#${entry.buildNumber}</span>
                <div class="card-meta">
                    <span class="card-title">${allFiles.length} fichier${allFiles.length>1?'s':''} · <span class="saved-badge">${savedCount}/${allFiles.length} ✓</span></span>
                    <span class="card-date" title="${date}">${relTime(entry.date)} · ${date}</span>
                </div>
            </div>
            <div class="card-header-right">
                <button class="btn-permalink" title="Copier le lien" onclick="event.stopPropagation();copyPermalink('${permUrl}',this)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                </button>
                <div class="file-counts">${badges}</div>
                <svg class="toggle-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
        </div>
        <div class="files-panel" id="panel-${sha}">
            <div class="panel-tabs" id="tabs-${sha}">
                <button class="panel-tab active" onclick="switchTab('${sha}','all',this)">Tous (${allFiles.length})</button>
                ${jsFiles.length ?`<button class="panel-tab" onclick="switchTab('${sha}','js',this)">JS (${jsFiles.length})</button>`:''}
                ${cssFiles.length?`<button class="panel-tab" onclick="switchTab('${sha}','css',this)">CSS (${cssFiles.length})</button>`:''}
            </div>
            <div class="panel-content" id="content-${sha}">${allHTML}</div>
        </div>`;
    return card;
}

window.copyPermalink = function(url, btn) {
    navigator.clipboard.writeText(url).then(() => {
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1800);
    });
};
window.toggleCard = function(sha) {
    const p = document.getElementById(`panel-${sha}`);
    const opened = p.classList.toggle('open');
    p.closest('.update-card').querySelector('.toggle-arrow').classList.toggle('open', opened);
    if (opened) setHash('build', p.closest('.update-card').dataset.build);
    else if (parseHash().build) setHash('build', null);
};
window.switchTab = function(sha,type,tabEl) {
    const card = document.getElementById(`panel-${sha}`).closest('.update-card');
    document.getElementById(`tabs-${sha}`).querySelectorAll('.panel-tab').forEach(t=>t.classList.remove('active'));
    tabEl.classList.add('active');
    document.getElementById(`content-${sha}`).innerHTML = ({all:card.dataset.allHTML,js:card.dataset.jsHTML,css:card.dataset.cssHTML})[type]||'';
};
window.setFilter = function(type,btn) {
    activeFilter=type;
    document.querySelectorAll('.filter-tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); filterCards();
};
window.filterCards = function() {
    const q = document.getElementById('search-input').value.toLowerCase().trim();
    let v=0;
    const cards = [...document.querySelectorAll('.update-card')];
    cards.forEach(c => {
        const t=(c.dataset.sha+' '+c.dataset.files).toLowerCase(), f=c.dataset.files;
        const mQ=!q||t.includes(q), mT=activeFilter==='all'||(activeFilter==='js'&&f.includes('.js'))||(activeFilter==='css'&&f.includes('.css'));
        const show=mQ&&mT; c.style.display=show?'':'none'; if(show)v++;
    });
    let nr=document.getElementById('no-results');
    if(!v&&!nr){nr=document.createElement('div');nr.id='no-results';nr.className='no-results';nr.textContent='Aucun résultat.';document.getElementById('updates-list').appendChild(nr);}
    else if(v&&nr)nr.remove();
};

// ── COMPACT MODE ──────────────────────────────────────────────────────────────
window.toggleCompact = function(btn) {
    compactMode = !compactMode;
    document.getElementById('updates-list').classList.toggle('compact-mode', compactMode);
    btn.classList.toggle('active', compactMode);
    btn.title = compactMode ? 'Vue normale' : 'Vue compacte';
};

// ── ASSETS PAGE ───────────────────────────────────────────────────────────────
const IMG_EXTS = new Set(['png','jpg','jpeg','gif','svg','webp','ico','avif']);

function collectAssets() {
    const map = new Map();
    changelog.forEach(entry => {
        Object.values(entry.files).flat().forEach(filename => {
            const parts = filename.split('.'), ext = parts[parts.length-1].toLowerCase();
            if (!IMG_EXTS.has(ext)) return;
            const base = parts[0];
            if (!map.has(base)) map.set(base, []);
            map.get(base).push({ filename, hash: parts.length>2?parts[1]:'', ext, date:entry.date, buildNumber:entry.buildNumber, sha:entry.sha });
        });
    });
    return map;
}

async function renderAssetsPage() {
    const page = document.getElementById('page-assets');
    page.dataset.loaded = '1';
    page.innerHTML = `<div class="assets-loading"><div class="loading-spinner"></div><div class="loading-text">Chargement des assets…</div></div>`;
    const assetMap = collectAssets();
    if (assetMap.size === 0) {
        page.innerHTML = `<div class="diff-status status-error" style="padding:60px">ℹ️ Aucun asset image trouvé.<br><small style="opacity:.6">Les images Discord sont listées dans la section "Assets" des commits.</small></div>`;
        return;
    }
    let html = `<div class="assets-header-bar"><span class="assets-count">${assetMap.size} assets détectés</span></div><div class="assets-grid">`;
    for (const [base, versions] of assetMap) {
        const latest = versions[0], imgUrl = `${DISCORD_CDN}${latest.filename}`, vCount = versions.length;
        html += `<div class="asset-card" onclick="openAssetModal('${base}')">
            <div class="asset-preview"><img src="${imgUrl}" alt="${latest.filename}" onerror="this.parentElement.innerHTML='<div class=asset-no-preview>?</div>'" loading="lazy"></div>
            <div class="asset-info">
                <div class="asset-name" title="${latest.filename}">${base}</div>
                <div class="asset-meta">
                    <span class="asset-ext">.${latest.ext}</span>
                    ${vCount>1?`<span class="asset-versions">${vCount} versions</span>`:''}
                    <span class="asset-date">${relTime(latest.date)}</span>
                </div>
            </div>
        </div>`;
    }
    html += `</div>`;
    window.__assetMap = assetMap;
    page.innerHTML = html;
}

window.openAssetModal = function(base) {
    const versions = window.__assetMap?.get(base); if (!versions) return;
    closeModal('asset-modal-overlay');
    const overlay = document.createElement('div');
    overlay.id = 'asset-modal-overlay'; overlay.className = 'modal-overlay';
    overlay.onclick = e => { if (e.target===overlay) overlay.remove(); };
    const imgUrl = `${DISCORD_CDN}${versions[0].filename}`;
    overlay.innerHTML = `
        <div class="modal-box">
            <div class="modal-header">
                <span class="modal-title">${base}</span>
                <button class="modal-close" onclick="closeModal('asset-modal-overlay')">✕</button>
            </div>
            <div class="modal-img-wrap">
                <img id="modal-main-img" src="${imgUrl}" alt="${base}" onerror="this.alt='Image non disponible'">
                <div id="modal-img-meta" class="modal-img-meta">${versions[0].filename}</div>
            </div>
            <div class="modal-versions">
                <div class="modal-versions-label">Toutes les versions (${versions.length})</div>
                <div class="modal-versions-list">
                    ${versions.map((v,i)=>`<div class="modal-version-row${i===0?' active':''}" onclick="selectAssetVersion('${base}',${i})">
                        <span class="mv-build">#${v.buildNumber}</span>
                        <span class="mv-hash" title="${v.filename}">.${v.hash||'—'}</span>
                        <span class="mv-date">${relTime(v.date)}</span>
                        ${i===0?'<span class="mv-badge-latest">Dernière</span>':''}
                    </div>`).join('')}
                </div>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));
};
window.selectAssetVersion = function(base, idx) {
    const versions = window.__assetMap?.get(base); if (!versions||!versions[idx]) return;
    const v=versions[idx], img=document.getElementById('modal-main-img'), meta=document.getElementById('modal-img-meta');
    if(img){img.src=`${DISCORD_CDN}${v.filename}`;img.alt=v.filename;}
    if(meta)meta.textContent=v.filename;
    document.querySelectorAll('.modal-version-row').forEach((r,i)=>r.classList.toggle('active',i===idx));
};

// ── FEATURES PAGE ─────────────────────────────────────────────────────────────

// ── FEATURE EXTRACTION ───────────────────────────────────────────────────────
// Stratégie : indexOf rapide + fenêtre fixe autour de chaque match
// → pas de backtracking catastrophique sur le code minifié

function extractFeatures(code) {
    const features = new Map();

    // ── Helpers ──────────────────────────────────────────────────────────────

    // Extrait une fenêtre de texte autour d'une position
    const win = (pos, before=250, after=700) =>
        code.slice(Math.max(0, pos - before), Math.min(code.length, pos + after));

    // Parse les traitements depuis un bloc de texte
    function parseTreatments(block) {
        const out = [];
        // Format treatments:[{id:0,label:"Control"},{id:1,label:"Foo"}]
        const tRe = /\{id:(\d+),(?:[^}]*?)label:"([^"]{1,60})"/g;
        let m;
        while ((m = tRe.exec(block)) !== null)
            out.push({ id: +m[1], label: m[2] });
        // Format variations:{0:{label:"Control"},1:{label:"Foo"}}
        if (!out.length) {
            const vRe = /(\d+):\{(?:[^}]*?)label:"([^"]{1,60})"/g;
            while ((m = vRe.exec(block)) !== null)
                out.push({ id: +m[1], label: m[2] });
        }
        // Deduplicate by id
        const seen = new Set();
        return out.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });
    }

    // Parse le rollout/population depuis un bloc
    function parseRollout(block) {
        const m = block.match(/(?:rollout(?:Percentage)?|population)\s*:\s*([0-9.]+)/);
        if (!m) return null;
        const v = parseFloat(m[1]);
        return v <= 1 ? Math.round(v * 100) : Math.round(v);
    }

    // Detecte si l'experiment est désactivé par défaut (defaultConfig:{enabled:!1/false})
    function isDefaultDisabled(block) {
        return /defaultConfig\s*:\s*\{[^}]*enabled\s*:\s*(?:!1|false)/.test(block);
    }

    // ── 1. Experiments — détection par "kind:" ────────────────────────────────
    // On cherche kind:"user/guild/installation" et on remonte pour trouver name/id
    // C'est beaucoup plus rapide qu'un regex avec [^}]*
    let pos = 0;
    while (true) {
        const kindPos = code.indexOf('kind:"', pos);
        if (kindPos === -1) break;
        pos = kindPos + 1;

        const kindSlice = code.slice(kindPos + 6, kindPos + 20);
        let kind = null;
        if (kindSlice.startsWith('user"'))          kind = 'user';
        else if (kindSlice.startsWith('guild"'))     kind = 'guild';
        else if (kindSlice.startsWith('installation"')) kind = 'installation';
        if (!kind) continue;

        // Chercher name: ou id: dans les 250 chars précédents
        const lookback = code.slice(Math.max(0, kindPos - 250), kindPos);
        const nameM = lookback.match(/(?:name|id)\s*:\s*"([a-z][a-z0-9_-]{2,})"[^"]*$/)
                   || lookback.match(/(?:name|id)\s*:\s*"([a-z][a-z0-9_-]{2,})"/);
        if (!nameM) continue;

        const id = nameM[1];
        // Filtre les faux positifs évidents
        if (id.length < 3 || /^(use|get|set|has|is|on|to|in|of|at)$/.test(id)) continue;
        if (features.has(id)) continue;

        const block = win(kindPos, 250, 700);
        const treatments = parseTreatments(block);
        const rollout = parseRollout(block);
        const disabled = isDefaultDisabled(block);

        // Detect description/title if present
        const titleM = block.match(/(?:description|title)\s*:\s*"([^"]{5,80})"/);
        const desc = titleM ? titleM[1] : null;

        features.set(id, {
            type: 'experiment',
            kind,
            treatments,
            rollout,
            disabled,
            desc,
            color: 'cyan',
        });
    }

    // ── 2. Enabled feature strings ────────────────────────────────────────────
    // enabledExperiments:["mana-toggle-inputs","refresh-fast-follow-avatars",...]
    // Ces strings sont des flags actifs passés aux composants
    pos = 0;
    while (true) {
        const ePos = code.indexOf('enabledExperiments:[', pos);
        if (ePos === -1) break;
        pos = ePos + 1;

        // Extraire jusqu'au ] suivant (max 600 chars)
        const end = code.indexOf(']', ePos + 20);
        if (end === -1 || end - ePos > 600) continue;
        const arr = code.slice(ePos + 20, end);

        const strRe = /"([a-z][a-z0-9_-]{3,})"/g;
        let m;
        while ((m = strRe.exec(arr)) !== null) {
            const flag = m[1];
            if (!features.has('flag:' + flag)) {
                features.set('flag:' + flag, {
                    type: 'flag',
                    kind: 'enabled',
                    treatments: [],
                    rollout: null,
                    color: 'teal',
                });
            }
        }
    }

    // ── 3. Guild features ─────────────────────────────────────────────────────
    const KNOWN_GUILD = new Set([
        'COMMUNITY','DISCOVERABLE','PARTNERED','VERIFIED','ANIMATED_BANNER',
        'ANIMATED_ICON','AUTO_MODERATION','CHANNEL_ICON_EMOJIS_GENERATED',
        'CLAN','CREATOR_MONETIZABLE','CREATOR_STORE_PAGE','DEVELOPER_SUPPORT_SERVER',
        'ENABLED_DISCOVERABLE_BEFORE','GUESTS_ENABLED','HAS_DIRECTORY_ENTRY','HUB',
        'INVITE_SPLASH','LINKED_TO_HUB','MEMBER_PROFILES','MEMBER_VERIFICATION_GATE_ENABLED',
        'MONETIZATION_ENABLED','MORE_EMOJI','MORE_SOUNDBOARD','MORE_STICKERS',
        'NEWS','PREVIEW_ENABLED','PRIVATE_THREADS','RAID_ALERTS_DISABLED',
        'RELAY_ENABLED','ROLE_ICONS','ROLE_SUBSCRIPTIONS_AVAILABLE_FOR_PURCHASE',
        'ROLE_SUBSCRIPTIONS_ENABLED','SOUNDBOARD','SUMMARIES_ENABLED',
        'TEXT_IN_VOICE_ENABLED','THREADS_ENABLED','TICKETED_EVENTS_ENABLED',
        'VANITY_URL','VIP_REGIONS','WELCOME_SCREEN_ENABLED',
        'BURST_REACTIONS','CLYDE_ENABLED','CLYDE_DISABLED','ACTIVITIES_ALPHA',
        'ACTIVITIES_EMPLOYEE','CHANNEL_HIGHLIGHTS','CHANNEL_HIGHLIGHTS_DISABLED',
        'DISABLE_STICKERS','EXPOSURE_CHECK_COMPLETED',
    ]);
    const guildRe = /"([A-Z][A-Z0-9_]{4,})"/g;
    let gm;
    while ((gm = guildRe.exec(code)) !== null) {
        if (KNOWN_GUILD.has(gm[1]) && !features.has(gm[1]))
            features.set(gm[1], { type: 'guild_feature', kind: 'guild', treatments: [], rollout: null, color: 'purple' });
    }

    // ── 4. Feature checks ─────────────────────────────────────────────────────
    const checkRe = /(?:useFeatureIsEnabled|isFeatureEnabled|hasFeature|useIsUserExperiment)\("([a-zA-Z][a-zA-Z0-9_]{3,})"\)/g;
    let cm;
    while ((cm = checkRe.exec(code)) !== null) {
        if (!features.has(cm[1]))
            features.set(cm[1], { type: 'feature_check', kind: 'check', treatments: [], rollout: null, color: 'green' });
    }

    // ── 5. Redux action types (nouveaux events Discord) ───────────────────────
    // Detect action strings never seen before: "SOME_THING_NEW_V2"
    // On cherche des strings qui ressemblent à des action types récents
    // (SCREENSHARE_*, VOICE_*, GUILD_*, etc.) mais uniquement dans des dispatch()
    const dispatchRe = /dispatch\(\{type:"([A-Z][A-Z0-9_]{5,})"/g;
    let dm;
    const ACTION_PREFIXES = new Set([
        'GUILD_','CHANNEL_','MESSAGE_','VOICE_','VIDEO_','PRESENCE_',
        'RELATIONSHIP_','INTERACTION_','STAGE_','THREAD_','FORUM_',
        'CALL_','CLIP_','STREAM_','FRIEND_','NITRO_','PREMIUM_',
    ]);
    while ((dm = dispatchRe.exec(code)) !== null) {
        const act = dm[1];
        const hasKnownPrefix = [...ACTION_PREFIXES].some(p => act.startsWith(p));
        if (hasKnownPrefix && !features.has('action:' + act)) {
            features.set('action:' + act, {
                type: 'action',
                kind: 'redux',
                treatments: [],
                rollout: null,
                color: 'orange',
            });
        }
    }

    return features;
}

// ── Build picker + comparison ─────────────────────────────────────────────────

async function renderFeaturesPage() {
    const page = document.getElementById('page-features');
    page.dataset.loaded = '1';
    const webEntries = [];
    for (const entry of changelog) {
        const webJs = (entry.files['js']||[]).find(f => f.startsWith('web.'));
        if (webJs && (entry.savedFiles||[]).includes(webJs))
            webEntries.push({ filename: webJs, buildNumber: entry.buildNumber, date: entry.date });
    }
    if (!webEntries.length) {
        page.innerHTML = `<div class="diff-status status-error" style="padding:60px">Aucun fichier web.js sauvegardé.</div>`;
        return;
    }

    page.innerHTML = `
    <div class="feat-toolbar">
        <div class="feat-build-picker">
            <div class="feat-picker-group">
                <label class="feat-picker-label">Comparer</label>
                <select id="feat-cur" class="feat-select" onchange="reloadFeatures()">${
                    webEntries.map((e,i)=>`<option value="${i}" ${i===0?'selected':''}>#${e.buildNumber} · ${relTime(e.date)}</option>`).join('')
                }</select>
            </div>
            <span class="feat-picker-arrow">←</span>
            <div class="feat-picker-group">
                <label class="feat-picker-label">Base</label>
                <select id="feat-prev" class="feat-select" onchange="reloadFeatures()">${
                    webEntries.map((e,i)=>`<option value="${i}" ${i===1?'selected':''}>#${e.buildNumber} · ${relTime(e.date)}</option>`).join('')
                }</select>
            </div>
        </div>
        <div class="feat-filter-bar">
            <input type="text" id="feat-search" class="feat-search" placeholder="🔍 Filtrer…" oninput="filterFeatures()">
            <div class="feat-type-tabs">
                <button class="feat-type-tab active" onclick="setFeatFilter('all',this)">Tous</button>
                <button class="feat-type-tab" onclick="setFeatFilter('experiment',this)">🧪 Experiments</button>
                <button class="feat-type-tab" onclick="setFeatFilter('flag',this)">🚩 Flags</button>
                <button class="feat-type-tab" onclick="setFeatFilter('guild_feature',this)">🏰 Guild</button>
                <button class="feat-type-tab" onclick="setFeatFilter('feature_check',this)">✅ Checks</button>
                <button class="feat-type-tab" onclick="setFeatFilter('action',this)">📡 Actions</button>
            </div>
        </div>
    </div>
    <div id="feat-results">
        <div class="assets-loading"><div class="loading-spinner"></div>
        <div class="loading-text" id="feat-loading-text">Téléchargement…</div></div>
    </div>`;

    window.__featWebEntries = webEntries;
    await loadFeaturesComparison(webEntries, 0, 1);
}

async function loadFeaturesComparison(webEntries, curIdx, prevIdx) {
    const resultsEl = document.getElementById('feat-results');
    const setStatus = (msg) => {
        const el = document.getElementById('feat-loading-text');
        if (el) el.textContent = msg;
        else resultsEl.innerHTML = `<div class="assets-loading"><div class="loading-spinner"></div><div class="loading-text" id="feat-loading-text">${msg}</div></div>`;
    };
    setStatus(`⬇ ${webEntries[curIdx].filename}…`);
    try {
        const [curCode, prevCode] = await Promise.all([
            getRawFile(webEntries[curIdx].filename),
            curIdx !== prevIdx ? getRawFile(webEntries[prevIdx].filename) : Promise.resolve(''),
        ]);
        setStatus('🔍 Analyse…');
        await yield2();

        const cur  = extractFeatures(curCode);
        const prev = prevCode ? extractFeatures(prevCode) : new Map();
        window.__featCur  = cur;
        window.__featPrev = prev;
        window.__featCurEntry  = webEntries[curIdx];
        window.__featPrevEntry = webEntries[prevIdx];
        renderFeaturesResults();
    } catch(err) {
        resultsEl.innerHTML = `<div class="diff-status status-error" style="padding:40px">❌ ${err.message}</div>`;
    }
}

window.reloadFeatures = function() {
    const curIdx  = parseInt(document.getElementById('feat-cur')?.value  || 0);
    const prevIdx = parseInt(document.getElementById('feat-prev')?.value || 1);
    loadFeaturesComparison(window.__featWebEntries, curIdx, prevIdx);
};
window.setFeatFilter = function(type, btn) {
    _featFilter = type;
    document.querySelectorAll('.feat-type-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderFeaturesResults();
};
window.filterFeatures = function() {
    _featSearch = document.getElementById('feat-search')?.value.toLowerCase().trim() || '';
    renderFeaturesResults();
};

// ── Export new experiments ────────────────────────────────────────────────────
window.exportNewFeatures = function() {
    const cur = window.__featCur, prev = window.__featPrev;
    if (!cur) return;
    const newKeys = [...cur.keys()].filter(k => !prev.has(k));
    const lines = newKeys.map(k => {
        const f = cur.get(k);
        const name = k.replace(/^(?:flag:|action:)/, '');
        const info = [];
        if (f.type === 'experiment') {
            info.push(`kind:${f.kind}`);
            if (f.treatments.length) info.push(`treatments:[${f.treatments.map(t=>t.label).join(', ')}]`);
            if (f.rollout !== null) info.push(`rollout:${f.rollout}%`);
        }
        return `${name}${info.length ? ' — ' + info.join(', ') : ''}`;
    });
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
        showToast(`📋 ${lines.length} nouvelles features copiées !`);
    });
};

// ── Render ────────────────────────────────────────────────────────────────────
function renderFeaturesResults() {
    const resultsEl = document.getElementById('feat-results');
    if (!resultsEl || !window.__featCur) return;

    const cur  = window.__featCur;
    const prev = window.__featPrev || new Map();
    const curEntry  = window.__featCurEntry;
    const prevEntry = window.__featPrevEntry;

    const allKeys = [...cur.keys()];
    const newKeys = allKeys.filter(k => !prev.has(k));
    const remKeys = [...prev.keys()].filter(k => !cur.has(k));

    const byType = (map, type) => [...map.keys()].filter(k => map.get(k).type === type);
    const expCur  = byType(cur, 'experiment').length;
    const flagCur = byType(cur, 'flag').length;
    const gldCur  = byType(cur, 'guild_feature').length;
    const chkCur  = byType(cur, 'feature_check').length;
    const actCur  = byType(cur, 'action').length;

    const newExp  = newKeys.filter(k => cur.get(k).type === 'experiment').length;
    const newFlag = newKeys.filter(k => cur.get(k).type === 'flag').length;

    // Update tab badge
    const badge = document.getElementById('features-badge');
    if (badge) {
        if (newKeys.length > 0) { badge.textContent = newKeys.length; badge.classList.add('show'); }
        else badge.classList.remove('show');
    }

    const shouldShow = (k, map) => {
        const f = map.get(k);
        if (_featFilter !== 'all' && f.type !== _featFilter) return false;
        if (_featSearch) {
            const name = k.replace(/^(?:flag:|action:)/, '');
            if (!name.toLowerCase().includes(_featSearch) && !(f.desc||'').toLowerCase().includes(_featSearch)) return false;
        }
        return true;
    };

    // ── Row renderer ──────────────────────────────────────────────────────────
    const renderRow = (k, f, isNew, isRem) => {
        const COLORS = { experiment:'cyan', flag:'teal', guild_feature:'purple', feature_check:'green', action:'orange' };
        const LABELS = { experiment:'exp', flag:'flag', guild_feature:'guild', feature_check:'check', action:'action' };
        const color = COLORS[f.type] || 'yellow';
        const typeLabel = LABELS[f.type] || f.type;
        const displayName = k.replace(/^(?:flag:|action:)/, '');

        let extra = '';
        if (f.type === 'experiment') {
            // Kind badge
            const kindColor = { user:'blurple', guild:'purple', installation:'teal' }[f.kind] || 'blurple';
            extra += `<span class="feat-kind feat-kind-${kindColor}">${f.kind}</span>`;
            // Default enabled/disabled hint
            if (f.disabled) extra += `<span class="feat-default-off" title="defaultConfig: disabled">off</span>`;
            // Treatments
            if (f.treatments.length > 0) {
                extra += `<span class="feat-treatments">${
                    f.treatments.map(t => `<span class="feat-treat" title="id:${t.id}">${t.label}</span>`).join('')
                }</span>`;
            } else {
                extra += `<span class="feat-treat-count">${f.treatments.length || '?'} variants</span>`;
            }
            // Rollout
            if (f.rollout !== null) extra += `<span class="feat-rollout">${f.rollout}%</span>`;
            // Description
            if (f.desc) extra += `<span class="feat-desc" title="${f.desc}">${f.desc.slice(0, 50)}${f.desc.length > 50 ? '…' : ''}</span>`;
        } else if (f.type === 'flag') {
            extra = `<span class="feat-kind feat-kind-teal">enabled</span>`;
        } else if (f.type === 'guild_feature') {
            extra = `<span class="feat-kind feat-kind-purple">guild</span>`;
        } else if (f.type === 'action') {
            extra = `<span class="feat-kind feat-kind-orange">dispatch</span>`;
        }

        return `<div class="feat-row${isNew?' feat-row-new':''}${isRem?' feat-row-rem':''}">
            <span class="feat-badge feat-badge-${color}">${typeLabel}</span>
            <span class="feat-name" title="${displayName}">${displayName}</span>
            ${extra}
            <button class="feat-copy-btn" onclick="copyFeatName('${displayName.replace(/'/g,"\\'")}',this)" title="Copier">⧉</button>
            ${isNew ? '<span class="feat-new-badge">NEW</span>' : ''}
        </div>`;
    };

    // ── Summary bar ───────────────────────────────────────────────────────────
    let html = `
    <div class="features-summary">
        <div class="feat-stat-card feat-stat-new">
            <div class="feat-stat-num">${newKeys.length}</div>
            <div class="feat-stat-label">Nouveaux</div>
        </div>
        <div class="feat-stat-card feat-stat-rem">
            <div class="feat-stat-num">${remKeys.length}</div>
            <div class="feat-stat-label">Supprimés</div>
        </div>
        <div class="feat-stat-card">
            <div class="feat-stat-num">${expCur}</div>
            <div class="feat-stat-label">🧪 Exp</div>
        </div>
        <div class="feat-stat-card">
            <div class="feat-stat-num">${flagCur}</div>
            <div class="feat-stat-label">🚩 Flags</div>
        </div>
        <div class="feat-stat-card">
            <div class="feat-stat-num">${cur.size}</div>
            <div class="feat-stat-label">Total</div>
        </div>
    </div>
    <div class="features-meta">
        <strong>#${prevEntry?.buildNumber||'?'}</strong> → <strong>#${curEntry?.buildNumber||'?'}</strong>
        <span style="opacity:.3;margin:0 8px">·</span>
        🧪 ${expCur} exp · 🚩 ${flagCur} flags · 🏰 ${gldCur} guild · ✅ ${chkCur} checks · 📡 ${actCur} actions
        ${newKeys.length > 0 ? `
        <button class="feat-export-btn" onclick="exportNewFeatures()" title="Copier les ${newKeys.length} nouveautés">
            📋 Exporter les nouveautés
        </button>` : ''}
    </div>`;

    // ── Section nouveaux ──────────────────────────────────────────────────────
    const visibleNew = newKeys.filter(k => shouldShow(k, cur));
    if (visibleNew.length) {
        // Group new by type
        const newByType = [
            { type:'experiment',   label:'🧪 Experiments', pill:'cyan'   },
            { type:'flag',         label:'🚩 Feature flags', pill:'teal'  },
            { type:'guild_feature',label:'🏰 Guild',         pill:'purple'},
            { type:'feature_check',label:'✅ Checks',        pill:'green' },
            { type:'action',       label:'📡 Actions',       pill:'orange'},
        ];
        html += `<div class="feat-section feat-section-new">
            <div class="feat-section-title">
                <span class="feat-pill feat-pill-cyan">🆕 ${visibleNew.length} nouveau${visibleNew.length>1?'x':''}</span>
            </div>`;
        for (const g of newByType) {
            const keys = visibleNew.filter(k => cur.get(k).type === g.type);
            if (!keys.length) continue;
            html += `<div class="feat-new-group">
                <div class="feat-new-group-label">${g.label} <span class="feat-new-count">${keys.length}</span></div>
                <div class="feat-list">${keys.map(k => renderRow(k, cur.get(k), true, false)).join('')}</div>
            </div>`;
        }
        html += `</div>`;
    }

    // ── Section supprimés ─────────────────────────────────────────────────────
    const visibleRem = remKeys.filter(k => shouldShow(k, prev));
    if (visibleRem.length) {
        html += `<details class="feat-section">
            <summary class="feat-section-title">
                <span class="feat-pill feat-pill-red">🗑 ${visibleRem.length} supprimé${visibleRem.length>1?'s':''}</span>
            </summary>
            <div class="feat-list" style="margin-top:8px">
                ${visibleRem.slice(0,60).map(k => renderRow(k, prev.get(k), false, true)).join('')}
                ${visibleRem.length>60?`<div class="feat-more">+${visibleRem.length-60} autres…</div>`:''}
            </div>
        </details>`;
    }

    // ── Sections existantes par type ──────────────────────────────────────────
    const existingKeys = allKeys.filter(k => !newKeys.includes(k) && shouldShow(k, cur));
    const groups = [
        { type:'experiment',   label:'🧪 Experiments',   pill:'cyan',   sub: true  },
        { type:'flag',         label:'🚩 Feature flags',  pill:'teal',   sub: false },
        { type:'guild_feature',label:'🏰 Guild features', pill:'purple', sub: false },
        { type:'feature_check',label:'✅ Feature checks', pill:'green',  sub: false },
        { type:'action',       label:'📡 Redux actions',  pill:'orange', sub: false },
    ];
    for (const g of groups) {
        if (_featFilter !== 'all' && _featFilter !== g.type) continue;
        const keys = existingKeys.filter(k => cur.get(k).type === g.type);
        if (!keys.length) continue;

        let inner = '';
        if (g.sub && g.type === 'experiment') {
            // Sub-group by kind for experiments
            for (const kind of ['user','guild','installation']) {
                const kk = keys.filter(k => cur.get(k).kind === kind);
                if (!kk.length) continue;
                inner += `<div class="feat-new-group">
                    <div class="feat-new-group-label">${kind} <span class="feat-new-count">${kk.length}</span></div>
                    <div class="feat-list">
                        ${kk.slice(0, 150).map(k => renderRow(k, cur.get(k), false, false)).join('')}
                        ${kk.length > 150 ? `<div class="feat-more">+${kk.length-150} de plus…</div>` : ''}
                    </div>
                </div>`;
            }
        } else {
            inner = `<div class="feat-list" style="margin-top:8px">
                ${keys.slice(0, 120).map(k => renderRow(k, cur.get(k), false, false)).join('')}
                ${keys.length > 120 ? `<div class="feat-more">+${keys.length-120} de plus…</div>` : ''}
            </div>`;
        }

        html += `<details class="feat-section">
            <summary class="feat-section-title">
                <span class="feat-pill feat-pill-${g.pill}">${g.label} · ${keys.length}</span>
            </summary>
            ${inner}
        </details>`;
    }

    if (!visibleNew.length && !visibleRem.length && !existingKeys.length)
        html += `<div class="diff-status status-empty" style="padding:40px">Aucun résultat pour ce filtre.</div>`;

    resultsEl.innerHTML = html;
}

window.copyFeatName = function(name, btn) {
    navigator.clipboard.writeText(name).then(() => {
        btn.textContent = '✓';
        setTimeout(() => btn.textContent = '⧉', 1500);
    });
};


// ── CODE SEARCH PAGE ──────────────────────────────────────────────────────────
async function renderSearchPage() {
    // Already rendered via HTML; just focus the input
    document.getElementById('code-search-input')?.focus();
}

// ── CODE SEARCH (Web Worker) ─────────────────────────────────────────────────
// Le worker fait tout le travail CPU hors du thread principal → pas de freeze

const SEARCH_WORKER_SRC = `
self.onmessage = function(e) {
    const { code, query, buildNumber, webJs } = e.data;
    const qLow = query.toLowerCase();
    const CHAR_CTX = 300;  // un peu plus de contexte car le beautify compresse moins
    const MAX_GROUPS = 200;

    // 1. Trouver toutes les positions
    const positions = [];
    let pos = 0;
    const codeLow = code.toLowerCase();
    while (pos < code.length) {
        const idx = codeLow.indexOf(qLow, pos);
        if (idx === -1) break;
        positions.push(idx);
        pos = idx + qLow.length;
        if (positions.length > 5000) break; // hard cap
    }

    if (!positions.length) {
        self.postMessage({ type: 'done', matches: 0, groups: [] });
        return;
    }

    // 2. Grouper les positions proches
    const groups = [];
    let cur = { start: positions[0], end: positions[0] + qLow.length };
    for (let i = 1; i < positions.length; i++) {
        if (positions[i] - cur.end < CHAR_CTX * 2) {
            cur.end = positions[i] + qLow.length;
        } else {
            groups.push(cur);
            cur = { start: positions[i], end: positions[i] + qLow.length };
        }
    }
    groups.push(cur);

    // 3. Extraire les snippets (texte brut, pas de HTML — le main thread fera l'escape)
    const snippets = groups.slice(0, MAX_GROUPS).map(g => {
        const ctxStart = Math.max(0, g.start - CHAR_CTX);
        const ctxEnd   = Math.min(code.length, g.end + CHAR_CTX);
        let raw = code.slice(ctxStart, ctxEnd);
        // Coupure propre au premier ; { ou (
        const cut = raw.search(/[;{(,]/);
        if (cut > 0 && cut < 40) raw = raw.slice(cut + 1);
        return {
            text: raw,
            pct: ((g.start / code.length) * 100).toFixed(1),
            prefix: ctxStart > 0,
            suffix: ctxEnd < code.length,
        };
    });

    self.postMessage({
        type: 'done',
        matches: positions.length,
        totalGroups: groups.length,
        snippets,
        buildNumber,
        webJs,
    });
};
`;

let _searchWorker = null;
function getSearchWorker() {
    if (!_searchWorker) {
        const blob = new Blob([SEARCH_WORKER_SRC], { type: 'application/javascript' });
        _searchWorker = new Worker(URL.createObjectURL(blob));
    }
    return _searchWorker;
}

window.runCodeSearch = async function() {
    const query     = document.getElementById('code-search-input')?.value?.trim();
    const resultsEl = document.getElementById('search-results');
    if (!query) { resultsEl.innerHTML = ''; return; }
    if (query.length < 2) {
        resultsEl.innerHTML = `<div class="diff-status status-empty" style="padding:30px">Tape au moins 2 caractères.</div>`;
        return;
    }

    setHash('search', query);

    const webEntry = changelog.find(e => {
        const wj = (e.files['js']||[]).find(f => f.startsWith('web.'));
        return wj && (e.savedFiles||[]).includes(wj);
    });
    if (!webEntry) {
        resultsEl.innerHTML = `<div class="diff-status status-error" style="padding:40px">Aucun web.js disponible.</div>`;
        return;
    }
    const webJs = (webEntry.files['js']||[]).find(f => f.startsWith('web.'));

    // Download (or use cache)
    const needFetch = !_searchCache || _searchCache.webJs !== webJs;
    if (needFetch) {
        resultsEl.innerHTML = `<div class="assets-loading">
            <div class="loading-spinner"></div>
            <div class="loading-text">Téléchargement de ${webJs}…<br>
            <small style="opacity:.5">(mis en cache — téléchargé une seule fois)</small></div>
        </div>`;
        try {
            const downloaded = await getRawFile(webJs);
            _searchCache = { webJs, buildNumber: webEntry.buildNumber, code: downloaded };
        } catch(err) {
            resultsEl.innerHTML = `<div class="diff-status status-error" style="padding:40px">❌ ${err.message}</div>`;
            return;
        }
    }

    // Show searching indicator
    resultsEl.innerHTML = `<div class="assets-loading" style="padding:24px">
        <div class="loading-spinner"></div>
        <div class="loading-text">Recherche de <strong>"${query}"</strong>…</div>
    </div>`;

    // Run search in Web Worker (non-blocking)
    const worker = getSearchWorker();
    worker.onmessage = (e) => {
        const { matches, totalGroups, snippets, buildNumber, webJs } = e.data;

        if (!matches) {
            resultsEl.innerHTML = `<div class="diff-status status-empty" style="padding:40px">
                Aucun résultat pour <strong>"${query}"</strong> dans ${webJs}.
            </div>`;
            return;
        }

        // Build HTML in main thread (fast — just escaping + highlighting small snippets)
        const escRe = /[&<>]/g;
        const escMap = { '&':'&amp;', '<':'&lt;', '>':'&gt;' };
        const esc = s => s.replace(escRe, c => escMap[c]);
        const hlRe = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const hl   = s => esc(s).replace(hlRe, m => `<mark class="search-hl">${m}</mark>`);

        let html = `<div class="search-meta">
            ${matches} occurrence${matches>1?'s':''}
            en ${totalGroups} bloc${totalGroups>1?'s':''}
            dans <code>${webJs}</code> (build #${buildNumber})
            ${totalGroups > 200 ? ' — affichage limité à 200 blocs' : ''}
        </div>`;

        html += snippets.map(s => {
            // Beautify the small snippet for readability (~400 chars, very fast)
            let text = s.text;
            try { text = js_beautify(text, { indent_size: 2, break_chained_methods: true }); } catch(e) {}
            return `
            <div class="search-result-block">
                <div class="search-result-pos">@ ${s.pct}% du fichier</div>
                <div class="search-ctx-code search-snippet">${s.prefix?'<span class="search-ellipsis">…</span>':''}${hl(text)}${s.suffix?'<span class="search-ellipsis">…</span>':''}</div>
            </div>`;
        }).join('');

        resultsEl.innerHTML = html;
    };

    worker.onerror = (err) => {
        resultsEl.innerHTML = `<div class="diff-status status-error" style="padding:40px">❌ Worker error: ${err.message}</div>`;
    };

    // Send code + query to worker
    worker.postMessage({
        code: _searchCache.code,
        query,
        buildNumber: _searchCache.buildNumber,
        webJs,
    });
};

// ── KEYBOARD SHORTCUTS ────────────────────────────────────────────────────────
function getVisibleCards() {
    return [...document.querySelectorAll('.update-card')].filter(c=>c.style.display!=='none');
}
function focusCard(idx) {
    const cards = getVisibleCards();
    if (!cards.length) return;
    _focusedCard = Math.max(0, Math.min(idx, cards.length-1));
    cards.forEach((c,i)=>c.classList.toggle('keyboard-focused', i===_focusedCard));
    cards[_focusedCard].scrollIntoView({behavior:'smooth',block:'nearest'});
}

document.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    if (tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT') return;
    const mod = e.ctrlKey||e.metaKey;

    if (e.key==='?' || (e.key==='/' && !mod)) {
        e.preventDefault(); showShortcutsHelp(); return;
    }
    if (e.key==='Escape') {
        document.querySelectorAll('.modal-overlay').forEach(m=>m.remove()); return;
    }
    if (activePage !== 'builds') return;

    const cards = getVisibleCards();
    if (e.key==='j'||e.key==='ArrowDown') { e.preventDefault(); focusCard(_focusedCard+1); }
    if (e.key==='k'||e.key==='ArrowUp')   { e.preventDefault(); focusCard(_focusedCard-1); }
    if (e.key==='Enter'||e.key===' ') {
        if (_focusedCard>=0&&_focusedCard<cards.length) {
            e.preventDefault();
            const sha = cards[_focusedCard].dataset.sha;
            toggleCard(sha);
        }
    }
    if (e.key==='d'||e.key==='D') {
        if (_focusedCard>=0&&_focusedCard<cards.length) {
            const card=cards[_focusedCard];
            const firstDiffBtn=card.querySelector('.btn-diff:not(.disabled)');
            if (firstDiffBtn) firstDiffBtn.click();
        }
    }
    if (e.key==='c'&&mod) {
        // Ctrl+F → focus search
        e.preventDefault(); document.getElementById('search-input')?.focus();
    }
});

window.showShortcutsHelp = function() {
    closeModal('shortcuts-modal');
    const overlay=document.createElement('div');
    overlay.id='shortcuts-modal'; overlay.className='modal-overlay';
    overlay.onclick=e=>{if(e.target===overlay)overlay.remove();};
    overlay.innerHTML=`
        <div class="modal-box" style="max-width:400px">
            <div class="modal-header">
                <span class="modal-title">Raccourcis clavier</span>
                <button class="modal-close" onclick="closeModal('shortcuts-modal')">✕</button>
            </div>
            <div style="padding:16px 20px">
                ${[
                    ['J / ↓','Build suivant'],
                    ['K / ↑','Build précédent'],
                    ['Enter / Espace','Ouvrir / fermer le build'],
                    ['D','Ouvrir le diff du premier fichier'],
                    ['Ctrl+F','Focuser la recherche'],
                    ['Escape','Fermer les modals'],
                    ['?','Afficher cette aide'],
                ].map(([k,v])=>`<div class="shortcut-row"><kbd>${k}</kbd><span>${v}</span></div>`).join('')}
            </div>
        </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(()=>overlay.classList.add('visible'));
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
    const container  = document.getElementById('updates-list');
    const statusDot  = document.getElementById('status-dot');
    const lastUpdated= document.getElementById('last-updated');
    const btnRefresh = document.getElementById('btn-refresh');
    btnRefresh.classList.add('loading'); statusDot.className='status-dot';

    try {
        const prevLen = changelog.length;
        changelog = await getChangelog();
        diffCache.clear();
        document.getElementById('page-assets').dataset.loaded   = '';
        document.getElementById('page-features').dataset.loaded = '';
        _searchCache = null;  // invalider le cache si un nouveau build est chargé

        container.innerHTML='';
        changelog.forEach((entry,i) => container.appendChild(createCard(entry,i)));

        document.getElementById('stats-bar').style.display='flex';
        document.getElementById('stat-builds').textContent=`${changelog.length} builds`;
        document.getElementById('stat-files').textContent=`${changelog.reduce((a,e)=>a+(e.savedFiles?.length||0),0)} fichiers`;
        document.getElementById('stat-source').textContent=`github.com/${MY_REPO}`;

        if (changelog.length>0)
            document.getElementById('current-live-id').textContent='#'+changelog[0].buildNumber;

        renderGraph(changelog);

        // Notification in-page si nouveau build détecté
        if (prevLen > 0 && changelog.length > prevLen) {
            const n = changelog.length - prevLen;
            showToast(`🆕 ${n} nouveau${n>1?'x':''} build${n>1?'s':''} détecté${n>1?'s':''}!`);
        }

        statusDot.className='status-dot online';
        lastUpdated.textContent='Mis à jour '+new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});

        // Apply permalink after DOM is ready
        setTimeout(applyPermalink, 100);

    } catch(err) {
        statusDot.className='status-dot error';
        container.innerHTML=`<div class="diff-status status-error" style="padding:60px 20px">❌ ${err.message}</div>`;
    } finally { btnRefresh.classList.remove('loading'); }
}

// ── TOAST NOTIFICATION ────────────────────────────────────────────────────────
function showToast(msg) {
    document.getElementById('dispatch-toast')?.remove();
    const t = document.createElement('div');
    t.id='dispatch-toast'; t.className='dispatch-toast'; t.textContent=msg;
    document.body.appendChild(t);
    requestAnimationFrame(()=>t.classList.add('show'));
    setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=>t.remove(),400); }, 4000);
}

init();
setInterval(init, 5*60*1000);