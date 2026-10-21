(() => {
  'use strict';

  const cfg = window.FAMILY_TREE_CONFIG || {};
  const siteTitle = cfg.siteTitle || 'Family Tree';
  const $app = document.getElementById('app');
  const $modal = document.getElementById('modal');
  const $modalBody = document.getElementById('modal-body');
  const $toasts = document.getElementById('toasts');

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  // Language. English text is written in place; t() swaps in the Nepali from i18n.js,
  // which is keyed by the English. {name}-style slots are filled from vars.
  const NE = window.FAMILY_TREE_NE || {};
  let lang = (() => { try { return localStorage.getItem('lang') === 'ne' ? 'ne' : 'en'; } catch { return 'en'; } })();
  const NE_DIGITS = '०१२३४५६७८९';
  const num = (v) => (lang === 'ne' && typeof v === 'number' ? String(v).replace(/\d/g, (d) => NE_DIGITS[d]) : v);
  const t = (s, vars) => {
    const out = (lang === 'ne' && NE[s]) || s;
    return vars ? out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? num(vars[k]) : m)) : out;
  };
  // Site name and welcome line. Admins change them on the Members & roles page; they are
  // kept in the site_settings table (cached here so the name shows at once on the next visit).
  const DEFAULT_TAGLINE = 'A private space for our family to record who we are and where we come from.';
  let site = (() => { try { return JSON.parse(localStorage.getItem('site') || 'null') || {}; } catch { return {}; } })();
  const siteName = () => (lang === 'ne' && site.title_ne) || t(site.title_en || siteTitle);
  const siteTagline = () => (lang === 'ne' && site.tagline_ne) || site.tagline_en || t(DEFAULT_TAGLINE);
  function setSite(next) {
    site = next || {};
    try { localStorage.setItem('site', JSON.stringify(site)); } catch { /* private mode */ }
    document.title = siteName();
  }
  document.documentElement.lang = lang;
  document.title = siteName();

  if (!cfg.supabaseUrl || cfg.supabaseUrl.startsWith('YOUR_') || !cfg.supabaseAnonKey || cfg.supabaseAnonKey.startsWith('YOUR_')) {
    $app.innerHTML = `
      <div class="center-screen"><div class="panel narrow">
        <h1>Almost ready</h1>
        <p>Open <code>config.js</code> and paste your Supabase project URL and anon key.
        The steps are in <code>README.md</code>.</p>
      </div></div>`;
    return;
  }
  if (!window.supabase) {
    $app.innerHTML = `<div class="center-screen"><div class="panel narrow"><h1>${t('Could not load')}</h1><p>${t('Check your internet connection and reload the page.')}</p></div></div>`;
    return;
  }

  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const PHOTO_BUCKET = 'photos';

  const state = {
    session: null,
    profile: null,
    persons: [],
    byId: new Map(),
    kids: new Map(),
    spouses: new Map(),
    zoom: 1,
    treeMode: (() => { try { return localStorage.getItem('treeMode') || 'chart'; } catch { return 'chart'; } })(),
    photos: new Map(),
    collapsed: new Set(),
    view: 'tree',
    recovering: false,
    screen: null, // which top-level screen is showing, so a language switch can redraw it
    authMode: 'login',
  };

  const uid = () => state.session?.user?.id;
  // Roles, most powerful first. Kept in step with the database rules in supabase-schema.sql.
  const ROLES = {
    admin: { label: 'Admin', can: ['See the whole tree', 'Add people and new top ancestors', 'Edit and delete anyone', 'Approve members and change roles'] },
    editor: { label: 'Editor', can: ['See the whole tree', 'Add people and new top ancestors', 'Edit and delete anyone'] },
    member: { label: 'Member', can: ['See the whole tree', 'Add people', 'Edit themselves and people they added'] },
    viewer: { label: 'Viewer', can: ['See the whole tree'] },
  };
  const roleLabel = (k) => t(ROLES[k].label);
  const role = () => state.profile?.role || 'member';
  const isAdmin = () => role() === 'admin';
  const canEditAll = () => role() === 'admin' || role() === 'editor';
  const canContribute = () => role() !== 'viewer';
  const myPerson = () => state.persons.find((p) => p.user_id && p.user_id === uid());
  const canEdit = (p) => canEditAll() || (canContribute() && (p.created_by === uid() || p.user_id === uid()));

  // ---------------------------------------------------------------- helpers

  function toast(msg, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $toasts.appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4000);
  }

  function friendlyError(err) {
    const m = err?.message || String(err);
    if (/persons_user_idx|duplicate key/i.test(m)) return t('Your account is already linked to another person in the tree.');
    if (/row-level security/i.test(m)) return t('You do not have permission to do that.');
    if (/foreign key|violates.*persons_parent/i.test(m)) return t('This person still has children in the tree.');
    if (/sending.*email|smtp/i.test(m)) return t("We couldn't send the email right now. Please try again later or ask the family admin.");
    return m;
  }

  // Spouses married into the family: they hang off their partner instead of a parent.
  const isSpouse = (p) => !!p?.spouse_of;
  const partnerOf = (p) => (isSpouse(p) ? state.byId.get(p.spouse_of) : null);
  const inLine = (p) => partnerOf(p) || p; // the family-line person for p
  const generation = (p) => lineage(inLine(p)).length;
  const spousesOf = (id) => state.spouses.get(id) || [];
  function relationTo(s) { // "Wife of …" / "Husband of …" for a spouse
    const partner = partnerOf(s);
    const word = s.gender === 'female' ? 'Wife' : s.gender === 'male' ? 'Husband' : 'Spouse';
    return partner ? t(`${word} of {name}`, { name: partner.full_name }) : t(word);
  }
  // Children of a spouse are the partner's children with this spouse as other parent.
  function childrenOf(p) {
    if (isSpouse(p)) return (state.kids.get(p.spouse_of) || []).filter((k) => k.other_parent_id === p.id);
    return state.kids.get(p.id) || [];
  }

  function lineage(p) {
    if (isSpouse(p) && partnerOf(p)) return [...lineage(partnerOf(p)), p];
    const out = [];
    const seen = new Set();
    let cur = p;
    while (cur && !seen.has(cur.id)) {
      out.unshift(cur);
      seen.add(cur.id);
      cur = cur.parent_id ? state.byId.get(cur.parent_id) : null;
    }
    return out;
  }

  function descendants(id) {
    const found = new Set();
    const stack = [id];
    while (stack.length) {
      for (const k of state.kids.get(stack.pop()) || []) {
        if (!found.has(k.id)) { found.add(k.id); stack.push(k.id); }
      }
    }
    return found;
  }

  const year = (d) => (d ? String(num(Number(String(d).slice(0, 4)))) : '');
  function lifespan(p) {
    const b = year(p.birth_date);
    const d = year(p.death_date);
    if (!p.is_living) return b || d ? `${b || '?'} – ${d || '?'}` : t('Late');
    return b ? t('b. {year}', { year: b }) : '';
  }

  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  }

  function avatar(p, cls = '') {
    const url = p.photo_path && state.photos.get(p.photo_path);
    return url
      ? `<img class="avatar ${cls}" src="${esc(url)}" alt="" loading="lazy">`
      : `<span class="avatar initials ${cls}" aria-hidden="true">${esc(initials(p.full_name))}</span>`;
  }

  // Nepali dates are built by hand: many phones' browsers have no Nepali date format.
  const NE_MONTHS = ['जनवरी', 'फेब्रुअरी', 'मार्च', 'अप्रिल', 'मे', 'जुन', 'जुलाई', 'अगस्ट', 'सेप्टेम्बर', 'अक्टोबर', 'नोभेम्बर', 'डिसेम्बर'];
  function fmtDate(d, month = 'long') {
    if (!d) return '';
    const dt = new Date(String(d).length > 10 ? d : `${d}T00:00:00`);
    if (lang === 'ne') return `${num(dt.getDate())} ${NE_MONTHS[dt.getMonth()]} ${num(dt.getFullYear())}`;
    return dt.toLocaleDateString(undefined, { year: 'numeric', month, day: 'numeric' });
  }
  const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][((n % 100) - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  const genShort = (n) => t('{nth} gen', { nth: ordinal(n), n });
  const genLong = (n) => t('{nth} generation', { nth: ordinal(n), n });

  async function resizeImage(file, max = 900) {
    let img;
    try { img = await createImageBitmap(file); } catch {
      throw new Error(t('Could not read that image. Please choose a JPG or PNG photo.'));
    }
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error(t('Could not process that image.')))), 'image/jpeg', 0.85,
    ));
  }

  // ---------------------------------------------------------------- data

  async function loadPersons() {
    const { data, error } = await sb.from('persons').select('*')
      .order('birth_date', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true });
    if (error) throw error;
    state.persons = data || [];
    state.byId = new Map(state.persons.map((p) => [p.id, p]));
    state.kids = new Map();
    state.spouses = new Map();
    for (const p of state.persons) {
      if (p.spouse_of && state.byId.has(p.spouse_of)) {
        if (!state.spouses.has(p.spouse_of)) state.spouses.set(p.spouse_of, []);
        state.spouses.get(p.spouse_of).push(p);
        continue;
      }
      const key = p.parent_id && state.byId.has(p.parent_id) ? p.parent_id : null;
      if (!state.kids.has(key)) state.kids.set(key, []);
      state.kids.get(key).push(p);
    }
    // Group each family's children by their other parent so lines from each couple stay together.
    for (const [id, kids] of state.kids) {
      if (!id) continue;
      const order = spousesOf(id).map((x) => x.id);
      kids.sort((a, b) => (order.indexOf(a.other_parent_id) >>> 0) - (order.indexOf(b.other_parent_id) >>> 0));
    }
    state.photos = new Map();
    const paths = state.persons.map((p) => p.photo_path).filter(Boolean);
    if (paths.length) {
      const { data: urls } = await sb.storage.from(PHOTO_BUCKET).createSignedUrls(paths, 60 * 60 * 6);
      for (const u of urls || []) if (u.signedUrl) state.photos.set(u.path, u.signedUrl);
    }
  }

  // ---------------------------------------------------------------- routing

  let lastUid;
  sb.auth.onAuthStateChange((event, session) => {
    state.session = session;
    const id = session?.user?.id ?? null;
    if (event === 'PASSWORD_RECOVERY') state.recovering = true;
    else if (event !== 'INITIAL_SESSION' && id === lastUid) return;
    lastUid = id;
    setTimeout(route, 0);
  });

  // Read the site name before the first screen; if the table isn't there yet, keep the built-in name.
  const siteLoaded = sb.from('site_settings').select('*').eq('id', 1).maybeSingle()
    .then(({ data }) => { if (data) setSite(data); })
    .catch(() => {});

  async function route() {
    await siteLoaded;
    if (state.recovering) return renderRecovery();
    if (!state.session) return renderAuth('login');
    const { data, error } = await sb.from('profiles').select('*').eq('id', uid()).maybeSingle();
    if (error) return renderMessage(t('Something went wrong'), error.message);
    state.profile = data;
    if (!data || data.status !== 'approved') return renderPending(data);
    try {
      await loadPersons();
    } catch (e) {
      return renderMessage(t('Could not load the family tree'), friendlyError(e));
    }
    renderApp();
  }

  function renderMessage(title, body) {
    state.screen = 'message';
    chatSync();
    $app.innerHTML = `
      <div class="center-screen"><div class="panel narrow">
        ${langRow()}
        <h1>${esc(title)}</h1><p>${esc(body)}</p>
        <div class="actions"><button class="btn" data-action="logout">${t('Log out')}</button></div>
      </div></div>`;
  }

  // ---------------------------------------------------------------- auth screens

  function langSwitch() {
    const b = (code, label) => `<button type="button" class="${lang === code ? 'on' : ''}" data-action="lang" data-lang="${code}" lang="${code}" aria-pressed="${lang === code}">${label}</button>`;
    return `<div class="seg lang-switch" role="group" aria-label="${t('Language')}">${b('en', 'English')}${b('ne', 'नेपाली')}</div>`;
  }
  const langRow = () => `<div class="lang-row">${langSwitch()}</div>`;

  function brandBlock() {
    return `
      <div class="brand-block">
        <svg class="brand-mark" viewBox="0 0 48 48" aria-hidden="true"><path d="M24 44V26M24 26c-6 0-11-4-11-10 0-5 4-9 9-9 1-3 4-5 7-4 4 1 7 4 7 8 3 1 5 4 4 8-1 4-5 7-9 7h-7zM24 34l-6-4M24 30l6-3" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <h1>${esc(siteName())}</h1>
        <p class="muted">${esc(siteTagline())}</p>
      </div>`;
  }

  function renderAuth(mode) {
    state.screen = 'auth';
    chatSync();
    state.authMode = mode;
    const pwToggle = `<button type="button" class="pw-toggle" data-action="toggle-pw" aria-label="${t('Show password')}">${t('Show')}</button>`;
    const tabs = `
      <div class="seg" role="tablist">
        <button role="tab" class="${mode === 'login' ? 'on' : ''}" data-action="auth-mode" data-mode="login">${t('Log in')}</button>
        <button role="tab" class="${mode === 'signup' ? 'on' : ''}" data-action="auth-mode" data-mode="signup">${t('Become a member')}</button>
      </div>`;
    let form;
    if (mode === 'login') {
      form = `
        <form id="login-form" class="stack">
          <label>${t('Email')}<input name="email" type="email" required autocomplete="email" autocapitalize="off" enterkeyhint="next"></label>
          <label>${t('Password')}<span class="pw-wrap"><input name="password" type="password" required autocomplete="current-password" enterkeyhint="go">${pwToggle}</span></label>
          <button class="btn primary" type="submit">${t('Log in')}</button>
          <button class="link" type="button" data-action="auth-mode" data-mode="forgot">${t('Forgot password?')}</button>
        </form>`;
    } else if (mode === 'signup') {
      form = `
        <form id="signup-form" class="stack">
          <label>${t('Full name')}<input name="full_name" required autocomplete="name"></label>
          <label>${t('Email')}<input name="email" type="email" required autocomplete="email" autocapitalize="off" enterkeyhint="next"></label>
          <label>${t('Password')}<span class="pw-wrap"><input name="password" type="password" required minlength="8" autocomplete="new-password" enterkeyhint="go">${pwToggle}</span><small class="muted">${t('At least 8 characters.')}</small></label>
          <button class="btn primary" type="submit">${t('Request membership')}</button>
          <p class="muted small">${t('A family admin will check and approve your account before you can see the tree.')}</p>
        </form>`;
    } else {
      form = `
        <form id="forgot-form" class="stack">
          <p class="muted">${t('Enter your email and we will send you a link to set a new password.')}</p>
          <label>${t('Email')}<input name="email" type="email" required autocomplete="email" autocapitalize="off" enterkeyhint="next"></label>
          <button class="btn primary" type="submit">${t('Send reset link')}</button>
          <button class="link" type="button" data-action="auth-mode" data-mode="login">${t('Back to log in')}</button>
        </form>`;
    }
    $app.innerHTML = `
      <div class="center-screen"><div class="panel narrow auth">
        ${langRow()}
        ${brandBlock()}
        ${mode === 'forgot' ? '' : tabs}
        ${form}
      </div></div>`;
  }

  function renderRecovery() {
    state.screen = 'recovery';
    chatSync();
    $app.innerHTML = `
      <div class="center-screen"><div class="panel narrow">
        ${langRow()}
        <h1>${t('Set a new password')}</h1>
        <form id="recovery-form" class="stack">
          <label>${t('New password')}<span class="pw-wrap"><input name="password" type="password" required minlength="8" autocomplete="new-password" enterkeyhint="go"><button type="button" class="pw-toggle" data-action="toggle-pw" aria-label="${t('Show password')}">${t('Show')}</button></span></label>
          <button class="btn primary" type="submit">${t('Save password')}</button>
        </form>
      </div></div>`;
  }

  function renderPending(profile) {
    state.screen = 'pending';
    chatSync();
    const name = profile?.full_name || state.session.user.email;
    const body = profile?.status === 'rejected'
      ? `<p>${t('Your membership request was not approved. If you think this is a mistake, please contact the family admin.')}</p>`
      : `<p>${t('Thank you for joining. A family admin needs to confirm who you are before you can see and add to the tree.')}</p>
         <p class="muted">${t('Come back later, or press <b>Check again</b> once the admin tells you that you are approved.')}</p>`;
    $app.innerHTML = `
      <div class="center-screen"><div class="panel narrow">
        ${langRow()}
        <span class="pill ${profile?.status === 'rejected' ? 'bad' : 'wait'}">${profile?.status === 'rejected' ? t('Not approved') : t('Waiting for approval')}</span>
        <h1>${t('Namaste, {name}', { name: esc(name) })}</h1>
        ${body}
        <div class="actions">
          <button class="btn" data-action="logout">${t('Log out')}</button>
          <button class="btn primary" data-action="recheck">${t('Check again')}</button>
        </div>
      </div></div>`;
  }

  // ---------------------------------------------------------------- main layout

  function renderApp() {
    state.screen = 'app';
    const p = state.profile;
    if ((state.view === 'connect' && (myPerson() || !canContribute()))
      || (state.view === 'form' && !canContribute())
      || (state.view === 'admin' && !isAdmin())) state.view = 'tree';
    const nav = [
      ['tree', t('Family tree')],
      ...(myPerson() || !canContribute() ? [] : [['connect', t('Connect me')]]),
      ...(canContribute() ? [['form', t('Add person')]] : []),
      ...(isAdmin() ? [['admin', t('Members & roles')]] : []),
    ];
    $app.innerHTML = `
      <header class="topbar">
        <div class="brand"><svg class="brand-mark sm" viewBox="0 0 48 48" aria-hidden="true"><path d="M24 44V26M24 26c-6 0-11-4-11-10 0-5 4-9 9-9 1-3 4-5 7-4 4 1 7 4 7 8 3 1 5 4 4 8-1 4-5 7-9 7h-7z" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>${esc(siteName())}</div>
        <nav class="tabs">
          ${nav.map(([v, label]) => `<button class="${state.view === v ? 'on' : ''}" data-action="view" data-view="${v}">${label}</button>`).join('')}
        </nav>
        <div class="who">
          <span class="who-name">${esc(p.full_name || p.email)} <span class="pill tiny role-${role()}">${roleLabel(role())}</span></span>
          ${langSwitch()}
          <button class="btn ghost sm" data-action="logout">${t('Log out')}</button>
        </div>
      </header>
      <main id="main"></main>`;
    renderView();
    chatSync();
  }

  function setView(v, opts) {
    state.view = v;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    renderView(opts);
    window.scrollTo(0, 0);
  }

  function renderView(opts = {}) {
    if (state.view === 'admin') return renderAdmin();
    if (state.view === 'form') return renderForm(opts);
    if (state.view === 'connect') return renderConnect();
    return renderTree();
  }

  // ---------------------------------------------------------------- tree

  function renderTree() {
    const main = document.getElementById('main');
    const me = myPerson();
    const gens = state.persons.filter((p) => !isSpouse(p)).reduce((m, p) => Math.max(m, lineage(p).length), 0);
    const chart = state.treeMode === 'chart';
    main.innerHTML = `
      <section class="toolbar">
        <div class="search">
          <input id="search" type="search" placeholder="${t('Search for a name…')}" autocomplete="off" aria-label="${t('Search for a name…')}">
          <div id="results" class="results" hidden></div>
        </div>
        <div class="tool-btns">
          ${me ? `<button class="btn sm" data-action="find-me">${t('Find me')}</button>
            <button class="btn primary sm" data-action="edit" data-id="${me.id}">✎ ${t('Edit my details')}</button>` : ''}
        </div>
      </section>
      ${me || !canContribute() ? '' : `<div class="callout">
          <div><b>${t("You're not in the tree yet.")}</b> ${t("Answer a few questions about yourself and your parents, and we'll find where you connect to the family.")}</div>
          <button class="btn primary sm" data-action="view" data-view="connect">${t('Connect me to the tree')}</button>
        </div>`}
      <div class="tree-bar">
        <div class="seg two-way" role="group" aria-label="${t('Tree layout')}">
          <button class="${chart ? 'on' : ''}" data-action="tree-mode" data-mode="chart" aria-pressed="${chart}">${t('Family chart')}</button>
          <button class="${chart ? '' : 'on'}" data-action="tree-mode" data-mode="list" aria-pressed="${!chart}">${t('List')}</button>
        </div>
        <span class="stats muted">${t(state.persons.length === 1 ? '{n} person' : '{n} people', { n: state.persons.length })} · ${t(gens === 1 ? '{n} generation' : '{n} generations', { n: gens })}</span>
        <div class="tool-btns">
          ${chart ? `<button class="btn ghost sm icon" data-action="zoom" data-dir="-1" aria-label="${t('Zoom out')}">−</button>
          <button class="btn ghost sm icon" data-action="zoom" data-dir="1" aria-label="${t('Zoom in')}">+</button>
          <button class="btn ghost sm" data-action="zoom" data-dir="0">${t('Fit')}</button>` : ''}
          <button class="btn ghost sm" data-action="expand-all">${t('Expand all')}</button>
          <button class="btn ghost sm" data-action="collapse-all">${t('Collapse all')}</button>
        </div>
      </div>
      <div class="${chart ? 'tree-host' : 'tree'}" id="tree"></div>`;
    if (chart && !state.zoomSet) { state.zoom = window.innerWidth < 600 ? 0.7 : 1; state.zoomSet = true; }
    renderTreeBody({ center: true });
  }

  function renderTreeBody({ center = false } = {}) {
    const el = document.getElementById('tree');
    if (!el) return;
    const roots = state.kids.get(null) || [];
    if (!roots.length) { el.innerHTML = `<p class="muted">${t('No one is in the tree yet.')}</p>`; return; }
    if (state.treeMode !== 'chart') {
      el.innerHTML = `<ul>${roots.map((r) => nodeHtml(r, 1)).join('')}</ul>`;
      return;
    }
    const wrap = document.getElementById('chart-wrap');
    const keep = wrap && !center ? { left: wrap.scrollLeft, top: wrap.scrollTop } : null;
    el.innerHTML = `
      <div class="chart-wrap" id="chart-wrap">
        <div class="chart-sizer" id="chart-sizer">
          <div class="chart" id="chart-inner">
            <svg class="links" id="chart-links" aria-hidden="true"></svg>
            <ul>${roots.map((r) => unitHtml(r, 1)).join('')}</ul>
          </div>
        </div>
      </div>`;
    layoutChart();
    const w = document.getElementById('chart-wrap');
    if (keep) { w.scrollLeft = keep.left; w.scrollTop = keep.top; } else {
      const first = document.querySelector('#chart-inner .unit');
      if (first) w.scrollLeft = Math.max(0, (first.offsetLeft + first.offsetWidth / 2) * state.zoom - w.clientWidth / 2);
    }
  }

  // One person card for the chart.
  function pcard(p, gen) {
    const mine = p.user_id && p.user_id === uid();
    const spouse = isSpouse(p);
    const tag = spouse ? t(p.gender === 'female' ? 'Wife' : p.gender === 'male' ? 'Husband' : 'Spouse') : genShort(gen);
    return `
      <button class="pcard ${p.gender || ''}${spouse ? ' spouse' : ''}${mine ? ' me' : ''}${p.is_living ? '' : ' late'}"
        data-action="open" data-id="${p.id}" id="n-${p.id}">
        ${avatar(p, 'lg')}
        <span class="pc-name">${esc(p.full_name)}</span>
        <span class="pc-meta">${esc(lifespan(p)) || '&nbsp;'}</span>
        <span class="pc-tag">${mine ? `<b>${t('You')}</b> · ` : ''}${tag}</span>
      </button>`;
  }

  // A family unit: the person, their spouse(s) beside them, and their children below.
  function unitHtml(p, gen) {
    const sp = spousesOf(p.id);
    const kids = state.kids.get(p.id) || [];
    const open = !state.collapsed.has(p.id);
    return `
      <li>
        <div class="unit" data-id="${p.id}">
          ${pcard(p, gen)}
          ${sp.map((s) => `<span class="wed" aria-hidden="true"><i></i></span>${pcard(s, gen)}`).join('')}
        </div>
        ${kids.length ? `<button class="kids-toggle" data-action="toggle" data-id="${p.id}" aria-expanded="${open}"
          aria-label="${t(open ? 'Hide children of {name}' : 'Show children of {name}', { name: esc(p.full_name) })}">${open ? '−' : '+'} ${num(kids.length)}</button>` : ''}
        ${kids.length && open ? `<ul>${kids.map((k) => unitHtml(k, gen + 1)).join('')}</ul>` : ''}
      </li>`;
  }

  // Size the zoomed chart and draw the lines: from both parents' boxes down to a
  // shared point, then an arrow to each child.
  function layoutChart() {
    const inner = document.getElementById('chart-inner');
    const sizer = document.getElementById('chart-sizer');
    const svg = document.getElementById('chart-links');
    if (!inner || !svg) return;
    const z = state.zoom;
    inner.style.transform = `scale(${z})`;
    const W = inner.offsetWidth;
    const H = inner.offsetHeight;
    sizer.style.width = `${W * z}px`;
    sizer.style.height = `${H * z}px`;
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const base = inner.getBoundingClientRect();
    const box = (el) => {
      const r = el.getBoundingClientRect();
      const x = (r.left - base.left) / z;
      const y = (r.top - base.top) / z;
      const w = r.width / z;
      const h = r.height / z;
      return { cx: x + w / 2, top: y, bottom: y + h };
    };
    let couples = '';
    let arrows = '';
    inner.querySelectorAll('.unit').forEach((unit) => {
      const kidsUl = unit.parentElement.querySelector(':scope > ul');
      if (!kidsUl) return;
      const cards = [...unit.querySelectorAll(':scope > .pcard')];
      const main = box(cards[0]);
      const spouseEls = cards.slice(1);
      const coupleY = main.bottom + 18;
      const kidCards = [...kidsUl.querySelectorAll(':scope > li > .unit > .pcard:first-child')];
      if (!kidCards.length) return;
      const groups = new Map();
      for (const c of kidCards) {
        const kid = state.byId.get(c.dataset.id);
        const sEl = spouseEls.find((e) => e.dataset.id === kid?.other_parent_id)
          || (spouseEls.length === 1 && !kid?.other_parent_id ? spouseEls[0] : null);
        const key = sEl ? sEl.dataset.id : '';
        if (!groups.has(key)) groups.set(key, { sEl, kids: [] });
        groups.get(key).kids.push(box(c));
      }
      let gi = 0;
      for (const { sEl, kids } of groups.values()) {
        const top = Math.min(...kids.map((k) => k.top));
        const busY = top - 22 - gi * 8;
        let sx = main.cx;
        let startY = main.bottom;
        if (sEl) {
          const s = box(sEl);
          sx = (main.cx + s.cx) / 2;
          startY = coupleY;
          couples += `M${main.cx},${main.bottom}V${coupleY}H${s.cx}V${s.bottom}`;
        }
        for (const k of kids) arrows += `<path d="M${sx},${startY}V${busY}H${k.cx}V${k.top - 3}" marker-end="url(#arrowhead)"/>`;
        gi += 1;
      }
    });
    svg.innerHTML = `
      <defs><marker id="arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0,0 L10,5 L0,10 z"/></marker></defs>
      <path class="couple" d="${couples}"/>
      <g class="desc">${arrows}</g>`;
  }

  function setZoom(dir) {
    const wrap = document.getElementById('chart-wrap');
    const inner = document.getElementById('chart-inner');
    if (!wrap || !inner) return;
    const old = state.zoom;
    let z = dir === 0
      ? Math.min(1, (wrap.clientWidth - 8) / inner.offsetWidth)
      : old * (dir > 0 ? 1.2 : 1 / 1.2);
    z = Math.max(0.25, Math.min(1.8, z));
    // Keep the middle of the view in place while zooming.
    const cx = (wrap.scrollLeft + wrap.clientWidth / 2) / old;
    const cy = (wrap.scrollTop + wrap.clientHeight / 2) / old;
    state.zoom = z;
    layoutChart();
    wrap.scrollLeft = dir === 0 ? 0 : cx * z - wrap.clientWidth / 2;
    wrap.scrollTop = dir === 0 ? 0 : cy * z - wrap.clientHeight / 2;
  }

  let relayoutTimer;
  const relayout = () => { clearTimeout(relayoutTimer); relayoutTimer = setTimeout(layoutChart, 120); };
  window.addEventListener('resize', relayout);
  document.fonts?.ready.then(relayout);

  // The simpler indented list, handy on small screens.
  function nodeHtml(p, gen) {
    const kids = state.kids.get(p.id) || [];
    const sp = spousesOf(p.id);
    const open = !state.collapsed.has(p.id);
    const mine = p.user_id && p.user_id === uid();
    const meta = [genShort(gen), lifespan(p), kids.length ? t(kids.length === 1 ? '{n} child' : '{n} children', { n: kids.length }) : '']
      .filter(Boolean).join(' · ');
    return `
      <li>
        <div class="node">
          ${kids.length
            ? `<button class="twisty" data-action="toggle" data-id="${p.id}" aria-expanded="${open}" aria-label="${t(open ? 'Hide children of {name}' : 'Show children of {name}', { name: esc(p.full_name) })}">${open ? '−' : '+'}</button>`
            : '<span class="twisty leaf" aria-hidden="true"></span>'}
          <button class="card${mine ? ' me' : ''}${p.is_living ? '' : ' late'}" data-action="open" data-id="${p.id}" id="n-${p.id}">
            ${avatar(p)}
            <span class="card-text">
              <span class="name">${esc(p.full_name)}${mine ? ` <span class="pill tiny">${t('You')}</span>` : ''}</span>
              <span class="meta">${esc(meta)}</span>
            </span>
          </button>
        </div>
        ${sp.length ? `<div class="node-spouses">${sp.map((s) => `<button class="spouse-chip" data-action="open" data-id="${s.id}" id="n-${s.id}">
          <span class="ring" aria-hidden="true"></span>${avatar(s, 'xs')}<span>${esc(s.full_name)}</span></button>`).join('')}</div>` : ''}
        ${kids.length && open ? `<ul>${kids.map((k) => nodeHtml(k, gen + 1)).join('')}</ul>` : ''}
      </li>`;
  }

  function reveal(id) {
    const p = state.byId.get(id);
    if (!p) return;
    for (const a of lineage(inLine(p)).slice(0, -1)) state.collapsed.delete(a.id);
    renderTreeBody();
    const el = document.getElementById(`n-${id}`);
    if (el) {
      const wrap = el.closest('.chart-wrap');
      if (wrap) {
        // Scroll the chart box itself, then bring the box into view on the page.
        const r = el.getBoundingClientRect();
        const w = wrap.getBoundingClientRect();
        wrap.scrollLeft += r.left - w.left - (wrap.clientWidth - r.width) / 2;
        wrap.scrollTop += r.top - w.top - (wrap.clientHeight - r.height) / 2;
        wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 2000);
    }
  }

  function pathLabel(p) {
    if (isSpouse(p)) return relationTo(p);
    return lineage(p).slice(0, -1).map((a) => a.full_name).join(' › ') || t('Top ancestor');
  }

  function updateSearch(q) {
    const box = document.getElementById('results');
    q = q.trim().toLowerCase();
    if (!q) { box.hidden = true; box.innerHTML = ''; return; }
    const hits = state.persons.filter((p) => p.full_name.toLowerCase().includes(q)).slice(0, 20);
    box.hidden = false;
    box.innerHTML = hits.length
      ? hits.map((p) => `
          <button class="result" data-action="reveal" data-id="${p.id}">
            ${avatar(p, 'sm')}
            <span><span class="name">${esc(p.full_name)}</span>
            <span class="path">${esc(pathLabel(p))}</span></span>
          </button>`).join('')
      : `<p class="muted pad">${t('No one found with that name.')}</p>`;
  }

  // ---------------------------------------------------------------- person details

  function chipList(list) {
    return `<div class="chips">${list.map((k) => `<button class="chip" data-action="open" data-id="${k.id}">${avatar(k, 'xs')}${esc(k.full_name)}</button>`).join('')}</div>`;
  }

  function openDetail(id) {
    const p = state.byId.get(id);
    if (!p) return;
    const spouse = isSpouse(p);
    const path = lineage(p);
    const kids = childrenOf(p);
    const partners = spouse ? [partnerOf(p)].filter(Boolean) : spousesOf(p.id);
    const parent = !spouse && p.parent_id && state.byId.get(p.parent_id);
    const other = !spouse && p.other_parent_id && state.byId.get(p.other_parent_id);
    const childWord = t(p.gender === 'female' ? 'Daughter' : p.gender === 'male' ? 'Son' : 'Child');
    const subtitle = spouse ? relationTo(p)
      : parent ? t(other ? '{child} of {parent} and {other}' : '{child} of {parent}', { child: childWord, parent: parent.full_name, other: other?.full_name })
        : t('Top ancestor');
    const partnerHeading = t(spouse ? (partners[0]?.gender === 'female' ? 'Wife' : partners[0]?.gender === 'male' ? 'Husband' : 'Spouse')
      : partners.length > 1 ? 'Spouses' : partners[0]?.gender === 'female' ? 'Wife' : partners[0]?.gender === 'male' ? 'Husband' : 'Spouse');
    const rows = [
      [t('Born'), [fmtDate(p.birth_date), p.birth_place].filter(Boolean).join(', ')],
      [t('Died'), p.is_living ? '' : fmtDate(p.death_date) || t('Late')],
      [t('Occupation'), p.occupation],
      [t('Lives in'), p.current_address],
      [t('Phone'), p.phone],
      [t('Email'), p.email],
    ].filter(([, v]) => v);
    const photo = p.photo_path && state.photos.get(p.photo_path);
    $modalBody.dataset.id = id;
    $modalBody.innerHTML = `
      <button class="close" data-action="close-modal" aria-label="${t('Close')}">×</button>
      <div class="detail-head">
        ${photo ? `<img class="photo" src="${esc(photo)}" alt="${t('Photo of {name}', { name: esc(p.full_name) })}">` : `<span class="photo initials">${esc(initials(p.full_name))}</span>`}
        <div>
          <p class="eyebrow">${genLong(generation(p))}${spouse ? ` · ${t('married in')}` : ''}${p.is_living ? '' : ` · ${t('Late')}`}</p>
          <h2>${esc(p.full_name)}</h2>
          <p class="muted">${esc(subtitle)}</p>
        </div>
      </div>
      <div class="detail-actions">
        ${canEdit(p) ? `<button class="btn primary" data-action="edit" data-id="${p.id}">✎ ${t('Edit details')}</button>` : ''}
        ${canContribute() ? `<button class="btn" data-action="add-child" data-id="${p.id}">＋ ${t('Add child')}</button>` : ''}
        ${canContribute() && !spouse ? `<button class="btn" data-action="add-spouse" data-id="${p.id}">＋ ${t('Add spouse')}</button>` : ''}
        <button class="btn ghost" data-action="show-in-tree" data-id="${p.id}">${t('Show in tree')}</button>
      </div>
      ${path.length > 1 ? `<nav class="crumbs" aria-label="${t('Ancestry')}">${path.map((a, i) => (i === path.length - 1
        ? `<span>${esc(a.full_name)}</span>`
        : `<button class="link" data-action="open" data-id="${a.id}">${esc(a.full_name)}</button><span class="sep">${isSpouse(path[i + 1]) ? '⚭' : '›'}</span>`)).join('')}</nav>` : ''}
      ${rows.length ? `<dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
      ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
      ${partners.length ? `<h3>${partnerHeading}</h3>${chipList(partners)}` : ''}
      ${kids.length ? `<h3>${t('Children')}</h3>${chipList(kids)}` : ''}
      ${canEditAll() && !kids.length ? `<div class="danger-zone"><button class="btn danger sm" data-action="delete" data-id="${p.id}">${t('Delete {name}', { name: esc(p.full_name) })}</button></div>` : ''}`;
    if (!$modal.open) $modal.showModal();
    $modal.scrollTop = 0;
  }

  // ---------------------------------------------------------------- add / edit form

  function parentOptions(excluded, selected, filter = '') {
    const f = filter.trim().toLowerCase();
    const items = state.persons
      .filter((p) => !excluded.has(p.id) && !isSpouse(p))
      .map((p) => ({ id: p.id, label: lineage(p).map((a) => a.full_name).join(' › '), name: p.full_name }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const shown = items.filter((i) => !f || i.name.toLowerCase().includes(f) || i.id === selected);
    const rootOpt = canEditAll() ? `<option value="" ${!selected ? 'selected' : ''}>${t('— None (a new top ancestor) —')}</option>` : `<option value="" disabled ${!selected ? 'selected' : ''}>${t('— Choose the parent —')}</option>`;
    return rootOpt + shown.map((i) => `<option value="${i.id}" ${i.id === selected ? 'selected' : ''}>${esc(i.label)}</option>`).join('');
  }

  function otherParentOptions(parentId, selected) {
    const sp = parentId ? spousesOf(parentId) : [];
    return `<option value="">${t('— Not recorded —')}</option>${sp.map((s) => `
      <option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${esc(s.full_name)}</option>`).join('')}`;
  }

  function updateOtherParent(preselect) {
    const sel = document.getElementById('parent-select');
    const wrap = document.getElementById('other-wrap');
    if (!sel || !wrap) return;
    const sp = sel.value ? spousesOf(sel.value) : [];
    wrap.hidden = !sp.length;
    const current = document.getElementById('other-select').value;
    const pick = preselect !== undefined ? preselect : (sp.some((x) => x.id === current) ? current : (sp.length === 1 ? sp[0].id : null));
    document.getElementById('other-select').innerHTML = otherParentOptions(sel.value, pick);
  }

  function renderForm({ editId, parentId, otherParentId, spouseOf } = {}) {
    const main = document.getElementById('main');
    const p = editId ? state.byId.get(editId) : null;
    const partner = state.byId.get(spouseOf || p?.spouse_of);
    const spouseMode = !!partner;
    const excluded = p ? new Set([p.id, ...descendants(p.id)]) : new Set();
    const selected = p ? p.parent_id : parentId || null;
    const parentForOther = p ? p.parent_id : parentId;
    const otherPick = p ? p.other_parent_id : (otherParentId
      || (parentForOther && spousesOf(parentForOther).length === 1 ? spousesOf(parentForOther)[0].id : null));
    const defaultGender = spouseMode && !p ? ({ male: 'female', female: 'male' }[partner.gender] || '') : p?.gender;
    const me = myPerson();
    const canClaim = !me || (p && me.id === p.id);
    const photo = p?.photo_path && state.photos.get(p.photo_path);
    const v = (k) => esc(p?.[k] ?? '');
    main.innerHTML = `
      <section class="panel form-panel">
        <h2>${p ? t('Edit {name}', { name: esc(p.full_name) }) : spouseMode ? t("Add {name}'s spouse", { name: esc(partner.full_name) }) : t('Add a family member')}</h2>
        <form id="person-form" class="stack" data-edit-id="${p ? p.id : ''}" data-spouse-of="${spouseMode ? partner.id : ''}">
          ${spouseMode ? `
          <fieldset>
            <legend>${t('Married to')}</legend>
            <div class="match">
              ${avatar(partner)}
              <div class="match-text"><div class="name">${esc(partner.full_name)}</div>
                <div class="muted small">${esc(pathLabel(partner))}</div></div>
            </div>
            <p class="muted small">${t("They'll appear side by side in the family chart, with lines from both down to their children.")}</p>
          </fieldset>` : `
          <fieldset>
            <legend>${t('Place in the family')}</legend>
            <p class="muted small">${t("Choose this person's father or mother from the family line. Ancestors are shown in order, from the oldest.")}</p>
            <input id="parent-filter" type="search" placeholder="${t('Type a name to narrow the list…')}" aria-label="${t('Filter parents')}">
            <label class="sr">${t('Parent')}<select name="parent_id" id="parent-select" ${canEditAll() ? '' : 'required'}>${parentOptions(excluded, selected)}</select></label>
            <div id="parent-preview" class="path-preview"></div>
            <label id="other-wrap" hidden>${t('Other parent (their husband or wife)')}
              <select name="other_parent_id" id="other-select">${otherParentOptions(parentForOther, otherPick)}</select>
              <small class="muted">${t("Add a spouse from the parent's pop-up if they aren't listed.")}</small>
            </label>
          </fieldset>`}

          <fieldset>
            <legend>${t('Personal details')}</legend>
            <div class="grid">
              <label class="span2">${t('Full name *')}<input name="full_name" required value="${v('full_name')}"></label>
              <label>${t('Gender')}
                <select name="gender">
                  <option value="">—</option>
                  ${genderOptions(defaultGender)}
                </select>
              </label>
              <label>${t('Date of birth')}<input name="birth_date" type="date" value="${v('birth_date')}"></label>
              <label class="check span2"><input type="checkbox" name="is_living" id="is-living" ${!p || p.is_living ? 'checked' : ''}> ${t('Living')}</label>
              <label id="death-wrap" ${!p || p.is_living ? 'hidden' : ''}>${t('Date of death')}<input name="death_date" type="date" value="${v('death_date')}"></label>
              <label>${t('Place of birth')}<input name="birth_place" value="${v('birth_place')}"></label>
              <label>${t('Lives in')}<input name="current_address" value="${v('current_address')}" placeholder="${t('City, country')}"></label>
              <label>${t('Occupation')}<input name="occupation" value="${v('occupation')}"></label>
              <label>${t('Phone')}<input name="phone" type="tel" value="${v('phone')}"></label>
              <label>${t('Email')}<input name="email" type="email" value="${v('email')}"></label>
              <label class="span2">${t('About')}<textarea name="bio" rows="4" placeholder="${t('Stories, achievements, memories…')}">${v('bio')}</textarea></label>
            </div>
          </fieldset>

          <fieldset>
            <legend>${t('Photo')}</legend>
            <div class="photo-row">
              <span id="photo-preview">${photo ? `<img class="photo" src="${esc(photo)}" alt="">` : '<span class="photo initials">?</span>'}</span>
              <div class="stack tight">
                <input name="photo" id="photo-input" type="file" accept="image/*">
                ${photo ? `<label class="check"><input type="checkbox" name="remove_photo"> ${t('Remove current photo')}</label>` : ''}
                <small class="muted">${t('The photo is resized before it is uploaded.')}</small>
              </div>
            </div>
          </fieldset>

          ${canClaim ? `<label class="check claim"><input type="checkbox" name="is_me" ${p && me && me.id === p.id ? 'checked' : ''}>
            <span><b>${t('This is me.')}</b> ${t('Link this person to my account so I can always edit my own details.')}</span></label>` : ''}

          <div class="actions">
            <button class="btn ghost" type="button" data-action="view" data-view="tree">${t('Cancel')}</button>
            <button class="btn primary" type="submit">${p ? t('Save changes') : t('Add to family tree')}</button>
          </div>
        </form>
      </section>`;
    updateParentPreview();
    updateOtherParent(otherPick);
  }

  function updateParentPreview() {
    const sel = document.getElementById('parent-select');
    const out = document.getElementById('parent-preview');
    if (!sel || !out) return;
    const parent = state.byId.get(sel.value);
    out.innerHTML = parent
      ? `${lineage(parent).map((a) => `<span>${esc(a.full_name)}</span>`).join('<span class="sep">›</span>')}<span class="sep">›</span><span class="new">${t('this person')}</span>`
      : (canEditAll() ? `<span class="muted">${t('Will be added as a new top ancestor.')}</span>` : '');
  }

  async function savePerson(form) {
    const btn = form.querySelector('button[type=submit]');
    const fd = new FormData(form);
    const editId = form.dataset.editId || null;
    const existing = editId ? state.byId.get(editId) : null;
    const str = (k) => (fd.get(k) || '').toString().trim() || null;
    const isLiving = fd.get('is_living') === 'on';
    const spouseOf = form.dataset.spouseOf || null;
    const rec = {
      parent_id: spouseOf ? null : str('parent_id'),
      other_parent_id: spouseOf ? null : str('other_parent_id'),
      spouse_of: spouseOf,
      full_name: str('full_name'),
      gender: str('gender'),
      birth_date: str('birth_date'),
      is_living: isLiving,
      death_date: isLiving ? null : str('death_date'),
      birth_place: str('birth_place'),
      current_address: str('current_address'),
      occupation: str('occupation'),
      phone: str('phone'),
      email: str('email'),
      bio: str('bio'),
    };
    if (!rec.full_name) return toast(t('Please enter a name.'), 'error');
    if (!spouseOf && !rec.parent_id && !canEditAll() && !(existing && !existing.parent_id)) return toast(t('Please choose a parent.'), 'error');
    if (rec.other_parent_id && !spousesOf(rec.parent_id).some((x) => x.id === rec.other_parent_id)) rec.other_parent_id = null;

    if (form.querySelector('[name=is_me]')) {
      if (fd.get('is_me') === 'on') rec.user_id = uid();
      else if (existing && existing.user_id === uid()) rec.user_id = null;
    }

    btn.disabled = true;
    btn.textContent = t('Saving…');
    const oldPhoto = existing?.photo_path;
    try {
      const file = fd.get('photo');
      if (file && file.size) {
        const blob = await resizeImage(file);
        const path = `${uid()}/${crypto.randomUUID()}.jpg`;
        const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
        if (error) throw error;
        rec.photo_path = path;
      } else if (fd.get('remove_photo') === 'on') {
        rec.photo_path = null;
      }

      let savedId = editId;
      if (existing) {
        const { error } = await sb.from('persons').update(rec).eq('id', editId);
        if (error) throw error;
      } else {
        rec.created_by = uid();
        const { data, error } = await sb.from('persons').insert(rec).select('id').single();
        if (error) throw error;
        savedId = data.id;
      }
      if (oldPhoto && 'photo_path' in rec && rec.photo_path !== oldPhoto) {
        sb.storage.from(PHOTO_BUCKET).remove([oldPhoto]); // best effort
      }
      await loadPersons();
      toast(existing ? t('Changes saved.') : t('{name} was added to the tree.', { name: rec.full_name }), 'ok');
      setView('tree');
      reveal(savedId);
    } catch (e) {
      toast(friendlyError(e), 'error');
      btn.disabled = false;
      btn.textContent = existing ? t('Save changes') : t('Add to family tree');
    }
  }

  async function deletePerson(id) {
    const p = state.byId.get(id);
    const sp = spousesOf(id);
    const also = sp.length ? `\n\n${t(sp.length === 1 ? 'Their spouse ({names}) will be deleted too.' : 'Their spouses ({names}) will be deleted too.', { names: sp.map((x) => x.full_name).join(', ') })}` : '';
    if (!p || !confirm(t('Delete {name} from the family tree? This cannot be undone.', { name: p.full_name }) + also)) return;
    const { error } = await sb.from('persons').delete().eq('id', id);
    if (error) return toast(friendlyError(error), 'error');
    if (p.photo_path) sb.storage.from(PHOTO_BUCKET).remove([p.photo_path]);
    $modal.close();
    await loadPersons();
    renderView();
    toast(t('{name} was deleted.', { name: p.full_name }), 'ok');
  }

  // ---------------------------------------------------------------- guided "connect me" builder
  // Asks for you, then your parent, grandparent… searching the tree at each step
  // until it finds the ancestor you connect to. Nothing is saved until the review step.

  const MAX_NEW_GENERATIONS = 8;

  function startConnect() {
    state.wiz = {
      step: 'me',
      me: { full_name: state.profile.full_name || '', gender: '', birth_date: '', birth_place: '', current_address: '', photo: null },
      chain: [], // new ancestors not yet in the tree, nearest first
      anchorId: null, // the existing person the chain hangs from
      query: '',
    };
  }

  const tokens = (s) => s.toLowerCase().split(/\s+/).filter((t) => t.length > 1);

  function nameMatches(query, { unlinkedOnly = false } = {}) {
    const q = tokens(query);
    if (!q.length) return [];
    return state.persons
      .filter((p) => (!unlinkedOnly || !p.user_id) && q.every((t) => p.full_name.toLowerCase().includes(t)))
      .slice(0, 12);
  }

  function chainBubbles() {
    const w = state.wiz;
    const anchor = w.anchorId && state.byId.get(w.anchorId);
    const items = [
      { label: w.me.full_name || t('You'), cls: 'you' },
      ...w.chain.map((a) => ({ label: a.full_name, cls: 'new' })),
      anchor ? { label: anchor.full_name, cls: 'found' } : { label: '?', cls: 'unknown' },
    ];
    return `<ol class="wiz-chain" aria-label="${t('Your line so far')}">${items.map((it) => `
      <li class="${it.cls}"><span class="dot">${it.cls === 'unknown' ? '?' : esc(initials(it.label))}</span><span class="lbl">${esc(it.label)}</span></li>`).join('')}
    </ol>`;
  }

  function matchCard(p, action, buttonLabel) {
    const path = isSpouse(p) ? '' : lineage(p).slice(0, -1).map((a) => a.full_name).join(' › ');
    const kids = childrenOf(p).map((k) => k.full_name);
    return `
      <div class="match">
        ${avatar(p)}
        <div class="match-text">
          <div class="name">${esc(p.full_name)} <span class="muted small">${esc(lifespan(p))}</span></div>
          <div class="muted small">${isSpouse(p) ? esc(relationTo(p)) : path ? t('Descendant of {path}', { path: esc(path) }) : t('Top ancestor')}</div>
          ${kids.length ? `<div class="muted small">${t('Parent of {names}', { names: esc(kids.join(', ')) })}</div>` : ''}
        </div>
        <button class="btn primary sm" data-action="${action}" data-id="${p.id}">${buttonLabel}</button>
      </div>`;
  }

  function renderConnect() {
    if (!state.wiz) startConnect();
    const w = state.wiz;
    const main = document.getElementById('main');
    let body = '';

    if (w.step === 'me') {
      const m = w.me;
      body = `
        <h2>${t("Let's connect you to the family tree")}</h2>
        <p class="muted">${t("First, tell us about yourself. Next we'll ask about your parents and look for them in the tree.")}</p>
        <form id="wiz-me" class="stack">
          <div class="grid">
            <label class="span2">${t('Your full name *')}<input name="full_name" id="wiz-me-name" required value="${esc(m.full_name)}"></label>
            <label>${t('Gender')}
              <select name="gender"><option value="">—</option>
                ${genderOptions(m.gender)}
              </select></label>
            <label>${t('Date of birth')}<input name="birth_date" type="date" value="${esc(m.birth_date)}"></label>
            <label>${t('Place of birth')}<input name="birth_place" value="${esc(m.birth_place)}"></label>
            <label>${t('Lives in')}<input name="current_address" value="${esc(m.current_address)}" placeholder="${t('City, country')}"></label>
            <label class="span2">${t('Your photo')}<input name="photo" type="file" accept="image/*">
              ${m.photo ? `<small class="muted">${t('Selected: {name}', { name: esc(m.photo.name) })}</small>` : ''}</label>
          </div>
          <div id="wiz-already"></div>
          <div class="actions"><button class="btn primary" type="submit">${t('Next: your parents')}</button></div>
        </form>`;
    } else if (w.step === 'ancestor') {
      const i = w.chain.length;
      const prev = i ? w.chain[i - 1].full_name : null;
      body = `
        <p class="eyebrow">${t('Step {n}', { n: i + 2 })}</p>
        <h2>${prev ? t("Who is {name}'s father or mother?", { name: esc(prev) }) : t('Who is your father or mother?')}</h2>
        <p class="muted">${t("Start typing their name. If they're already in the tree, choose them and you're connected.")}</p>
        <input id="wiz-search" type="search" autocomplete="off" placeholder="${t('Type a name, e.g. Santa Bahadur')}" value="${esc(w.query)}">
        <div id="wiz-matches" class="matches"></div>
        ${i < MAX_NEW_GENERATIONS ? `
        <details class="wiz-new" ${w.query ? 'open' : ''}>
          <summary>${t('Not in the tree yet? Add them')}</summary>
          <form id="wiz-new" class="stack">
            <div class="seg two">
              <label><input type="radio" name="relation" value="male" checked> ${t('Father')}</label>
              <label><input type="radio" name="relation" value="female"> ${t('Mother')}</label>
            </div>
            <div class="grid">
              <label class="span2">${t('Full name *')}<input name="full_name" id="wiz-new-name" required value="${esc(w.query)}"></label>
              <label>${t('Date of birth')}<input name="birth_date" type="date"></label>
              <label class="check"><input type="checkbox" name="is_living" checked> ${t('Living')}</label>
            </div>
            <div class="actions"><button class="btn" type="submit">${t('Add, then ask about their parents')}</button></div>
          </form>
        </details>` : `<p class="muted">${t("That's many generations. Ask a family admin to help connect the rest.")}</p>`}
        <div class="actions spread"><button class="btn ghost" data-action="wiz-back">${t('Back')}</button><span></span></div>`;
    } else {
      const anchor = state.byId.get(w.anchorId);
      const existing = lineage(anchor);
      const fresh = [...w.chain].reverse();
      body = `
        <p class="eyebrow">${t('Last step')}</p>
        <h2>${t('Check your line')}</h2>
        <p class="muted">${t("This is how you'll appear in the family tree.")} ${fresh.length ? t(fresh.length === 1 ? '{n} new person will be added along with you.' : '{n} new people will be added along with you.', { n: fresh.length }) : ''}</p>
        <ol class="wiz-path">
          ${existing.map((a, i) => {
            const other = i === existing.length - 1 && w.anchorOther && state.byId.get(w.anchorOther);
            return `<li class="old">${esc(a.full_name)}${other ? ` ⚭ ${esc(other.full_name)}` : ''}<span class="tag">${t('in tree')}</span></li>`;
          }).join('')}
          ${fresh.map((a) => `<li class="new">${esc(a.full_name)}<span class="tag">${t('new')}</span></li>`).join('')}
          <li class="you">${esc(w.me.full_name)}<span class="tag">${t('you')}</span></li>
        </ol>
        <div class="actions spread">
          <button class="btn ghost" data-action="wiz-back">${t('Back')}</button>
          <button class="btn primary" data-action="wiz-confirm">${t('Add me to the family tree')}</button>
        </div>`;
    }

    main.innerHTML = `<section class="panel wizard">${chainBubbles()}${body}</section>`;
    if (w.step === 'me') updateAlreadyInTree(w.me.full_name);
    if (w.step === 'ancestor') {
      updateWizMatches();
      const s = document.getElementById('wiz-search');
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    }
  }

  function updateAlreadyInTree(name) {
    const box = document.getElementById('wiz-already');
    if (!box) return;
    const hits = nameMatches(name, { unlinkedOnly: true });
    box.innerHTML = hits.length
      ? `<div class="callout plain"><div><b>${t('Are you already in the tree?')}</b> ${t('Someone may have added you. If so, choose yourself.')}</div></div>
         <div class="matches">${hits.map((p) => matchCard(p, 'wiz-claim', t('This is me'))).join('')}</div>`
      : '';
  }

  function updateWizMatches() {
    const box = document.getElementById('wiz-matches');
    if (!box) return;
    const q = state.wiz.query;
    if (tokens(q).length === 0) { box.innerHTML = ''; return; }
    const hits = nameMatches(q);
    box.innerHTML = hits.length
      ? hits.map((p) => matchCard(p, 'wiz-pick', t('Yes, this is them'))).join('')
      : `<p class="muted small pad">${t('No one called “{q}” in the tree yet. You can add them below.', { q: esc(q) })}</p>`;
  }

  async function confirmConnect(btn) {
    const w = state.wiz;
    btn.disabled = true;
    btn.textContent = t('Adding…');
    try {
      let parentId = w.anchorId;
      let otherId = w.anchorOther || null;
      for (const a of [...w.chain].reverse()) {
        const { data, error } = await sb.from('persons')
          .insert({ ...a, parent_id: parentId, other_parent_id: otherId, created_by: uid() }).select('id').single();
        if (error) throw error;
        parentId = data.id;
        otherId = null;
      }
      const me = { ...w.me };
      const photo = me.photo;
      delete me.photo;
      for (const k of Object.keys(me)) if (me[k] === '') me[k] = null;
      if (photo) {
        const blob = await resizeImage(photo);
        const path = `${uid()}/${crypto.randomUUID()}.jpg`;
        const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
        if (error) throw error;
        me.photo_path = path;
      }
      const { data, error } = await sb.from('persons')
        .insert({ ...me, is_living: true, parent_id: parentId, other_parent_id: otherId, user_id: uid(), created_by: uid() }).select('id').single();
      if (error) throw error;
      state.wiz = null;
      await loadPersons();
      state.view = 'tree';
      renderApp();
      reveal(data.id);
      toast(t('Welcome to the family tree!'), 'ok');
    } catch (e) {
      toast(friendlyError(e), 'error');
      btn.disabled = false;
      btn.textContent = t('Add me to the family tree');
      await loadPersons(); // some ancestors may have been saved before the error
    }
  }

  async function claimPerson(id) {
    const { error } = await sb.rpc('claim_person', { target: id });
    if (error) return toast(friendlyError(error), 'error');
    state.wiz = null;
    await loadPersons();
    state.view = 'form';
    renderApp();
    renderForm({ editId: id });
    toast(t('You are now linked to your place in the tree. Check your details and save.'), 'ok');
  }

  // ---------------------------------------------------------------- admin

  async function renderAdmin() {
    const main = document.getElementById('main');
    main.innerHTML = `<p class="muted">${t('Loading members…')}</p>`;
    const { data, error } = await sb.from('profiles').select('*').order('created_at', { ascending: false });
    if (state.view !== 'admin') return;
    if (error) { main.innerHTML = `<p class="muted">${esc(error.message)}</p>`; return; }
    state.members = data;
    state.memberFilter ||= { q: '', role: 'all' };
    main.innerHTML = `
      <section class="panel">
        <h2>${t('Site settings')}</h2>
        <p class="muted small">${t('The name and welcome line shown on the login page and at the top of every page. Leave the Nepali boxes empty to use the standard translation.')}</p>
        <form id="site-form" class="stack">
          <div class="grid">
            <label>${t('Site name (English)')}<input name="title_en" required maxlength="80" value="${esc(site.title_en || siteTitle)}"></label>
            <label>${t('Site name (Nepali)')}<input name="title_ne" lang="ne" maxlength="80" value="${esc(site.title_ne || '')}" placeholder="${esc(NE[site.title_en || siteTitle] || '')}"></label>
            <label>${t('Welcome line (English)')}<textarea name="tagline_en" rows="2" maxlength="240" placeholder="${esc(DEFAULT_TAGLINE)}">${esc(site.tagline_en || '')}</textarea></label>
            <label>${t('Welcome line (Nepali)')}<textarea name="tagline_ne" lang="ne" rows="2" maxlength="240" placeholder="${esc(NE[DEFAULT_TAGLINE] || '')}">${esc(site.tagline_ne || '')}</textarea></label>
          </div>
          <div class="actions"><button class="btn primary" type="submit">${t('Save site settings')}</button></div>
        </form>
      </section>
      <section class="panel">
        <h2>${t('Roles')}</h2>
        <p class="muted small">${t("Every approved member has one role. Change someone's role from the list below.")}</p>
        <div class="role-grid" id="role-grid"></div>
      </section>
      <div id="member-lists"></div>`;
    renderMemberLists();
  }

  function roleSelect(m, attrs = '') {
    const current = m.role || 'member';
    return `<select class="role-select" aria-label="${t('Role for {name}', { name: esc(m.full_name || m.email) })}" ${attrs}>
      ${Object.keys(ROLES).map((k) => `<option value="${k}" ${k === current ? 'selected' : ''}>${roleLabel(k)}</option>`).join('')}
    </select>`;
  }

  function renderMemberLists() {
    const all = state.members || [];
    const f = state.memberFilter;
    const approved = all.filter((m) => m.status === 'approved');
    document.getElementById('role-grid').innerHTML = Object.entries(ROLES).map(([k, r]) => {
      const n = approved.filter((m) => (m.role || 'member') === k).length;
      return `
        <button class="role-card ${f.role === k ? 'on' : ''}" data-action="role-filter" data-role="${k}" aria-pressed="${f.role === k}">
          <span class="role-head"><span class="pill tiny role-${k}">${roleLabel(k)}</span><span class="count">${num(n)}</span></span>
          <ul>${r.can.map((c) => `<li>${esc(t(c))}</li>`).join('')}</ul>
        </button>`;
    }).join('');

    const linked = new Map(state.persons.filter((p) => p.user_id).map((p) => [p.user_id, p]));
    const q = f.q.trim().toLowerCase();
    const matches = (m) => (!q || `${m.full_name} ${m.email}`.toLowerCase().includes(q))
      && (f.role === 'all' || m.status !== 'approved' || (m.role || 'member') === f.role);

    const row = (m) => {
      const self = m.id === uid();
      const person = linked.get(m.id);
      let controls;
      if (self) {
        controls = `<span class="pill tiny role-${m.role}">${roleLabel(m.role)}</span><span class="muted small">${t('Another admin can change your role')}</span>`;
      } else if (m.status === 'pending') {
        controls = `
          <label class="inline">${t('Approve as')} ${roleSelect(m, `id="role-new-${m.id}"`)}</label>
          <button class="btn danger sm" data-action="member" data-op="reject" data-id="${m.id}">${t('Reject')}</button>
          <button class="btn primary sm" data-action="member" data-op="approve" data-id="${m.id}">${t('Approve')}</button>`;
      } else if (m.status === 'approved') {
        controls = `
          ${roleSelect(m, `data-role-for="${m.id}"`)}
          <button class="btn danger sm" data-action="member" data-op="reject" data-id="${m.id}">${t('Revoke access')}</button>`;
      } else {
        controls = `
          <label class="inline">${t('Approve as')} ${roleSelect(m, `id="role-new-${m.id}"`)}</label>
          <button class="btn sm" data-action="member" data-op="approve" data-id="${m.id}">${t('Approve')}</button>`;
      }
      return `
        <div class="member">
          <div class="member-info">
            <div class="name">${esc(m.full_name || t('(no name)'))} ${self ? `<span class="pill tiny">${t('You')}</span>` : ''}</div>
            <div class="muted small">${esc(m.email || '')} · ${t('joined {date}', { date: fmtDate(m.created_at, 'short') })}</div>
            ${person ? `<div class="small">${t('In tree as')} <button class="link" data-action="open" data-id="${person.id}">${esc(lineage(person).map((a) => a.full_name).join(' › '))}</button></div>` : ''}
          </div>
          <div class="actions">${controls}</div>
        </div>`;
    };
    const section = (title, list, empty) => `
      <section class="panel">
        <h2>${title} <span class="count">${num(list.length)}</span></h2>
        ${list.length ? list.map(row).join('') : `<p class="muted">${empty}</p>`}
      </section>`;
    const pending = all.filter((m) => m.status === 'pending' && matches(m));
    const members = approved.filter(matches);
    const rejected = all.filter((m) => m.status === 'rejected' && matches(m));
    const filterNote = f.role === 'all' ? '' : ` · ${t('showing {role}s', { role: roleLabel(f.role).toLowerCase() })} <button class="link" data-action="role-filter" data-role="all">${t('show all')}</button>`;
    const hadFocus = document.activeElement?.id === 'member-search';
    document.getElementById('member-lists').innerHTML = `
      <div class="toolbar member-tools">
        <div class="search"><input id="member-search" type="search" placeholder="${t('Search members by name or email…')}" value="${esc(f.q)}" aria-label="${t('Search members')}"></div>
        <span class="muted small">${t('{n} approved', { n: approved.length })}${filterNote}</span>
      </div>
      ${section(t('Waiting for approval'), pending, q ? t('No one waiting matches your search.') : t('No one is waiting. New sign-ups will appear here.'))}
      ${section(t('Members'), members, q || f.role !== 'all' ? t('No members match.') : t('No members yet.'))}
      ${rejected.length ? section(t('Not approved'), rejected, '') : ''}`;
    if (hadFocus) {
      const s = document.getElementById('member-search');
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    }
  }

  async function memberOp(id, op, newRole) {
    const m = (state.members || []).find((x) => x.id === id);
    const name = m?.full_name || m?.email || t('this member');
    let patch;
    let msg;
    if (op === 'approve') {
      const r = document.getElementById(`role-new-${id}`)?.value || 'member';
      patch = { status: 'approved', role: r };
      msg = t('{name} approved as {role}.', { name, role: roleLabel(r) });
    } else if (op === 'reject') {
      if (m?.status === 'approved' && !confirm(t("Remove {name}'s access to the family tree?", { name }))) return;
      patch = { status: 'rejected', role: 'member' };
      msg = m?.status === 'approved' ? t('Access removed.') : t('Request rejected.');
    } else {
      patch = { role: newRole };
      msg = t(newRole === 'admin' ? '{name} is now an {role}.' : '{name} is now a {role}.', { name, role: roleLabel(newRole) });
    }
    const { error } = await sb.from('profiles').update(patch).eq('id', id);
    if (error) { toast(friendlyError(error), 'error'); renderMemberLists(); return; }
    Object.assign(m, patch);
    toast(msg, 'ok');
    renderMemberLists();
  }

  // ---------------------------------------------------------------- language

  function genderOptions(selected) {
    return ['male', 'female', 'other'].map((g) => `<option value="${g}" ${selected === g ? 'selected' : ''}>${t(g[0].toUpperCase() + g.slice(1))}</option>`).join('');
  }

  // Redraw whatever is on screen in the new language. Unsaved typing in an open form is lost.
  function setLang(next) {
    if (next === lang) return;
    lang = next;
    try { localStorage.setItem('lang', lang); } catch { /* private mode */ }
    document.documentElement.lang = lang;
    document.title = siteName();
    const openId = $modal.open ? $modalBody.dataset.id : null;
    if (state.screen === 'auth') renderAuth(state.authMode);
    else if (state.screen === 'recovery') renderRecovery();
    else if (state.screen === 'pending') renderPending(state.profile);
    else if (state.screen === 'app') { renderApp(); if (openId) openDetail(openId); }
    else route();
  }

  // ---------------------------------------------------------------- family chat
  // One group chat for all approved members. A round button in the corner opens a side panel;
  // messages arrive live. Files go to the private 'chat' storage bucket.

  const CHAT_BUCKET = 'chat';
  const CHAT_PAGE = 40;
  const CHAT_MAX_MB = 50;
  const CHAT_MAX_VIDEO_SECONDS = 15;
  const CHAT_MAX_VOICE_SECONDS = 120;
  const chat = {
    mounted: false, open: false, lang: null, messages: [], urls: new Map(), channel: null,
    hasOlder: false, unread: 0, pending: null, recorder: null, recTimer: null, sending: false,
  };
  const ICON = {
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    clip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5 12.4 19a5 5 0 0 1-7.1-7.1l7.8-7.7a3.4 3.4 0 0 1 4.8 4.8l-7.8 7.7a1.7 1.7 0 0 1-2.4-2.4l7.2-7.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12 20 4l-4 16-4.5-6.5zM11.5 13.5 20 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  };
  const NE_NUM = (s) => (lang === 'ne' ? String(s).replace(/\d/g, (d) => NE_DIGITS[d]) : String(s));
  const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const fmtSecs = (s) => { s = Math.round(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const isTouch = () => window.matchMedia?.('(pointer: coarse)').matches;
  const seenKey = () => `chatSeen:${uid()}`;
  const getSeen = () => { try { return localStorage.getItem(seenKey()) || ''; } catch { return ''; } };
  const setSeen = (ts) => { try { localStorage.setItem(seenKey(), ts); } catch { /* private mode */ } };

  // Called whenever a top-level screen is drawn: the chat exists only inside the signed-in app.
  function chatSync() {
    const on = state.screen === 'app' && state.profile?.status === 'approved';
    if (on && !chat.mounted) chatMount();
    else if (!on && chat.mounted) chatUnmount();
    else if (on && chat.lang !== lang) { chatRenderShell(); chatRenderList(true); }
  }

  async function chatMount() {
    chat.mounted = true;
    chatRenderShell();
    await chatLoad();
    chat.channel = sb.channel('family-chat')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => chatAdd(p.new, true))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (p) => chatRemoveLocal(p.old?.id))
      .subscribe();
  }

  function chatUnmount() {
    if (chat.channel) sb.removeChannel(chat.channel);
    if (chat.recorder) chat.recorder.stop();
    document.getElementById('chat-fab')?.remove();
    document.getElementById('chat-panel')?.remove();
    Object.assign(chat, { mounted: false, open: false, messages: [], urls: new Map(), channel: null, unread: 0, pending: null });
    document.body.classList.remove('chat-open');
  }

  function chatRenderShell() {
    chat.lang = lang;
    let fab = document.getElementById('chat-fab');
    if (!fab) {
      fab = document.createElement('button');
      fab.id = 'chat-fab';
      fab.className = 'chat-fab';
      fab.dataset.action = 'chat-open';
      document.body.appendChild(fab);
    }
    fab.setAttribute('aria-label', t('Open family chat'));
    fab.innerHTML = `${ICON.chat}<span class="chat-badge" id="chat-badge" hidden></span>`;
    chatBadge();

    const draft = document.getElementById('chat-text')?.value || '';
    let panel = document.getElementById('chat-panel');
    if (!panel) {
      panel = document.createElement('aside');
      panel.id = 'chat-panel';
      panel.className = 'chat-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-labelledby', 'chat-title');
      panel.setAttribute('aria-hidden', 'true');
      document.body.appendChild(panel);
    }
    panel.innerHTML = `
      <header class="chat-head">
        <div>
          <h2 id="chat-title">${t('Family chat')}</h2>
          <p class="muted small">${t('Only approved family members can see this chat.')}</p>
        </div>
        <button class="close" data-action="chat-close" aria-label="${t('Close chat')}">×</button>
      </header>
      <div class="chat-list" id="chat-list"></div>
      <div class="chat-pending" id="chat-pending" hidden></div>
      <form id="chat-form" class="chat-compose">
        <input type="file" id="chat-file" hidden>
        <button type="button" class="chat-icon" data-action="chat-attach" aria-label="${t('Attach a photo, video, audio or file')}" title="${t('Attach a photo, video, audio or file')}">${ICON.clip}</button>
        <button type="button" class="chat-icon" id="chat-rec" data-action="chat-record" aria-label="${t('Record a voice message')}" title="${t('Record a voice message')}">${ICON.mic}</button>
        <textarea id="chat-text" rows="1" maxlength="4000" placeholder="${t('Write a message…')}" aria-label="${t('Message')}"></textarea>
        <button type="submit" class="chat-icon send" aria-label="${t('Send')}" title="${t('Send')}">${ICON.send}</button>
      </form>`;
    document.getElementById('chat-text').value = draft;
    chatRenderPending();
  }

  function chatBadge() {
    const b = document.getElementById('chat-badge');
    if (!b) return;
    b.hidden = !chat.unread;
    b.textContent = chat.unread > 99 ? '99+' : NE_NUM(chat.unread);
    document.getElementById('chat-fab')?.setAttribute('aria-label',
      chat.unread ? t('Open family chat ({n} new)', { n: chat.unread }) : t('Open family chat'));
  }

  async function chatLoad(older = false) {
    let q = sb.from('messages').select('*').order('created_at', { ascending: false }).limit(CHAT_PAGE);
    if (older && chat.messages.length) q = q.lt('created_at', chat.messages[0].created_at);
    const { data, error } = await q;
    if (error) {
      const list = document.getElementById('chat-list');
      if (list) list.innerHTML = `<p class="muted pad">${t('The chat could not be loaded.')}</p>`;
      return;
    }
    const batch = (data || []).reverse();
    chat.hasOlder = (data || []).length === CHAT_PAGE;
    chat.messages = older ? [...batch, ...chat.messages] : batch;
    await chatSignUrls(batch);
    if (!older) {
      const seen = getSeen();
      chat.unread = seen ? batch.filter((m) => m.created_at > seen && m.sender_id !== uid()).length : 0;
      if (!seen && batch.length) setSeen(batch[batch.length - 1].created_at);
      chatBadge();
    }
    chatRenderList(!older);
  }

  async function chatSignUrls(list) {
    const need = list.filter((m) => m.file_path && !chat.urls.has(m.file_path));
    const view = need.filter((m) => m.file_kind !== 'file').map((m) => m.file_path);
    const dl = need.filter((m) => m.file_kind === 'file');
    if (view.length) {
      const { data } = await sb.storage.from(CHAT_BUCKET).createSignedUrls(view, 60 * 60 * 6);
      for (const u of data || []) if (u.signedUrl) chat.urls.set(u.path, u.signedUrl);
    }
    // Files get a link that downloads under their original name.
    await Promise.all(dl.map(async (m) => {
      const { data } = await sb.storage.from(CHAT_BUCKET).createSignedUrl(m.file_path, 60 * 60 * 6, { download: m.file_name || true });
      if (data?.signedUrl) chat.urls.set(m.file_path, data.signedUrl);
    }));
  }

  function chatDayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yest = new Date(Date.now() - 864e5);
    if (d.toDateString() === today.toDateString()) return t('Today');
    if (d.toDateString() === yest.toDateString()) return t('Yesterday');
    return fmtDate(ts);
  }

  function chatAttachmentHtml(m) {
    if (!m.file_path) return '';
    const url = chat.urls.get(m.file_path);
    if (!url) return `<div class="chat-att muted small">${t('Loading…')}</div>`;
    const name = esc(m.file_name || t('File'));
    if (m.file_kind === 'image') return `<a class="chat-att img" href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="${name}" loading="lazy"></a>`;
    if (m.file_kind === 'video') return `<video class="chat-att" src="${esc(url)}" controls playsinline preload="metadata"></video>`;
    if (m.file_kind === 'audio') return `<audio class="chat-att" src="${esc(url)}" controls preload="metadata"></audio>`;
    return `<a class="chat-att file" href="${esc(url)}" target="_blank" rel="noopener">${ICON.file}<span><b>${name}</b><small>${m.file_size ? fmtSize(m.file_size) : ''}</small></span></a>`;
  }

  function chatMsgHtml(m, prev) {
    const mine = m.sender_id === uid();
    const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
    const grouped = !newDay && prev.sender_id === m.sender_id && new Date(m.created_at) - new Date(prev.created_at) < 5 * 60e3;
    const person = state.persons.find((p) => p.user_id && p.user_id === m.sender_id);
    const name = person?.full_name || m.sender_name || t('Family member');
    const time = NE_NUM(new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const canDelete = mine || isAdmin();
    return `
      ${newDay ? `<div class="chat-day"><span>${esc(chatDayLabel(m.created_at))}</span></div>` : ''}
      <div class="chat-msg${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}" data-msg="${m.id}">
        ${mine ? '' : `<span class="chat-ava">${grouped ? '' : (person ? avatar(person, 'sm') : `<span class="avatar initials sm">${esc(initials(name))}</span>`)}</span>`}
        <div class="chat-bubble">
          ${mine || grouped ? '' : `<div class="chat-name">${esc(name)}</div>`}
          ${chatAttachmentHtml(m)}
          ${m.body ? `<div class="chat-text">${esc(m.body)}</div>` : ''}
          <div class="chat-meta">${time}${canDelete ? `<button class="chat-del" data-action="chat-delete" data-id="${m.id}" aria-label="${t('Delete message')}" title="${t('Delete message')}">×</button>` : ''}</div>
        </div>
      </div>`;
  }

  function chatRenderList(toBottom) {
    const list = document.getElementById('chat-list');
    if (!list) return;
    const fromBottom = list.scrollHeight - list.scrollTop;
    list.innerHTML = `
      ${chat.hasOlder ? `<div class="chat-older"><button class="btn ghost sm" data-action="chat-older">${t('Show older messages')}</button></div>` : ''}
      ${chat.messages.length ? chat.messages.map((m, i) => chatMsgHtml(m, chat.messages[i - 1])).join('')
        : `<div class="chat-empty"><p><b>${t('No messages yet.')}</b></p><p class="muted small">${t('Say namaste to the family!')}</p></div>`}`;
    // Keep the view steady when older messages are added above.
    list.scrollTop = toBottom ? list.scrollHeight : list.scrollHeight - fromBottom;
  }

  async function chatAdd(m, live) {
    if (!m || chat.messages.some((x) => x.id === m.id)) return;
    const list = document.getElementById('chat-list');
    const nearBottom = list && list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    chat.messages.push(m);
    await chatSignUrls([m]);
    chatRenderList(nearBottom || m.sender_id === uid());
    if (live && m.sender_id !== uid()) {
      if (chat.open && document.visibilityState === 'visible') setSeen(m.created_at);
      else { chat.unread += 1; chatBadge(); }
    }
  }

  function chatRemoveLocal(id) {
    if (!id || !chat.messages.some((m) => m.id === id)) return;
    chat.messages = chat.messages.filter((m) => m.id !== id);
    chatRenderList(false);
  }

  function chatOpen() {
    const panel = document.getElementById('chat-panel');
    if (!panel) return;
    chat.open = true;
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    document.body.classList.add('chat-open');
    chat.unread = 0;
    chatBadge();
    const last = chat.messages[chat.messages.length - 1];
    if (last) setSeen(last.created_at);
    const list = document.getElementById('chat-list');
    list.scrollTop = list.scrollHeight;
    if (!isTouch()) document.getElementById('chat-text')?.focus();
  }

  function chatClose() {
    const panel = document.getElementById('chat-panel');
    if (!panel) return;
    chat.open = false;
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('chat-open');
    document.getElementById('chat-fab')?.focus();
  }

  function mediaDuration(file, tag) {
    return new Promise((resolve) => {
      const el = document.createElement(tag);
      el.preload = 'metadata';
      let finished = false;
      const done = (v) => {
        if (finished) return;
        finished = true;
        URL.revokeObjectURL(el.src);
        resolve(Number.isFinite(v) && v > 0 ? v : null);
      };
      el.onloadedmetadata = () => {
        if (Number.isFinite(el.duration) && el.duration > 0) { done(el.duration); return; }
        // Some recordings (e.g. WebM) only learn their length after seeking to the end.
        el.ondurationchange = () => { if (Number.isFinite(el.duration) && el.duration > 0) done(el.duration); };
        el.currentTime = 1e7;
      };
      el.onerror = () => done(null);
      setTimeout(() => done(el.duration), 8000);
      el.src = URL.createObjectURL(file);
    });
  }

  // Check and prepare a chosen file; it is uploaded when the message is sent.
  async function chatPrepare(file) {
    if (!file) return;
    if (file.size > CHAT_MAX_MB * 1048576) { toast(t('That file is too big. The limit is {n} MB.', { n: CHAT_MAX_MB }), 'error'); return; }
    const type = file.type || '';
    let item = { kind: 'file', blob: file, type: type || 'application/octet-stream', name: file.name || 'file', duration: null };
    if (type.startsWith('image/') && !/gif|svg/.test(type)) {
      try {
        const blob = await resizeImage(file, 1600);
        item = { kind: 'image', blob, type: 'image/jpeg', name: `${(file.name || 'photo').replace(/\.[^.]+$/, '')}.jpg` };
      } catch { item = { ...item, kind: 'image' }; }
    } else if (type.startsWith('image/')) {
      item.kind = 'image';
    } else if (type.startsWith('video/')) {
      const secs = await mediaDuration(file, 'video');
      if (secs == null) { toast(t("Couldn't check how long this video is. Please choose an MP4 or MOV video."), 'error'); return; }
      if (secs > CHAT_MAX_VIDEO_SECONDS + 0.5) {
        toast(t('Videos can be at most {max} seconds long. This one is {n} seconds.', { max: CHAT_MAX_VIDEO_SECONDS, n: Math.round(secs) }), 'error');
        return;
      }
      item = { ...item, kind: 'video', duration: secs };
    } else if (type.startsWith('audio/')) {
      item = { ...item, kind: 'audio', duration: await mediaDuration(file, 'audio') };
    }
    chatSetPending(item);
  }

  function chatSetPending(item) {
    if (chat.pending?.preview) URL.revokeObjectURL(chat.pending.preview);
    chat.pending = item ? { ...item, preview: URL.createObjectURL(item.blob) } : null;
    chatRenderPending();
  }

  function chatRenderPending() {
    const box = document.getElementById('chat-pending');
    if (!box) return;
    const p = chat.pending;
    box.hidden = !p;
    if (!p) { box.innerHTML = ''; return; }
    const prev = p.kind === 'image' ? `<img src="${p.preview}" alt="">`
      : p.kind === 'video' ? `<video src="${p.preview}" muted playsinline preload="metadata"></video>`
        : p.kind === 'audio' ? `<audio src="${p.preview}" controls preload="metadata"></audio>`
          : `<span class="chat-pend-icon">${ICON.file}</span>`;
    const label = { image: t('Photo'), video: t('Video'), audio: t('Audio'), file: t('File') }[p.kind];
    box.innerHTML = `
      <div class="chat-pend-media">${prev}</div>
      <div class="chat-pend-text"><b>${esc(label)}</b><small>${esc(p.name)} · ${fmtSize(p.blob.size)}${p.duration >= 1 ? ` · ${fmtSecs(p.duration)}` : ''}</small></div>
      <button type="button" class="chat-del big" data-action="chat-unattach" aria-label="${t('Remove attachment')}">×</button>`;
  }

  async function chatToggleRecord() {
    if (chat.recorder) { chat.recorder.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      toast(t('Voice recording does not work in this browser. You can attach an audio file instead.'), 'error');
      return;
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {
      toast(t('The microphone is blocked. Allow it in your browser settings to record.'), 'error');
      return;
    }
    // MP4 audio plays on every phone; fall back to WebM where MP4 recording isn't available.
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    const started = Date.now();
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      clearInterval(chat.recTimer);
      chat.recorder = null;
      chatRecButton();
      const type = (rec.mimeType || mime || 'audio/webm').split(';')[0];
      const secs = (Date.now() - started) / 1000;
      if (secs < 0.8 || !chunks.length) return;
      chatSetPending({ kind: 'audio', blob: new Blob(chunks, { type }), type, name: `voice-message.${type.includes('mp4') ? 'm4a' : 'webm'}`, duration: secs });
    };
    rec.start();
    chat.recorder = rec;
    chat.recStarted = started;
    chatRecButton();
    chat.recTimer = setInterval(() => {
      const secs = (Date.now() - started) / 1000;
      if (secs >= CHAT_MAX_VOICE_SECONDS) rec.stop(); else chatRecButton();
    }, 500);
  }

  function chatRecButton() {
    const b = document.getElementById('chat-rec');
    if (!b) return;
    const on = !!chat.recorder;
    b.classList.toggle('recording', on);
    b.innerHTML = on ? `${ICON.stop}<span class="rec-time">${NE_NUM(fmtSecs((Date.now() - chat.recStarted) / 1000))}</span>` : ICON.mic;
    b.setAttribute('aria-label', on ? t('Stop recording') : t('Record a voice message'));
  }

  async function chatSend() {
    if (chat.sending) return;
    const box = document.getElementById('chat-text');
    const text = box.value.trim();
    const p = chat.pending;
    if (!text && !p) return;
    if (chat.recorder) { toast(t('Stop the recording first.'), 'error'); return; }
    chat.sending = true;
    const btn = document.querySelector('#chat-form .send');
    btn.disabled = true;
    btn.classList.add('busy');
    try {
      let fileFields = {};
      if (p) {
        const ext = (p.name.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0].toLowerCase();
        const path = `${uid()}/${crypto.randomUUID()}${ext}`;
        const { error } = await sb.storage.from(CHAT_BUCKET).upload(path, p.blob, { contentType: p.type });
        if (error) throw error;
        fileFields = { file_path: path, file_kind: p.kind, file_name: p.name, file_size: p.blob.size, file_type: p.type, duration: p.duration || null };
      }
      const { data, error } = await sb.from('messages').insert({ body: text || null, ...fileFields }).select().single();
      if (error) throw error;
      box.value = '';
      chatGrow(box);
      chatSetPending(null);
      setSeen(data.created_at);
      await chatAdd(data, false);
    } catch (e) {
      toast(/size|too large|exceeded/i.test(e?.message || '') ? t('That file is too big. The limit is {n} MB.', { n: CHAT_MAX_MB }) : friendlyError(e), 'error');
    } finally {
      chat.sending = false;
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  }

  async function chatDelete(id) {
    const m = chat.messages.find((x) => x.id === id);
    if (!m || !confirm(t('Delete this message for everyone?'))) return;
    const { error } = await sb.from('messages').delete().eq('id', id);
    if (error) { toast(friendlyError(error), 'error'); return; }
    if (m.file_path) sb.storage.from(CHAT_BUCKET).remove([m.file_path]); // best effort
    chatRemoveLocal(id);
  }

  function chatGrow(el) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action^="chat-"]');
    if (!el) return;
    switch (el.dataset.action) {
      case 'chat-open': chatOpen(); break;
      case 'chat-close': chatClose(); break;
      case 'chat-attach': document.getElementById('chat-file').click(); break;
      case 'chat-unattach': chatSetPending(null); break;
      case 'chat-record': chatToggleRecord(); break;
      case 'chat-delete': chatDelete(el.dataset.id); break;
      case 'chat-older': chatLoad(true); break;
      default: break;
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id !== 'chat-file') return;
    const f = e.target.files[0];
    e.target.value = '';
    chatPrepare(f);
  });
  document.addEventListener('input', (e) => { if (e.target.id === 'chat-text') chatGrow(e.target); });
  document.addEventListener('submit', (e) => { if (e.target.id === 'chat-form') { e.preventDefault(); chatSend(); } });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && chat.open && !$modal.open) chatClose();
    // Enter sends on computers; on phones Enter makes a new line and the send button sends.
    if (e.target.id === 'chat-text' && e.key === 'Enter' && !e.shiftKey && !isTouch() && !e.isComposing) {
      e.preventDefault();
      chatSend();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && chat.open) {
      const last = chat.messages[chat.messages.length - 1];
      if (last) setSeen(last.created_at);
    }
  });

  // ---------------------------------------------------------------- events

  document.addEventListener('click', async (e) => {
    if (e.target === $modal) { $modal.close(); return; } // click on backdrop
    const el = e.target.closest('[data-action]');
    if (!el) {
      const res = document.getElementById('results');
      if (res && !e.target.closest('.search')) res.hidden = true;
      return;
    }
    const { action, id } = el.dataset;
    switch (action) {
      case 'auth-mode': renderAuth(el.dataset.mode); break;
      case 'lang': setLang(el.dataset.lang); break;
      case 'toggle-pw': {
        const input = el.parentElement.querySelector('input');
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        el.textContent = show ? t('Hide') : t('Show');
        el.setAttribute('aria-label', show ? t('Hide password') : t('Show password'));
        input.focus();
        break;
      }
      case 'logout': await sb.auth.signOut(); break;
      case 'recheck': route(); break;
      case 'view': if ($modal.open) $modal.close(); setView(el.dataset.view); break;
      case 'toggle':
        if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
        renderTreeBody();
        document.querySelector(`[data-action=toggle][data-id="${id}"]`)?.focus();
        break;
      case 'expand-all': state.collapsed.clear(); renderTreeBody(); break;
      case 'collapse-all':
        state.collapsed = new Set(state.persons.filter((p) => state.kids.get(p.id)?.length).map((p) => p.id));
        renderTreeBody();
        break;
      case 'find-me': reveal(myPerson()?.id); break;
      case 'reveal':
        document.getElementById('results').hidden = true;
        document.getElementById('search').value = '';
        reveal(id);
        openDetail(id);
        break;
      case 'open': openDetail(id); break;
      case 'close-modal': $modal.close(); break;
      case 'show-in-tree':
        $modal.close();
        if (state.view !== 'tree') setView('tree');
        reveal(id);
        break;
      case 'add-child': {
        const p = state.byId.get(id);
        $modal.close();
        setView('form', isSpouse(p) ? { parentId: p.spouse_of, otherParentId: p.id } : { parentId: id });
        break;
      }
      case 'add-spouse': $modal.close(); setView('form', { spouseOf: id }); break;
      case 'tree-mode':
        state.treeMode = el.dataset.mode;
        try { localStorage.setItem('treeMode', state.treeMode); } catch { /* private mode */ }
        renderTree();
        break;
      case 'zoom': setZoom(Number(el.dataset.dir)); break;
      case 'edit': $modal.close(); setView('form', { editId: id }); break;
      case 'delete': deletePerson(id); break;
      case 'member': memberOp(id, el.dataset.op); break;
      case 'role-filter':
        state.memberFilter.role = state.memberFilter.role === el.dataset.role ? 'all' : el.dataset.role;
        renderMemberLists();
        break;
      case 'wiz-claim':
        if (confirm(t('Link your account to {name}? Only do this if it is really you.', { name: state.byId.get(id)?.full_name }))) claimPerson(id);
        break;
      case 'wiz-pick': {
        // Picking a spouse (e.g. your mother who married in) connects you through their partner.
        const picked = state.byId.get(id);
        state.wiz.anchorId = isSpouse(picked) ? picked.spouse_of : id;
        state.wiz.anchorOther = isSpouse(picked) ? picked.id : (spousesOf(id).length === 1 ? spousesOf(id)[0].id : null);
        state.wiz.step = 'review';
        renderConnect();
        window.scrollTo(0, 0);
        break;
      }
      case 'wiz-back': {
        const w = state.wiz;
        if (w.step === 'review') { w.anchorId = null; w.anchorOther = null; w.step = 'ancestor'; w.query = ''; }
        else if (w.chain.length) { w.query = w.chain.pop().full_name; }
        else w.step = 'me';
        renderConnect();
        break;
      }
      case 'wiz-confirm': confirmConnect(el); break;
      default: break;
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'search') updateSearch(e.target.value);
    if (e.target.id === 'member-search') { state.memberFilter.q = e.target.value; renderMemberLists(); }
    if (e.target.id === 'wiz-me-name') updateAlreadyInTree(e.target.value);
    if (e.target.id === 'wiz-search') {
      state.wiz.query = e.target.value;
      updateWizMatches();
      const nm = document.getElementById('wiz-new-name');
      if (nm) nm.value = e.target.value;
    }
    if (e.target.id === 'parent-filter') {
      const sel = document.getElementById('parent-select');
      const form = document.getElementById('person-form');
      const editId = form.dataset.editId;
      const excluded = editId ? new Set([editId, ...descendants(editId)]) : new Set();
      sel.innerHTML = parentOptions(excluded, sel.value || null, e.target.value);
      updateParentPreview();
      updateOtherParent();
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'parent-select') { updateParentPreview(); updateOtherParent(); }
    if (e.target.dataset.roleFor) {
      const m = state.members.find((x) => x.id === e.target.dataset.roleFor);
      const label = roleLabel(e.target.value);
      const can = ROLES[e.target.value].can.map((c) => t(c)).join(', ').toLowerCase();
      if (confirm(`${t("Change {name}'s role to {role}?", { name: m.full_name || m.email, role: label })}\n\n${t('{role}s can: {list}.', { role: label, list: can })}`)) {
        memberOp(m.id, 'role', e.target.value);
      } else {
        e.target.value = m.role;
      }
    }
    if (e.target.id === 'is-living') document.getElementById('death-wrap').hidden = e.target.checked;
    if (e.target.id === 'photo-input' && e.target.files[0]) {
      const url = URL.createObjectURL(e.target.files[0]);
      document.getElementById('photo-preview').innerHTML = `<img class="photo" src="${url}" alt="">`;
    }
  });

  // On phones the on-screen keyboard can cover the field being typed in. While a field
  // is focused, add room below the page and scroll the field into the visible area.
  const isField = (el) => el?.matches?.('input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select');
  function keepFieldVisible() {
    const el = document.activeElement;
    if (!isField(el) || el.closest('dialog, .chat-panel')) return;
    const vv = window.visualViewport;
    const r = el.getBoundingClientRect();
    const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    if (r.bottom > visibleBottom - 16 || r.top < 8) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  document.addEventListener('focusin', (e) => {
    if (!isField(e.target)) return;
    document.body.classList.add('typing');
    setTimeout(keepFieldVisible, 350); // after the keyboard has opened
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => { if (!isField(document.activeElement)) document.body.classList.remove('typing'); }, 150);
  });
  window.visualViewport?.addEventListener('resize', () => setTimeout(keepFieldVisible, 50));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const res = document.getElementById('results');
      if (res && !res.hidden) res.hidden = true;
    }
  });

  document.addEventListener('submit', async (e) => {
    const form = e.target;
    e.preventDefault();
    const fd = new FormData(form);
    const btn = form.querySelector('button[type=submit]');
    const busy = async (fn) => {
      btn.disabled = true;
      try { await fn(); } finally { btn.disabled = false; }
    };
    switch (form.id) {
      case 'login-form':
        await busy(async () => {
          const { error } = await sb.auth.signInWithPassword({ email: fd.get('email'), password: fd.get('password') });
          if (error) toast(error.message === 'Invalid login credentials' ? t('Wrong email or password.') : error.message, 'error');
        });
        break;
      case 'signup-form':
        await busy(async () => {
          const { data, error } = await sb.auth.signUp({
            email: fd.get('email'),
            password: fd.get('password'),
            options: { data: { full_name: fd.get('full_name').trim() }, emailRedirectTo: location.origin + location.pathname },
          });
          if (error) return toast(error.message, 'error');
          if (!data.session) {
            $app.innerHTML = `<div class="center-screen"><div class="panel narrow">
              <h1>${t('Check your email')}</h1>
              <p>${t('We sent a confirmation link to <b>{email}</b>. Open it to confirm your address, then log in. A family admin will approve your membership after that.', { email: esc(fd.get('email')) })}</p>
              <div class="actions"><button class="btn primary" data-action="auth-mode" data-mode="login">${t('Back to log in')}</button></div>
            </div></div>`;
          }
        });
        break;
      case 'forgot-form':
        await busy(async () => {
          const { error } = await sb.auth.resetPasswordForEmail(fd.get('email'), { redirectTo: location.origin + location.pathname });
          if (error) return toast(friendlyError(error), 'error');
          toast(t('If that email has an account, a reset link is on its way.'), 'ok');
          renderAuth('login');
        });
        break;
      case 'recovery-form':
        await busy(async () => {
          const { error } = await sb.auth.updateUser({ password: fd.get('password') });
          if (error) return toast(error.message, 'error');
          state.recovering = false;
          toast(t('Password updated.'), 'ok');
          route();
        });
        break;
      case 'site-form': {
        const val = (k) => (fd.get(k) || '').toString().trim() || null;
        const rec = { title_en: val('title_en'), title_ne: val('title_ne'), tagline_en: val('tagline_en'), tagline_ne: val('tagline_ne'), updated_by: uid(), updated_at: new Date().toISOString() };
        if (!rec.title_en) { toast(t('Please enter a name.'), 'error'); break; }
        await busy(async () => {
          const { data, error } = await sb.from('site_settings').update(rec).eq('id', 1).select().maybeSingle();
          if (error || !data) { toast(error ? friendlyError(error) : t('You do not have permission to do that.'), 'error'); return; }
          setSite(data);
          renderApp();
          toast(t('Site settings saved.'), 'ok');
        });
        break;
      }
      case 'person-form':
        await savePerson(form);
        break;
      case 'wiz-me': {
        const w = state.wiz;
        const file = fd.get('photo');
        w.me = {
          full_name: fd.get('full_name').trim(),
          gender: fd.get('gender'),
          birth_date: fd.get('birth_date'),
          birth_place: fd.get('birth_place').trim(),
          current_address: fd.get('current_address').trim(),
          photo: file && file.size ? file : w.me.photo,
        };
        w.step = 'ancestor';
        w.query = '';
        renderConnect();
        window.scrollTo(0, 0);
        break;
      }
      case 'wiz-new': {
        const w = state.wiz;
        const living = fd.get('is_living') === 'on';
        w.chain.push({
          full_name: fd.get('full_name').trim(),
          gender: fd.get('relation'),
          birth_date: fd.get('birth_date') || null,
          is_living: living,
        });
        w.query = '';
        renderConnect();
        window.scrollTo(0, 0);
        break;
      }
      default: break;
    }
  });
})();
