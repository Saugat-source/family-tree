(() => {
  'use strict';

  const cfg = window.FAMILY_TREE_CONFIG || {};
  const siteTitle = cfg.siteTitle || 'Family Tree';
  const $app = document.getElementById('app');
  const $modal = document.getElementById('modal');
  const $modalBody = document.getElementById('modal-body');
  const $toasts = document.getElementById('toasts');
  document.title = siteTitle;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

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
    $app.innerHTML = '<div class="center-screen"><div class="panel narrow"><h1>Could not load</h1><p>Check your internet connection and reload the page.</p></div></div>';
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
    photos: new Map(),
    collapsed: new Set(),
    view: 'tree',
    recovering: false,
  };

  const uid = () => state.session?.user?.id;
  // Roles, most powerful first. Kept in step with the database rules in supabase-schema.sql.
  const ROLES = {
    admin: { label: 'Admin', can: ['See the whole tree', 'Add people and new top ancestors', 'Edit and delete anyone', 'Approve members and change roles'] },
    editor: { label: 'Editor', can: ['See the whole tree', 'Add people and new top ancestors', 'Edit and delete anyone'] },
    member: { label: 'Member', can: ['See the whole tree', 'Add people', 'Edit themselves and people they added'] },
    viewer: { label: 'Viewer', can: ['See the whole tree'] },
  };
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
    if (/persons_user_idx|duplicate key/i.test(m)) return 'Your account is already linked to another person in the tree.';
    if (/row-level security/i.test(m)) return 'You do not have permission to do that.';
    if (/foreign key|violates.*persons_parent/i.test(m)) return 'This person still has children in the tree.';
    return m;
  }

  function lineage(p) {
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

  const year = (d) => (d ? String(d).slice(0, 4) : '');
  function lifespan(p) {
    const b = year(p.birth_date);
    const d = year(p.death_date);
    if (!p.is_living) return b || d ? `${b || '?'} – ${d || '?'}` : 'Late';
    return b ? `b. ${b}` : '';
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

  const fmtDate = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '');
  const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][((n % 100) - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

  async function resizeImage(file, max = 900) {
    let img;
    try { img = await createImageBitmap(file); } catch {
      throw new Error('Could not read that image. Please choose a JPG or PNG photo.');
    }
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not process that image.'))), 'image/jpeg', 0.85,
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
    for (const p of state.persons) {
      const key = p.parent_id && state.byId.has(p.parent_id) ? p.parent_id : null;
      if (!state.kids.has(key)) state.kids.set(key, []);
      state.kids.get(key).push(p);
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

  async function route() {
    if (state.recovering) return renderRecovery();
    if (!state.session) return renderAuth('login');
    const { data, error } = await sb.from('profiles').select('*').eq('id', uid()).maybeSingle();
    if (error) return renderMessage('Something went wrong', error.message);
    state.profile = data;
    if (!data || data.status !== 'approved') return renderPending(data);
    try {
      await loadPersons();
    } catch (e) {
      return renderMessage('Could not load the family tree', friendlyError(e));
    }
    renderApp();
  }

  function renderMessage(title, body) {
    $app.innerHTML = `
      <div class="center-screen"><div class="panel narrow">
        <h1>${esc(title)}</h1><p>${esc(body)}</p>
        <div class="actions"><button class="btn" data-action="logout">Log out</button></div>
      </div></div>`;
  }

  // ---------------------------------------------------------------- auth screens

  function brandBlock() {
    return `
      <div class="brand-block">
        <svg class="brand-mark" viewBox="0 0 48 48" aria-hidden="true"><path d="M24 44V26M24 26c-6 0-11-4-11-10 0-5 4-9 9-9 1-3 4-5 7-4 4 1 7 4 7 8 3 1 5 4 4 8-1 4-5 7-9 7h-7zM24 34l-6-4M24 30l6-3" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <h1>${esc(siteTitle)}</h1>
        <p class="muted">A private space for our family to record who we are and where we come from.</p>
      </div>`;
  }

  function renderAuth(mode) {
    const tabs = `
      <div class="seg" role="tablist">
        <button role="tab" class="${mode === 'login' ? 'on' : ''}" data-action="auth-mode" data-mode="login">Log in</button>
        <button role="tab" class="${mode === 'signup' ? 'on' : ''}" data-action="auth-mode" data-mode="signup">Become a member</button>
      </div>`;
    let form;
    if (mode === 'login') {
      form = `
        <form id="login-form" class="stack">
          <label>Email<input name="email" type="email" required autocomplete="email"></label>
          <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
          <button class="btn primary" type="submit">Log in</button>
          <button class="link" type="button" data-action="auth-mode" data-mode="forgot">Forgot password?</button>
        </form>`;
    } else if (mode === 'signup') {
      form = `
        <form id="signup-form" class="stack">
          <label>Full name<input name="full_name" required autocomplete="name"></label>
          <label>Email<input name="email" type="email" required autocomplete="email"></label>
          <label>Password<input name="password" type="password" required minlength="8" autocomplete="new-password"><small class="muted">At least 8 characters.</small></label>
          <button class="btn primary" type="submit">Request membership</button>
          <p class="muted small">A family admin will check and approve your account before you can see the tree.</p>
        </form>`;
    } else {
      form = `
        <form id="forgot-form" class="stack">
          <p class="muted">Enter your email and we will send you a link to set a new password.</p>
          <label>Email<input name="email" type="email" required autocomplete="email"></label>
          <button class="btn primary" type="submit">Send reset link</button>
          <button class="link" type="button" data-action="auth-mode" data-mode="login">Back to log in</button>
        </form>`;
    }
    $app.innerHTML = `
      <div class="center-screen"><div class="panel narrow auth">
        ${brandBlock()}
        ${mode === 'forgot' ? '' : tabs}
        ${form}
      </div></div>`;
  }

  function renderRecovery() {
    $app.innerHTML = `
      <div class="center-screen"><div class="panel narrow">
        <h1>Set a new password</h1>
        <form id="recovery-form" class="stack">
          <label>New password<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
          <button class="btn primary" type="submit">Save password</button>
        </form>
      </div></div>`;
  }

  function renderPending(profile) {
    const name = profile?.full_name || state.session.user.email;
    const body = profile?.status === 'rejected'
      ? '<p>Your membership request was not approved. If you think this is a mistake, please contact the family admin.</p>'
      : `<p>Thank you for joining. A family admin needs to confirm who you are before you can see and add to the tree.</p>
         <p class="muted">Come back later, or press <b>Check again</b> once the admin tells you that you are approved.</p>`;
    $app.innerHTML = `
      <div class="center-screen"><div class="panel narrow">
        <span class="pill ${profile?.status === 'rejected' ? 'bad' : 'wait'}">${profile?.status === 'rejected' ? 'Not approved' : 'Waiting for approval'}</span>
        <h1>Namaste, ${esc(name)}</h1>
        ${body}
        <div class="actions">
          <button class="btn" data-action="logout">Log out</button>
          <button class="btn primary" data-action="recheck">Check again</button>
        </div>
      </div></div>`;
  }

  // ---------------------------------------------------------------- main layout

  function renderApp() {
    const p = state.profile;
    if ((state.view === 'connect' && (myPerson() || !canContribute()))
      || (state.view === 'form' && !canContribute())
      || (state.view === 'admin' && !isAdmin())) state.view = 'tree';
    const nav = [
      ['tree', 'Family tree'],
      ...(myPerson() || !canContribute() ? [] : [['connect', 'Connect me']]),
      ...(canContribute() ? [['form', 'Add person']] : []),
      ...(isAdmin() ? [['admin', 'Members & roles']] : []),
    ];
    $app.innerHTML = `
      <header class="topbar">
        <div class="brand"><svg class="brand-mark sm" viewBox="0 0 48 48" aria-hidden="true"><path d="M24 44V26M24 26c-6 0-11-4-11-10 0-5 4-9 9-9 1-3 4-5 7-4 4 1 7 4 7 8 3 1 5 4 4 8-1 4-5 7-9 7h-7z" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>${esc(siteTitle)}</div>
        <nav class="tabs">
          ${nav.map(([v, label]) => `<button class="${state.view === v ? 'on' : ''}" data-action="view" data-view="${v}">${label}</button>`).join('')}
        </nav>
        <div class="who">
          <span class="who-name">${esc(p.full_name || p.email)} <span class="pill tiny role-${role()}">${ROLES[role()].label}</span></span>
          <button class="btn ghost sm" data-action="logout">Log out</button>
        </div>
      </header>
      <main id="main"></main>`;
    renderView();
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
    const gens = state.persons.reduce((m, p) => Math.max(m, lineage(p).length), 0);
    main.innerHTML = `
      <section class="toolbar">
        <div class="search">
          <input id="search" type="search" placeholder="Search for a name…" autocomplete="off" aria-label="Search for a name">
          <div id="results" class="results" hidden></div>
        </div>
        <div class="tool-btns">
          ${me ? '<button class="btn sm" data-action="find-me">Find me</button>' : ''}
          <button class="btn ghost sm" data-action="expand-all">Expand all</button>
          <button class="btn ghost sm" data-action="collapse-all">Collapse all</button>
        </div>
      </section>
      <p class="stats muted">${state.persons.length} ${state.persons.length === 1 ? 'person' : 'people'} · ${gens} ${gens === 1 ? 'generation' : 'generations'}</p>
      ${me || !canContribute() ? '' : `<div class="callout">
          <div><b>You're not in the tree yet.</b> Answer a few questions about yourself and your parents,
          and we'll find where you connect to the family.</div>
          <button class="btn primary sm" data-action="view" data-view="connect">Connect me to the tree</button>
        </div>`}
      <div class="tree" id="tree"></div>`;
    renderTreeBody();
  }

  function renderTreeBody() {
    const el = document.getElementById('tree');
    if (!el) return;
    const roots = state.kids.get(null) || [];
    el.innerHTML = roots.length
      ? `<ul>${roots.map((r) => nodeHtml(r, 1)).join('')}</ul>`
      : '<p class="muted">No one is in the tree yet.</p>';
  }

  function nodeHtml(p, gen) {
    const kids = state.kids.get(p.id) || [];
    const open = !state.collapsed.has(p.id);
    const mine = p.user_id && p.user_id === uid();
    const meta = [`${ordinal(gen)} gen`, lifespan(p), kids.length ? `${kids.length} ${kids.length === 1 ? 'child' : 'children'}` : '']
      .filter(Boolean).join(' · ');
    return `
      <li>
        <div class="node">
          ${kids.length
            ? `<button class="twisty" data-action="toggle" data-id="${p.id}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} children of ${esc(p.full_name)}">${open ? '−' : '+'}</button>`
            : '<span class="twisty leaf" aria-hidden="true"></span>'}
          <button class="card${mine ? ' me' : ''}${p.is_living ? '' : ' late'}" data-action="open" data-id="${p.id}" id="n-${p.id}">
            ${avatar(p)}
            <span class="card-text">
              <span class="name">${esc(p.full_name)}${mine ? ' <span class="pill tiny">You</span>' : ''}</span>
              <span class="meta">${esc(meta)}</span>
            </span>
          </button>
        </div>
        ${kids.length && open ? `<ul>${kids.map((k) => nodeHtml(k, gen + 1)).join('')}</ul>` : ''}
      </li>`;
  }

  function reveal(id) {
    const p = state.byId.get(id);
    if (!p) return;
    for (const a of lineage(p).slice(0, -1)) state.collapsed.delete(a.id);
    renderTreeBody();
    const el = document.getElementById(`n-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 2000);
    }
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
            <span class="path">${esc(lineage(p).slice(0, -1).map((a) => a.full_name).join(' › ') || 'Top ancestor')}</span></span>
          </button>`).join('')
      : '<p class="muted pad">No one found with that name.</p>';
  }

  // ---------------------------------------------------------------- person details

  function openDetail(id) {
    const p = state.byId.get(id);
    if (!p) return;
    const path = lineage(p);
    const kids = state.kids.get(p.id) || [];
    const parent = p.parent_id && state.byId.get(p.parent_id);
    const rows = [
      ['Born', [fmtDate(p.birth_date), p.birth_place].filter(Boolean).join(', ')],
      ['Died', p.is_living ? '' : fmtDate(p.death_date) || 'Late'],
      ['Spouse', p.spouse_name],
      ['Occupation', p.occupation],
      ['Lives in', p.current_address],
      ['Phone', p.phone],
      ['Email', p.email],
    ].filter(([, v]) => v);
    const photo = p.photo_path && state.photos.get(p.photo_path);
    $modalBody.innerHTML = `
      <button class="close" data-action="close-modal" aria-label="Close">×</button>
      <div class="detail-head">
        ${photo ? `<img class="photo" src="${esc(photo)}" alt="Photo of ${esc(p.full_name)}">` : `<span class="photo initials">${esc(initials(p.full_name))}</span>`}
        <div>
          <p class="eyebrow">${ordinal(path.length)} generation${p.is_living ? '' : ' · Late'}</p>
          <h2>${esc(p.full_name)}</h2>
          ${parent ? `<p class="muted">${p.gender === 'female' ? 'Daughter' : p.gender === 'male' ? 'Son' : 'Child'} of ${esc(parent.full_name)}</p>` : '<p class="muted">Top ancestor</p>'}
        </div>
      </div>
      ${path.length > 1 ? `<nav class="crumbs" aria-label="Ancestry">${path.map((a, i) => (i === path.length - 1
        ? `<span>${esc(a.full_name)}</span>`
        : `<button class="link" data-action="open" data-id="${a.id}">${esc(a.full_name)}</button><span class="sep">›</span>`)).join('')}</nav>` : ''}
      ${rows.length ? `<dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
      ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
      ${kids.length ? `<h3>Children</h3><div class="chips">${kids.map((k) => `<button class="chip" data-action="open" data-id="${k.id}">${avatar(k, 'xs')}${esc(k.full_name)}</button>`).join('')}</div>` : ''}
      <div class="actions spread">
        <div>
          ${canEditAll() && !kids.length ? `<button class="btn danger sm" data-action="delete" data-id="${p.id}">Delete</button>` : ''}
        </div>
        <div class="actions">
          <button class="btn ghost sm" data-action="show-in-tree" data-id="${p.id}">Show in tree</button>
          ${canEdit(p) ? `<button class="btn sm" data-action="edit" data-id="${p.id}">Edit</button>` : ''}
          ${canContribute() ? `<button class="btn primary sm" data-action="add-child" data-id="${p.id}">Add child</button>` : ''}
        </div>
      </div>`;
    if (!$modal.open) $modal.showModal();
    $modal.scrollTop = 0;
  }

  // ---------------------------------------------------------------- add / edit form

  function parentOptions(excluded, selected, filter = '') {
    const f = filter.trim().toLowerCase();
    const items = state.persons
      .filter((p) => !excluded.has(p.id))
      .map((p) => ({ id: p.id, label: lineage(p).map((a) => a.full_name).join(' › '), name: p.full_name }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const shown = items.filter((i) => !f || i.name.toLowerCase().includes(f) || i.id === selected);
    const rootOpt = canEditAll() ? `<option value="" ${!selected ? 'selected' : ''}>— None (a new top ancestor) —</option>` : '<option value="" disabled ' + (!selected ? 'selected' : '') + '>— Choose the parent —</option>';
    return rootOpt + shown.map((i) => `<option value="${i.id}" ${i.id === selected ? 'selected' : ''}>${esc(i.label)}</option>`).join('');
  }

  function renderForm({ editId, parentId } = {}) {
    const main = document.getElementById('main');
    const p = editId ? state.byId.get(editId) : null;
    const excluded = p ? new Set([p.id, ...descendants(p.id)]) : new Set();
    const selected = p ? p.parent_id : parentId || null;
    const me = myPerson();
    const canClaim = !me || (p && me.id === p.id);
    const photo = p?.photo_path && state.photos.get(p.photo_path);
    const v = (k) => esc(p?.[k] ?? '');
    main.innerHTML = `
      <section class="panel form-panel">
        <h2>${p ? `Edit ${esc(p.full_name)}` : 'Add a family member'}</h2>
        <form id="person-form" class="stack" data-edit-id="${p ? p.id : ''}">
          <fieldset>
            <legend>Place in the family</legend>
            <p class="muted small">Choose this person's father or mother. Ancestors are shown in order, from the oldest.</p>
            <input id="parent-filter" type="search" placeholder="Type a name to narrow the list…" aria-label="Filter parents">
            <label class="sr">Parent<select name="parent_id" id="parent-select" ${canEditAll() ? '' : 'required'}>${parentOptions(excluded, selected)}</select></label>
            <div id="parent-preview" class="path-preview"></div>
          </fieldset>

          <fieldset>
            <legend>Personal details</legend>
            <div class="grid">
              <label class="span2">Full name *<input name="full_name" required value="${v('full_name')}"></label>
              <label>Gender
                <select name="gender">
                  <option value="">—</option>
                  ${['male', 'female', 'other'].map((g) => `<option value="${g}" ${p?.gender === g ? 'selected' : ''}>${g[0].toUpperCase() + g.slice(1)}</option>`).join('')}
                </select>
              </label>
              <label>Date of birth<input name="birth_date" type="date" value="${v('birth_date')}"></label>
              <label class="check span2"><input type="checkbox" name="is_living" id="is-living" ${!p || p.is_living ? 'checked' : ''}> Living</label>
              <label id="death-wrap" ${!p || p.is_living ? 'hidden' : ''}>Date of death<input name="death_date" type="date" value="${v('death_date')}"></label>
              <label>Place of birth<input name="birth_place" value="${v('birth_place')}"></label>
              <label>Lives in<input name="current_address" value="${v('current_address')}" placeholder="City, country"></label>
              <label>Occupation<input name="occupation" value="${v('occupation')}"></label>
              <label>Spouse's name<input name="spouse_name" value="${v('spouse_name')}"></label>
              <label>Phone<input name="phone" type="tel" value="${v('phone')}"></label>
              <label>Email<input name="email" type="email" value="${v('email')}"></label>
              <label class="span2">About<textarea name="bio" rows="4" placeholder="Stories, achievements, memories…">${v('bio')}</textarea></label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Photo</legend>
            <div class="photo-row">
              <span id="photo-preview">${photo ? `<img class="photo" src="${esc(photo)}" alt="">` : '<span class="photo initials">?</span>'}</span>
              <div class="stack tight">
                <input name="photo" id="photo-input" type="file" accept="image/*">
                ${photo ? '<label class="check"><input type="checkbox" name="remove_photo"> Remove current photo</label>' : ''}
                <small class="muted">The photo is resized before it is uploaded.</small>
              </div>
            </div>
          </fieldset>

          ${canClaim ? `<label class="check claim"><input type="checkbox" name="is_me" ${p && me && me.id === p.id ? 'checked' : ''}>
            <span><b>This is me.</b> Link this person to my account so I can always edit my own details.</span></label>` : ''}

          <div class="actions">
            <button class="btn ghost" type="button" data-action="view" data-view="tree">Cancel</button>
            <button class="btn primary" type="submit">${p ? 'Save changes' : 'Add to family tree'}</button>
          </div>
        </form>
      </section>`;
    updateParentPreview();
  }

  function updateParentPreview() {
    const sel = document.getElementById('parent-select');
    const out = document.getElementById('parent-preview');
    if (!sel || !out) return;
    const parent = state.byId.get(sel.value);
    out.innerHTML = parent
      ? `${lineage(parent).map((a) => `<span>${esc(a.full_name)}</span>`).join('<span class="sep">›</span>')}<span class="sep">›</span><span class="new">this person</span>`
      : (canEditAll() ? '<span class="muted">Will be added as a new top ancestor.</span>' : '');
  }

  async function savePerson(form) {
    const btn = form.querySelector('button[type=submit]');
    const fd = new FormData(form);
    const editId = form.dataset.editId || null;
    const existing = editId ? state.byId.get(editId) : null;
    const str = (k) => (fd.get(k) || '').toString().trim() || null;
    const isLiving = fd.get('is_living') === 'on';
    const rec = {
      parent_id: str('parent_id'),
      full_name: str('full_name'),
      gender: str('gender'),
      birth_date: str('birth_date'),
      is_living: isLiving,
      death_date: isLiving ? null : str('death_date'),
      birth_place: str('birth_place'),
      current_address: str('current_address'),
      occupation: str('occupation'),
      spouse_name: str('spouse_name'),
      phone: str('phone'),
      email: str('email'),
      bio: str('bio'),
    };
    if (!rec.full_name) return toast('Please enter a name.', 'error');
    if (!rec.parent_id && !canEditAll() && !(existing && !existing.parent_id)) return toast('Please choose a parent.', 'error');

    if (form.querySelector('[name=is_me]')) {
      if (fd.get('is_me') === 'on') rec.user_id = uid();
      else if (existing && existing.user_id === uid()) rec.user_id = null;
    }

    btn.disabled = true;
    btn.textContent = 'Saving…';
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
      toast(existing ? 'Changes saved.' : `${rec.full_name} was added to the tree.`, 'ok');
      setView('tree');
      reveal(savedId);
    } catch (e) {
      toast(friendlyError(e), 'error');
      btn.disabled = false;
      btn.textContent = existing ? 'Save changes' : 'Add to family tree';
    }
  }

  async function deletePerson(id) {
    const p = state.byId.get(id);
    if (!p || !confirm(`Delete ${p.full_name} from the family tree? This cannot be undone.`)) return;
    const { error } = await sb.from('persons').delete().eq('id', id);
    if (error) return toast(friendlyError(error), 'error');
    if (p.photo_path) sb.storage.from(PHOTO_BUCKET).remove([p.photo_path]);
    $modal.close();
    await loadPersons();
    renderView();
    toast(`${p.full_name} was deleted.`, 'ok');
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
      { label: w.me.full_name || 'You', cls: 'you' },
      ...w.chain.map((a) => ({ label: a.full_name, cls: 'new' })),
      anchor ? { label: anchor.full_name, cls: 'found' } : { label: '?', cls: 'unknown' },
    ];
    return `<ol class="wiz-chain" aria-label="Your line so far">${items.map((it) => `
      <li class="${it.cls}"><span class="dot">${it.cls === 'unknown' ? '?' : esc(initials(it.label))}</span><span class="lbl">${esc(it.label)}</span></li>`).join('')}
    </ol>`;
  }

  function matchCard(p, action, buttonLabel) {
    const path = lineage(p).slice(0, -1).map((a) => a.full_name).join(' › ');
    const kids = (state.kids.get(p.id) || []).map((k) => k.full_name);
    return `
      <div class="match">
        ${avatar(p)}
        <div class="match-text">
          <div class="name">${esc(p.full_name)} <span class="muted small">${esc(lifespan(p))}</span></div>
          <div class="muted small">${path ? `Descendant of ${esc(path)}` : 'Top ancestor'}</div>
          ${kids.length ? `<div class="muted small">Parent of ${esc(kids.join(', '))}</div>` : ''}
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
        <h2>Let's connect you to the family tree</h2>
        <p class="muted">First, tell us about yourself. Next we'll ask about your parents and look for them in the tree.</p>
        <form id="wiz-me" class="stack">
          <div class="grid">
            <label class="span2">Your full name *<input name="full_name" id="wiz-me-name" required value="${esc(m.full_name)}"></label>
            <label>Gender
              <select name="gender"><option value="">—</option>
                ${['male', 'female', 'other'].map((g) => `<option value="${g}" ${m.gender === g ? 'selected' : ''}>${g[0].toUpperCase() + g.slice(1)}</option>`).join('')}
              </select></label>
            <label>Date of birth<input name="birth_date" type="date" value="${esc(m.birth_date)}"></label>
            <label>Place of birth<input name="birth_place" value="${esc(m.birth_place)}"></label>
            <label>Lives in<input name="current_address" value="${esc(m.current_address)}" placeholder="City, country"></label>
            <label class="span2">Your photo<input name="photo" type="file" accept="image/*">
              ${m.photo ? `<small class="muted">Selected: ${esc(m.photo.name)}</small>` : ''}</label>
          </div>
          <div id="wiz-already"></div>
          <div class="actions"><button class="btn primary" type="submit">Next: your parents</button></div>
        </form>`;
    } else if (w.step === 'ancestor') {
      const i = w.chain.length;
      const prev = i ? w.chain[i - 1].full_name : null;
      const who = prev ? `${esc(prev)}'s` : 'your';
      body = `
        <p class="eyebrow">Step ${i + 2}</p>
        <h2>Who is ${who} father or mother?</h2>
        <p class="muted">Start typing their name. If they're already in the tree, choose them and you're connected.</p>
        <input id="wiz-search" type="search" autocomplete="off" placeholder="Type a name, e.g. Santa Bahadur" value="${esc(w.query)}">
        <div id="wiz-matches" class="matches"></div>
        ${i < MAX_NEW_GENERATIONS ? `
        <details class="wiz-new" ${w.query ? 'open' : ''}>
          <summary>Not in the tree yet? Add them</summary>
          <form id="wiz-new" class="stack">
            <div class="seg two">
              <label><input type="radio" name="relation" value="male" checked> Father</label>
              <label><input type="radio" name="relation" value="female"> Mother</label>
            </div>
            <div class="grid">
              <label class="span2">Full name *<input name="full_name" id="wiz-new-name" required value="${esc(w.query)}"></label>
              <label>Date of birth<input name="birth_date" type="date"></label>
              <label class="check"><input type="checkbox" name="is_living" checked> Living</label>
            </div>
            <div class="actions"><button class="btn" type="submit">Add, then ask about their parents</button></div>
          </form>
        </details>` : '<p class="muted">That\'s many generations. Ask a family admin to help connect the rest.</p>'}
        <div class="actions spread"><button class="btn ghost" data-action="wiz-back">Back</button><span></span></div>`;
    } else {
      const anchor = state.byId.get(w.anchorId);
      const existing = lineage(anchor);
      const fresh = [...w.chain].reverse();
      body = `
        <p class="eyebrow">Last step</p>
        <h2>Check your line</h2>
        <p class="muted">This is how you'll appear in the family tree. ${fresh.length ? `${fresh.length} new ${fresh.length === 1 ? 'person' : 'people'} will be added along with you.` : ''}</p>
        <ol class="wiz-path">
          ${existing.map((a) => `<li class="old">${esc(a.full_name)}<span class="tag">in tree</span></li>`).join('')}
          ${fresh.map((a) => `<li class="new">${esc(a.full_name)}<span class="tag">new</span></li>`).join('')}
          <li class="you">${esc(w.me.full_name)}<span class="tag">you</span></li>
        </ol>
        <div class="actions spread">
          <button class="btn ghost" data-action="wiz-back">Back</button>
          <button class="btn primary" data-action="wiz-confirm">Add me to the family tree</button>
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
      ? `<div class="callout plain"><div><b>Are you already in the tree?</b> Someone may have added you. If so, choose yourself.</div></div>
         <div class="matches">${hits.map((p) => matchCard(p, 'wiz-claim', 'This is me')).join('')}</div>`
      : '';
  }

  function updateWizMatches() {
    const box = document.getElementById('wiz-matches');
    if (!box) return;
    const q = state.wiz.query;
    if (tokens(q).length === 0) { box.innerHTML = ''; return; }
    const hits = nameMatches(q);
    box.innerHTML = hits.length
      ? hits.map((p) => matchCard(p, 'wiz-pick', 'Yes, this is them')).join('')
      : `<p class="muted small pad">No one called “${esc(q)}” in the tree yet. You can add them below.</p>`;
  }

  async function confirmConnect(btn) {
    const w = state.wiz;
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      let parentId = w.anchorId;
      for (const a of [...w.chain].reverse()) {
        const { data, error } = await sb.from('persons')
          .insert({ ...a, parent_id: parentId, created_by: uid() }).select('id').single();
        if (error) throw error;
        parentId = data.id;
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
        .insert({ ...me, is_living: true, parent_id: parentId, user_id: uid(), created_by: uid() }).select('id').single();
      if (error) throw error;
      state.wiz = null;
      await loadPersons();
      state.view = 'tree';
      renderApp();
      reveal(data.id);
      toast('Welcome to the family tree!', 'ok');
    } catch (e) {
      toast(friendlyError(e), 'error');
      btn.disabled = false;
      btn.textContent = 'Add me to the family tree';
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
    toast('You are now linked to your place in the tree. Check your details and save.', 'ok');
  }

  // ---------------------------------------------------------------- admin

  async function renderAdmin() {
    const main = document.getElementById('main');
    main.innerHTML = '<p class="muted">Loading members…</p>';
    const { data, error } = await sb.from('profiles').select('*').order('created_at', { ascending: false });
    if (state.view !== 'admin') return;
    if (error) { main.innerHTML = `<p class="muted">${esc(error.message)}</p>`; return; }
    state.members = data;
    state.memberFilter ||= { q: '', role: 'all' };
    main.innerHTML = `
      <section class="panel">
        <h2>Roles</h2>
        <p class="muted small">Every approved member has one role. Change someone's role from the list below.</p>
        <div class="role-grid" id="role-grid"></div>
      </section>
      <div id="member-lists"></div>`;
    renderMemberLists();
  }

  function roleSelect(m, attrs = '') {
    const current = m.role || 'member';
    return `<select class="role-select" aria-label="Role for ${esc(m.full_name || m.email)}" ${attrs}>
      ${Object.entries(ROLES).map(([k, r]) => `<option value="${k}" ${k === current ? 'selected' : ''}>${r.label}</option>`).join('')}
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
          <span class="role-head"><span class="pill tiny role-${k}">${r.label}</span><span class="count">${n}</span></span>
          <ul>${r.can.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
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
        controls = `<span class="pill tiny role-${m.role}">${ROLES[m.role].label}</span><span class="muted small">Another admin can change your role</span>`;
      } else if (m.status === 'pending') {
        controls = `
          <label class="inline">Approve as ${roleSelect(m, `id="role-new-${m.id}"`)}</label>
          <button class="btn danger sm" data-action="member" data-op="reject" data-id="${m.id}">Reject</button>
          <button class="btn primary sm" data-action="member" data-op="approve" data-id="${m.id}">Approve</button>`;
      } else if (m.status === 'approved') {
        controls = `
          ${roleSelect(m, `data-role-for="${m.id}"`)}
          <button class="btn danger sm" data-action="member" data-op="reject" data-id="${m.id}">Revoke access</button>`;
      } else {
        controls = `
          <label class="inline">Approve as ${roleSelect(m, `id="role-new-${m.id}"`)}</label>
          <button class="btn sm" data-action="member" data-op="approve" data-id="${m.id}">Approve</button>`;
      }
      return `
        <div class="member">
          <div class="member-info">
            <div class="name">${esc(m.full_name || '(no name)')} ${self ? '<span class="pill tiny">You</span>' : ''}</div>
            <div class="muted small">${esc(m.email || '')} · joined ${new Date(m.created_at).toLocaleDateString()}</div>
            ${person ? `<div class="small">In tree as <button class="link" data-action="open" data-id="${person.id}">${esc(lineage(person).map((a) => a.full_name).join(' › '))}</button></div>` : ''}
          </div>
          <div class="actions">${controls}</div>
        </div>`;
    };
    const section = (title, list, empty) => `
      <section class="panel">
        <h2>${title} <span class="count">${list.length}</span></h2>
        ${list.length ? list.map(row).join('') : `<p class="muted">${empty}</p>`}
      </section>`;
    const pending = all.filter((m) => m.status === 'pending' && matches(m));
    const members = approved.filter(matches);
    const rejected = all.filter((m) => m.status === 'rejected' && matches(m));
    const filterNote = f.role === 'all' ? '' : ` · showing ${ROLES[f.role].label.toLowerCase()}s <button class="link" data-action="role-filter" data-role="all">show all</button>`;
    const hadFocus = document.activeElement?.id === 'member-search';
    document.getElementById('member-lists').innerHTML = `
      <div class="toolbar member-tools">
        <div class="search"><input id="member-search" type="search" placeholder="Search members by name or email…" value="${esc(f.q)}" aria-label="Search members"></div>
        <span class="muted small">${approved.length} approved${filterNote}</span>
      </div>
      ${section('Waiting for approval', pending, q ? 'No one waiting matches your search.' : 'No one is waiting. New sign-ups will appear here.')}
      ${section('Members', members, q || f.role !== 'all' ? 'No members match.' : 'No members yet.')}
      ${rejected.length ? section('Not approved', rejected, '') : ''}`;
    if (hadFocus) {
      const s = document.getElementById('member-search');
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    }
  }

  async function memberOp(id, op, newRole) {
    const m = (state.members || []).find((x) => x.id === id);
    const name = m?.full_name || m?.email || 'this member';
    let patch;
    let msg;
    if (op === 'approve') {
      const r = document.getElementById(`role-new-${id}`)?.value || 'member';
      patch = { status: 'approved', role: r };
      msg = `${name} approved as ${ROLES[r].label}.`;
    } else if (op === 'reject') {
      if (m?.status === 'approved' && !confirm(`Remove ${name}'s access to the family tree?`)) return;
      patch = { status: 'rejected', role: 'member' };
      msg = m?.status === 'approved' ? 'Access removed.' : 'Request rejected.';
    } else {
      patch = { role: newRole };
      msg = `${name} is now ${ROLES[newRole].label === 'Admin' ? 'an' : 'a'} ${ROLES[newRole].label}.`;
    }
    const { error } = await sb.from('profiles').update(patch).eq('id', id);
    if (error) { toast(friendlyError(error), 'error'); renderMemberLists(); return; }
    Object.assign(m, patch);
    toast(msg, 'ok');
    renderMemberLists();
  }

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
      case 'add-child': $modal.close(); setView('form', { parentId: id }); break;
      case 'edit': $modal.close(); setView('form', { editId: id }); break;
      case 'delete': deletePerson(id); break;
      case 'member': memberOp(id, el.dataset.op); break;
      case 'role-filter':
        state.memberFilter.role = state.memberFilter.role === el.dataset.role ? 'all' : el.dataset.role;
        renderMemberLists();
        break;
      case 'wiz-claim':
        if (confirm(`Link your account to ${state.byId.get(id)?.full_name}? Only do this if it is really you.`)) claimPerson(id);
        break;
      case 'wiz-pick': state.wiz.anchorId = id; state.wiz.step = 'review'; renderConnect(); window.scrollTo(0, 0); break;
      case 'wiz-back': {
        const w = state.wiz;
        if (w.step === 'review') { w.anchorId = null; w.step = 'ancestor'; w.query = ''; }
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
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'parent-select') updateParentPreview();
    if (e.target.dataset.roleFor) {
      const m = state.members.find((x) => x.id === e.target.dataset.roleFor);
      const label = ROLES[e.target.value].label;
      if (confirm(`Change ${m.full_name || m.email}'s role to ${label}?\n\n${label}s can: ${ROLES[e.target.value].can.join(', ').toLowerCase()}.`)) {
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
          if (error) toast(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message, 'error');
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
              <h1>Check your email</h1>
              <p>We sent a confirmation link to <b>${esc(fd.get('email'))}</b>. Open it to confirm your address,
              then log in. A family admin will approve your membership after that.</p>
              <div class="actions"><button class="btn primary" data-action="auth-mode" data-mode="login">Back to log in</button></div>
            </div></div>`;
          }
        });
        break;
      case 'forgot-form':
        await busy(async () => {
          const { error } = await sb.auth.resetPasswordForEmail(fd.get('email'), { redirectTo: location.origin + location.pathname });
          if (error) return toast(error.message, 'error');
          toast('If that email has an account, a reset link is on its way.', 'ok');
          renderAuth('login');
        });
        break;
      case 'recovery-form':
        await busy(async () => {
          const { error } = await sb.auth.updateUser({ password: fd.get('password') });
          if (error) return toast(error.message, 'error');
          state.recovering = false;
          toast('Password updated.', 'ok');
          route();
        });
        break;
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
