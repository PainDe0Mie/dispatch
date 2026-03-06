// ═══════════════════════════════════════════════════════════════════════════════
// app.js — Discord Tracker (self-hosted)
// Lit changelog.json et les fichiers assets/ de TON repo GitHub
// Zéro proxy, zéro CORS, zéro Discord CDN — tout vient de raw.githubusercontent.com
// ═══════════════════════════════════════════════════════════════════════════════

// ⚙️  CONFIGURE ICI ton repo GitHub (celui où tu as déployé ce projet)
// Ex: 'lapinou5414/discord-tracker'
const MY_REPO = 'PainDe0Mie/dispatch';  // ← CHANGE ÇA

const RAW   = `https://raw.githubusercontent.com/${MY_REPO}/main`;
const GHAPI = `https://api.github.com/repos/${MY_REPO}`;

const SIZE_FULL = 400_000;
const SIZE_FAST = 4_000_000;

let changelog    = [];
let activeFilter = 'all';
let diffCache    = new Map();

// ── FETCH ─────────────────────────────────────────────────────────────────────
async function getChangelog() {
    const res = await fetch(`${RAW}/static/changelog.json?_=${Date.now()}`);
    if (!res.ok) throw new Error(`changelog.json introuvable (HTTP ${res.status}) — le bot a-t-il déjà tourné ?`);
    return res.json();
}

async function getRawFile(filename) {
    // Les fichiers sont dans assets/ de ton repo
    const url = `${RAW}/assets/${filename}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${filename} pas encore téléchargé par le bot.`);
    return res.text();
}

// ── SMART SPLIT ───────────────────────────────────────────────────────────────
function smartSplit(code) {
    return code
        .replace(/;(?!\s*\n)/g,';\n').replace(/\{/g,'{\n').replace(/\}/g,'\n}\n')
        .replace(/,(?=\s*["'{[`])/g,',\n')
        .split('\n').map(l=>l.trim()).filter(Boolean);
}
const yield2 = () => new Promise(r => setTimeout(r, 0));

// ── NOISE DETECTION ───────────────────────────────────────────────────────────
function isNoisyPair(a, b) {
    if (Math.abs(a.length - b.length) > 3) return false;
    const tok = s => s.match(/[a-zA-Z_$][a-zA-Z0-9_$]*|[0-9]+|"[^"]*"|'[^']*'|[^\s]/g) || [];
    const ta = tok(a), tb = tok(b);
    if (ta.length !== tb.length) return false;
    const diffs = ta.map((t,i)=>t!==tb[i]?{a:t,b:tb[i]}:null).filter(Boolean);
    if (diffs.length === 0 || diffs.length > 4) return diffs.length === 0;
    return diffs.every(d => /^[a-zA-Z_$]{1,2}$/.test(d.a) && /^[a-zA-Z_$]{1,2}$/.test(d.b));
}

function buildChanges(diff) {
    const raw = [];
    diff.forEach(p => {
        if (!p.added && !p.removed) return;
        const type = p.added ? 'add' : 'rem';
        (Array.isArray(p.value) ? p.value : p.value.split('\n'))
            .forEach(line => { if (line.trim()) raw.push({type, line}); });
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

// ── COMPUTE DIFF ─────────────────────────────────────────────────────────────
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

// ── FIND PREVIOUS FILE ────────────────────────────────────────────────────────
// Dans le changelog, cherche la version précédente du même fichier de base
function findPrev(baseName, ext, currentEntryIndex) {
    for (let i = currentEntryIndex + 1; i < changelog.length; i++) {
        const allFiles = Object.values(changelog[i].files).flat();
        const found = allFiles.find(f => {
            const parts = f.split('.');
            return parts[0] === baseName && parts[parts.length-1] === ext;
        });
        if (found) return { filename: found, entryIndex: i };
    }
    return null;
}

// ── RENDER DIFF ───────────────────────────────────────────────────────────────
const BATCH = 500;

function renderDiff(container, allChanges, mode, showNoise) {
    const changes    = showNoise ? allChanges : allChanges.filter(c=>!c.noisy);
    const noisyCount = allChanges.filter(c=>c.noisy).length;
    container.dataset.showNoise = showNoise;

    if (changes.length === 0) {
        container.innerHTML = `<div class="diff-status status-empty">
            ✓ Aucun vrai changement de logique.
            ${noisyCount>0?`<br><span style="opacity:.6;font-size:.78rem">${noisyCount} lignes de bruit (renommage minifieur) masquées</span>
            <br><button class="btn-load-more" style="margin-top:8px" onclick="toggleNoise('${container.id}')">Voir le bruit</button>`:''}
        </div>`; return;
    }
    const added=changes.filter(c=>c.type==='add').length, removed=changes.filter(c=>c.type==='rem').length;
    const modeMap={full:['full','Full ✨'],fast:['fast','Fast ⚡'],preview:['preview','Aperçu ⚠️']};
    const [cls,label]=modeMap[mode]||['fast','Fast'];
    const noiseBtn=noisyCount>0?`<button class="noise-toggle" onclick="toggleNoise('${container.id}')">${showNoise?'🙈 Masquer bruit':`👁 +${noisyCount} bruit`}</button>`:'';

    let html=`<div class="diff-header-bar">
        <div style="display:flex;align-items:center;gap:8px">
            <span class="diff-title">${changes.filter(c=>!c.noisy).length} vrai${changes.length>1?'s':''} changement${changes.length>1?'s':''}</span>
            <span class="diff-mode-badge mode-${cls}">${label}</span>
        </div>
        <div class="diff-stats">
            <span class="diff-stat-add">+${added}</span><span class="diff-stat-rem">−${removed}</span>
            ${noiseBtn}
            <button class="noise-toggle" onclick="copyDiff('${container.id}')">📋 Copier</button>
        </div>
    </div><div class="diff-body" id="${container.id}-body">`;

    changes.slice(0,BATCH).forEach(({type,line,noisy})=>{
        const esc=line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        html+=`<div class="diff-line diff-line-${type==='add'?'add':'rem'}${noisy?' diff-noisy':''}">${esc}</div>`;
    });
    html+=`</div>`;
    container.innerHTML=html;
    if (changes.length>BATCH) appendLoadMore(container,changes,BATCH);
}

function appendLoadMore(container,changes,next) {
    document.getElementById(`lm-${container.id}`)?.remove();
    if (next>=changes.length) return;
    const rem=changes.length-next;
    const d=document.createElement('div');
    d.id=`lm-${container.id}`; d.className='diff-load-more';
    d.innerHTML=`<button class="btn-load-more" onclick="loadMore('${container.id}',${next})">Afficher ${Math.min(BATCH,rem)} de plus (${rem} restantes)</button>`;
    container.appendChild(d);
}
window.loadMore=function(cid,from){
    const c=document.getElementById(cid); if(!c) return;
    const sn=c.dataset.showNoise==='true';
    const all=JSON.parse(c.dataset.diffAll||'[]');
    const ch=sn?all:all.filter(x=>!x.noisy);
    const body=document.getElementById(`${cid}-body`); if(!body) return;
    ch.slice(from,from+BATCH).forEach(({type,line,noisy})=>{
        const el=document.createElement('div');
        el.className=`diff-line diff-line-${type==='add'?'add':'rem'}${noisy?' diff-noisy':''}`;
        el.textContent=line; body.appendChild(el);
    });
    appendLoadMore(c,ch,from+BATCH);
};
window.toggleNoise=function(cid){
    const c=document.getElementById(cid); if(!c) return;
    renderDiff(c,JSON.parse(c.dataset.diffAll||'[]'),c.dataset.diffMode||'fast',c.dataset.showNoise!=='true');
};
window.copyDiff=function(cid){
    const body=document.getElementById(`${cid}-body`); if(!body) return;
    const text=[...body.querySelectorAll('.diff-line')].map(el=>(el.classList.contains('diff-line-add')?'+ ':'- ')+el.textContent).join('\n');
    navigator.clipboard.writeText(text).then(()=>{
        const btns=body.closest('.diff-container')?.querySelectorAll('.noise-toggle');
        const btn=btns?.[btns.length-1]; if(!btn) return;
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
        const {allChanges,mode}=diffCache.get(cacheKey);
        container.dataset.diffAll=JSON.stringify(allChanges); container.dataset.diffMode=mode;
        renderDiff(container,allChanges,mode,false); return;
    }

    const prev = findPrev(baseName, fileExt, entryIndex);
    if (!prev) {
        container.innerHTML=`<div class="diff-status status-error">ℹ️ Pas de version précédente dans le changelog — c'est la première capture de ce fichier.</div>`;
        return;
    }

    container.innerHTML=`<div class="diff-status status-loading">
        <div id="${diffId}-msg">⏳ Chargement depuis GitHub…</div>
        <div class="diff-file-label">${prev.filename} → ${fileName}</div>
        <div class="progress-bar-wrap"><div class="progress-bar"></div></div>
    </div>`;
    const setMsg=msg=>{const el=document.getElementById(`${diffId}-msg`);if(el)el.textContent=msg;};

    try {
        setMsg('⏳ Lecture des deux versions depuis ton repo…');
        const [oldRaw,newRaw] = await Promise.all([getRawFile(prev.filename), getRawFile(fileName)]);
        const sz=((oldRaw.length+newRaw.length)/1024/1024).toFixed(1);
        setMsg(`⚙️ Analyse de ${sz} Mo…`);
        const {diff,mode,truncated} = await computeDiff(oldRaw,newRaw,setMsg);
        const allChanges = buildChanges(diff);
        diffCache.set(cacheKey,{allChanges,mode});
        container.innerHTML='';
        if(truncated) container.insertAdjacentHTML('beforeend',
            `<div class="diff-truncated-warning">⚠ Aperçu : seuls les 300 premiers Ko analysés.</div>`);
        container.dataset.diffAll=JSON.stringify(allChanges); container.dataset.diffMode=mode;
        renderDiff(container,allChanges,mode,false);
    } catch(err) {
        container.innerHTML=`<div class="diff-status status-error">❌ ${err.message}</div>`;
    }
};

window.toggleDiff=function(baseName,fileName,fileExt,entryIndex,diffId,btn){
    const c=document.getElementById(diffId);
    if(c&&c.dataset.visible==='true'){btn.textContent='↕ Diff';btn.classList.remove('active-diff');}
    else{btn.textContent='✕ Fermer';btn.classList.add('active-diff');}
    showDiff(baseName,fileName,fileExt,entryIndex,diffId);
};

// ── BUILD CARDS ───────────────────────────────────────────────────────────────
function relTime(dateStr) {
    const d=Date.now()-new Date(dateStr);
    const m=Math.floor(d/60000);
    if(m<1) return 'à l\'instant';
    if(m<60) return `il y a ${m} min`;
    const h=Math.floor(m/60);
    if(h<24) return `il y a ${h}h`;
    return `il y a ${Math.floor(h/24)}j`;
}

function createCard(entry, entryIndex) {
    const sha    = entry.sha;
    const date   = new Date(entry.date).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
    const jsFiles  = entry.files['js']||[];
    const cssFiles = entry.files['css']||[];
    const otherFiles = [...(entry.files['worker']||[]),(entry.files['asset']||[]),(entry.files['manifest']||[])].flat();
    const allFiles   = [...jsFiles,...cssFiles,...otherFiles];
    const savedSet   = new Set(entry.savedFiles||[]);

    let badges='';
    if(jsFiles.length)    badges+=`<span class="count-badge count-js">${jsFiles.length} JS</span>`;
    if(cssFiles.length)   badges+=`<span class="count-badge count-css">${cssFiles.length} CSS</span>`;
    if(otherFiles.length) badges+=`<span class="count-badge count-other">${otherFiles.length} autres</span>`;

    function fileSection(files,type,dotClass,label) {
        if(!files.length) return '';
        let html=`<div class="section-label">${label} <span class="section-count">${files.length}</span></div>`;
        files.forEach(fileName=>{
            const parts=fileName.split('.');
            const baseName=parts[0], fileExt=parts[parts.length-1], hash=parts.length>2?parts[1]:'';
            const diffId=`d-${sha.slice(0,7)}-${fileName.replace(/[^a-zA-Z0-9]/g,'_')}`;
            const isCode=type==='js'||type==='css';
            const isSaved=savedSet.has(fileName);

            html+=`
                <div class="file-row">
                    <div class="file-type-dot ${dotClass}"></div>
                    <div class="file-info">
                        <span class="file-basename">${baseName}</span>
                        ${hash?`<span class="file-hash">.${hash}</span>`:''}
                        <span class="file-ext">.${fileExt}</span>
                    </div>
                    <div class="file-status-dot" title="${isSaved?'Fichier sauvegardé':'Non sauvegardé'}">${isSaved?'✓':'⚠'}</div>
                    <div class="file-actions">
                        ${isCode&&isSaved?`<button class="btn-diff" id="btn-${diffId}"
                            onclick="toggleDiff('${baseName}','${fileName}','${fileExt}',${entryIndex},'${diffId}',this)">↕ Diff</button>`:''}
                        ${isCode&&!isSaved?`<span class="btn-diff disabled" title="Fichier non encore téléchargé">↕ Diff</span>`:''}
                        <a class="btn-icon-link" href="https://github.com/${MY_REPO}/blob/main/assets/${fileName}" target="_blank" title="Voir dans GitHub">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.73.084-.73 1.205.085 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12"/></svg>
                        </a>
                    </div>
                </div>
                <div class="diff-container" id="${diffId}" style="display:none;"></div>`;
        });
        return html;
    }

    const allHTML=fileSection(jsFiles,'js','dot-js','JavaScript')+fileSection(cssFiles,'css','dot-css','Stylesheet')+fileSection(otherFiles,'other','dot-other','Autres');

    const card=document.createElement('div');
    card.className='update-card';
    card.dataset.sha=sha; card.dataset.files=allFiles.join(',');
    card.dataset.jsHTML=fileSection(jsFiles,'js','dot-js','JavaScript');
    card.dataset.cssHTML=fileSection(cssFiles,'css','dot-css','Stylesheet');
    card.dataset.otherHTML=fileSection(otherFiles,'other','dot-other','Autres');
    card.dataset.allHTML=allHTML;

    const savedCount=entry.savedFiles?.length||0;
    const savedBadge=`<span class="saved-badge" title="${savedCount}/${allFiles.length} fichiers téléchargés">${savedCount}/${allFiles.length} ✓</span>`;

    card.innerHTML=`
        <div class="card-header" onclick="toggleCard('${sha}')">
            <div class="card-header-left">
                <span class="build-number">#${entry.buildNumber}</span>
                <div class="card-meta">
                    <span class="card-title">${allFiles.length} fichier${allFiles.length>1?'s':''} · ${savedBadge}</span>
                    <span class="card-date" title="${date}">${relTime(entry.date)} · ${date}</span>
                </div>
            </div>
            <div class="card-header-right">
                <div class="file-counts">${badges}</div>
                <svg class="toggle-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
        </div>
        <div class="files-panel" id="panel-${sha}">
            <div class="panel-tabs" id="tabs-${sha}">
                <button class="panel-tab active" onclick="switchTab('${sha}','all',this)">Tous (${allFiles.length})</button>
                ${jsFiles.length?`<button class="panel-tab" onclick="switchTab('${sha}','js',this)">JS (${jsFiles.length})</button>`:''}
                ${cssFiles.length?`<button class="panel-tab" onclick="switchTab('${sha}','css',this)">CSS (${cssFiles.length})</button>`:''}
            </div>
            <div class="panel-content" id="content-${sha}">${allHTML}</div>
        </div>`;
    return card;
}

window.toggleCard=function(sha){const p=document.getElementById(`panel-${sha}`);p.closest('.update-card').querySelector('.toggle-arrow').classList.toggle('open',p.classList.toggle('open'));};
window.switchTab=function(sha,type,tabEl){const card=document.getElementById(`panel-${sha}`).closest('.update-card');document.getElementById(`tabs-${sha}`).querySelectorAll('.panel-tab').forEach(t=>t.classList.remove('active'));tabEl.classList.add('active');document.getElementById(`content-${sha}`).innerHTML=({all:card.dataset.allHTML,js:card.dataset.jsHTML,css:card.dataset.cssHTML})[type]||'';};
window.setFilter=function(type,btn){activeFilter=type;document.querySelectorAll('.filter-tab').forEach(b=>b.classList.remove('active'));btn.classList.add('active');filterCards();};
window.filterCards=function(){const q=document.getElementById('search-input').value.toLowerCase().trim();let v=0;document.querySelectorAll('.update-card').forEach(c=>{const t=(c.dataset.sha+' '+c.dataset.files).toLowerCase();const f=c.dataset.files;const mQ=!q||t.includes(q);const mT=activeFilter==='all'||(activeFilter==='js'&&f.includes('.js'))||(activeFilter==='css'&&f.includes('.css'));const show=mQ&&mT;c.style.display=show?'':'none';if(show)v++;});let nr=document.getElementById('no-results');if(!v&&!nr){nr=document.createElement('div');nr.id='no-results';nr.className='no-results';nr.textContent='Aucun résultat.';document.getElementById('updates-list').appendChild(nr);}else if(v&&nr)nr.remove();};

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
    const container=document.getElementById('updates-list');
    const statusDot=document.getElementById('status-dot');
    const lastUpdated=document.getElementById('last-updated');
    const btnRefresh=document.getElementById('btn-refresh');
    btnRefresh.classList.add('loading'); statusDot.className='status-dot';

    if (MY_REPO === 'TON_USERNAME/TON_REPO') {
        container.innerHTML=`<div class="diff-status status-error" style="padding:40px 20px;line-height:2">
            ⚙️ Configure ton repo dans <code style="background:var(--bg-raised);padding:2px 6px;border-radius:4px">app.js</code> ligne 12 :<br>
            <code style="background:var(--bg-raised);padding:4px 10px;border-radius:4px;font-size:0.9rem">const MY_REPO = 'ton-username/ton-repo';</code>
        </div>`;
        btnRefresh.classList.remove('loading'); return;
    }

    try {
        changelog = await getChangelog();
        diffCache.clear();
        container.innerHTML='';
        changelog.forEach((entry,i) => container.appendChild(createCard(entry,i)));
        document.getElementById('stats-bar').style.display='flex';
        document.getElementById('stat-builds').textContent=`${changelog.length} builds`;
        document.getElementById('stat-files').textContent=`${changelog.reduce((a,e)=>a+(e.savedFiles?.length||0),0)} fichiers`;
        document.getElementById('stat-source').textContent=`github.com/${MY_REPO}`;
        statusDot.className='status-dot online';
        lastUpdated.textContent='Mis à jour '+new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
    } catch(err) {
        statusDot.className='status-dot error';
        container.innerHTML=`<div class="diff-status status-error" style="padding:60px 20px">❌ ${err.message}</div>`;
    } finally { btnRefresh.classList.remove('loading'); }
}

init();
setInterval(init, 5*60*1000);
