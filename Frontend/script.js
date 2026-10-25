
(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function add(el, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(typeof child === 'object' && child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [key, val] of Object.entries(attrs)) {
        if (val === null || val === undefined || val === false) continue;
        if (key === 'class') el.className = val;
        else if (key.startsWith('on') && typeof val === 'function') el.addEventListener(key.slice(2), val);
        else if (val === true) el.setAttribute(key, '');
        else el.setAttribute(key, String(val));
      }
    }
    return add(el, children);
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const [key, val] of Object.entries(attrs)) el.setAttribute(key, String(val));
    return add(el, children);
  }

  function icon(name, size = 18) {
    return svgEl('svg', { class: 'icon', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
      svgEl('use', { href: `#i-${name}` }));
  }

  const isNil = (v) => v === null || v === undefined || Number.isNaN(Number(v));
  const num = (v) => (isNil(v) ? '—' : Number(v).toLocaleString());
  const pct = (v) => (isNil(v) ? '—' : `${Math.round(Number(v) * 10) / 10}%`);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const clampPct = (v) => Math.max(0, Math.min(100, Number(v) || 0));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function listJoin(items) {
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }

  function parseDbDate(value) {
    if (!value) return null;
    const text = String(value);
    const d = new Date(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`); // SQLite stores UTC
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(value) {
    const d = parseDbDate(value);
    return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  }
  function fmtDuration(seconds) {
    if (isNil(seconds)) return '—';
    const s = Math.round(Number(seconds));
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }

  /* Accuracy bands mirror the thresholds the backend uses (40% / 70%). */
  function band(accuracy) {
    if (isNil(accuracy)) return 'none';
    if (accuracy < 40) return 'weak';
    if (accuracy < 70) return 'mid';
    return 'strong';
  }
  const BAND_LABEL = { weak: 'Weak', mid: 'Needs practice', strong: 'Strong', none: 'Not rated' };
  const BADGE_ICON = { weak: 'arrow-down', mid: 'minus', strong: 'check', none: 'clock' };
  const STATUS_KIND = { 'Weak': 'weak', 'Needs practice': 'mid', 'Strong so far': 'strong', 'Insufficient data': 'none' };

  class ApiError extends Error {
    constructor(message, status, data) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.data = data;
    }
  }

  const STATUS_MESSAGES = {
    400: 'The request was not valid. Please check your input and try again.',
    401: 'Please sign in to continue.',
    404: 'We could not find what you asked for.',
    409: 'That action conflicts with existing data.',
    422: 'Some of the information provided could not be processed.',
    429: 'You are going a little fast. Please wait a moment and try again.',
    500: 'Something went wrong on the server. Please try again shortly.',
    502: 'The AI service returned an unusable response. Please try again.',
    503: 'The service is temporarily unavailable. Please try again shortly.',
  };

  async function api(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: Object.assign({ Accept: 'application/json' }, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (networkError) {
      throw new ApiError('Could not reach the server. Check your connection and try again.', 0, null);
    }

    let data = null;
    const text = await response.text();
    if (text) {
      try { data = JSON.parse(text); } catch (parseError) { data = null; }
    }

    if (!response.ok) {
      if (response.status === 401 && state.user) handleSessionExpired();
      const serverMessage = data && typeof data.error === 'string' && data.error.trim();
      throw new ApiError(serverMessage || STATUS_MESSAGES[response.status] || `Request failed (${response.status}).`, response.status, data);
    }
    if (data === null) throw new ApiError('The server sent an unexpected response.', response.status, null);
    return data;
  }

  const ENDPOINTS = {
    stats: '/stats',
    attempts: '/attempts',
    recommend: '/recommend',
    weaknesses: '/weaknesses',
    mistakes: '/mistakes',
  };

  /* Cached GETs: one request per endpoint until invalidated. */
  function load(key, force = false) {
    if (!force && state.cache[key]) return state.cache[key];
    const promise = api(ENDPOINTS[key]);
    state.cache[key] = promise;
    promise.catch(() => { if (state.cache[key] === promise) delete state.cache[key]; });
    return promise;
  }

  /* ======================================================================
     3. Application state
     ====================================================================== */
  const freshQuiz = (form) => ({
    phase: 'setup',            // setup | loading | taking | results
    form: Object.assign({ topic: '', difficulty: 'medium', num: 5 }, form),
    data: null,                // /generate_quiz response
    answers: {},               // question index -> option index
    startedAt: null,
    result: null,              // /submit_quiz response
    setupError: '',
    submitting: false,
  });

  const state = {
    user: null,
    route: 'dashboard',
    cache: {},
    quiz: freshQuiz(),
  };

  function resetAppState() {
    state.user = null;
    state.cache = {};
    state.quiz = freshQuiz();
    $('#view').replaceChildren();
    openDrawer(false);
  }

  function handleSessionExpired() {
    if (!state.user) return;
    resetAppState();
    showScreen('auth');
    setAuthMode('login');
    toast('Your session has expired. Please sign in again.', 'error');
  }

  /* ======================================================================
     4. Shared UI components
     ====================================================================== */
  function toast(message, type = 'info', timeout = 5500) {
    const region = $('#toasts');
    while (region.children.length >= 4) region.firstElementChild.remove();
    const iconName = type === 'success' ? 'check' : type === 'error' ? 'alert' : 'info';
    let timer;
    const dismiss = () => {
      clearTimeout(timer);
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 220);
    };
    const node = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' },
      icon(iconName, 18),
      h('p', null, message),
      h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss notification', onclick: dismiss }, icon('x', 16)));
    region.append(node);
    timer = setTimeout(dismiss, timeout);
  }

  function setBusy(button, busy, busyText) {
    if (!button) return;
    const label = $('.btn-label', button) || button;
    if (busy) {
      if (!button.dataset.label) button.dataset.label = label.textContent;
      label.textContent = busyText || 'Working…';
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.classList.add('is-busy');
    } else {
      if (button.dataset.label) { label.textContent = button.dataset.label; delete button.dataset.label; }
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.classList.remove('is-busy');
    }
  }

  function badge(kind, label) {
    return h('span', { class: `badge badge-${kind}` }, icon(BADGE_ICON[kind], 14), label || BAND_LABEL[kind]);
  }

  function bar(value, kind) {
    return h('div', { class: `bar bar-${kind || 'none'}`, 'aria-hidden': 'true' },
      h('div', { class: 'bar-fill', style: `width:${clampPct(value)}%` }));
  }

  function ring(value, { size = 132, stroke = 12, label = 'accuracy', empty = false } = {}) {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const v = clampPct(value);
    const tone = empty ? '' : v >= 70 ? 'is-good' : v >= 40 ? 'is-mid' : 'is-low';
    const text = empty ? 'No data yet' : `${label} ${pct(value)}`;
    return h('div', { class: 'ring', style: `width:${size}px;height:${size}px` },
      svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': text },
        svgEl('circle', { class: 'ring-track', cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': stroke }),
        svgEl('circle', {
          class: `ring-value ${tone}`, cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': stroke,
          'stroke-linecap': 'round', 'stroke-dasharray': c, 'stroke-dashoffset': empty ? c : c * (1 - v / 100),
          transform: `rotate(-90 ${size / 2} ${size / 2})`,
        })),
      h('div', { class: 'ring-center', 'aria-hidden': 'true' },
        h('strong', null, empty ? '—' : pct(value)),
        h('span', null, label)));
  }

  function skeleton(kind = 'card') {
    const line = (cls = '') => h('span', { class: `skeleton skeleton-line ${cls}`.trim() });
    if (kind === 'kpi') {
      return h('div', { class: 'kpi-grid', 'aria-hidden': 'true' },
        [0, 1, 2, 3].map(() => h('div', { class: 'card skeleton-card' }, line('short'), line('tall'))));
    }
    return h('div', { class: 'card skeleton-card', 'aria-hidden': 'true' }, line('short'), line(), line(), line('medium'));
  }

  function emptyState({ iconName = 'info', title, text, action, inline = false }) {
    return h('div', { class: inline ? 'empty-inline' : 'empty' },
      !inline && h('span', { class: 'empty-icon', 'aria-hidden': 'true' }, icon(iconName, 24)),
      title && h(inline ? 'strong' : 'h3', null, title),
      text && h('p', null, text),
      action);
  }

  function errorState(message, onRetry) {
    return h('div', { class: 'card state-error' },
      h('div', { class: 'empty', role: 'alert' },
        h('span', { class: 'empty-icon', 'aria-hidden': 'true' }, icon('alert', 24)),
        h('h3', null, 'We couldn’t load this section'),
        h('p', null, message),
        onRetry && h('button', { class: 'btn btn-secondary', type: 'button', onclick: onRetry }, icon('refresh', 16), 'Try again')));
  }

  /* Renders a skeleton, then swaps in render(data) when the endpoint answers. */
  function asyncBlock(key, render, opts = {}) {
    const box = h('div', { class: 'async-block', 'aria-busy': 'true' },
      skeleton(opts.skeleton), h('span', { class: 'sr-only', role: 'status' }, 'Loading…'));
    load(key).then(
      (data) => {
        if (!box.isConnected) return;
        box.removeAttribute('aria-busy');
        try {
          box.replaceChildren(render(data));
        } catch (renderError) {
          console.error(renderError);
          box.replaceChildren(errorState('Something went wrong while displaying this section.', () => renderRoute(true)));
        }
      },
      (err) => {
        if (!box.isConnected || err.status === 401) return;
        box.removeAttribute('aria-busy');
        box.replaceChildren(errorState(err.message, () => renderRoute(true)));
      });
    return box;
  }

  function pageHeader(title, subtitle, actions) {
    return h('div', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'page-title', tabindex: '-1' }, title),
        subtitle && h('p', { class: 'page-sub' }, subtitle)),
      actions && h('div', { class: 'page-actions' }, actions));
  }

  function practiseButton(topic, label, extraClass = 'btn-secondary btn-sm') {
    return h('button', { class: `btn ${extraClass}`, type: 'button', onclick: () => practiseTopic(topic) },
      icon('quiz', 16), label || `Practise ${topic}`);
  }

  /* ======================================================================
     5. Shell: theme, sidebar, router
     ====================================================================== */
  const THEME_KEY = 'studypath-theme';
  const SIDEBAR_KEY = 'studypath-sidebar';

  function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ } }

  function getTheme() {
    const saved = storageGet(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(theme, persist) {
    document.documentElement.setAttribute('data-theme', theme);
    const next = theme === 'dark' ? 'light' : 'dark';
    $$('[data-theme-toggle]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(theme === 'dark'));
      btn.setAttribute('aria-label', `Switch to ${next} theme`);
      btn.title = `Switch to ${next} theme`;
    });
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0E1A27' : '#F3F7FC');
    if (persist) storageSet(THEME_KEY, theme);
  }

  const mobileQuery = window.matchMedia('(max-width: 900px)');

  function setCollapsed(collapsed, persist) {
    $('#app-shell').classList.toggle('sidebar-collapsed', collapsed);
    const toggle = $('#sidebar-toggle');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    toggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    if (persist) storageSet(SIDEBAR_KEY, collapsed ? '1' : '0');
  }

  function openDrawer(open) {
    const shell = $('#app-shell');
    const wasOpen = shell.classList.contains('nav-open');
    shell.classList.toggle('nav-open', open);
    $('#menu-toggle').setAttribute('aria-expanded', String(open));
    if (open && mobileQuery.matches) {
      const first = $('.nav-link[aria-current="page"]') || $('.nav-link');
      if (first) first.focus();
    } else if (!open && wasOpen && mobileQuery.matches) {
      $('#menu-toggle').focus();
    }
  }

  const ROUTES = {
    dashboard: { title: 'Overview', render: viewDashboard },
    quiz: { title: 'Practice quiz', render: viewQuiz },
    progress: { title: 'Progress', render: viewProgress },
    weaknesses: { title: 'Knowledge gaps', render: viewWeaknesses },
    mistakes: { title: 'Mistake review', render: viewMistakes },
    recommend: { title: 'Recommendations', render: viewRecommend },
  };

  function currentRoute() {
    const name = location.hash.replace(/^#\/?/, '').split(/[?/]/)[0];
    return Object.prototype.hasOwnProperty.call(ROUTES, name) ? name : 'dashboard';
  }

  function navigate(route) {
    if (location.hash === `#/${route}`) renderRoute();
    else location.hash = `#/${route}`;
  }

  function mountView(node) {
    const view = $('#view');
    view.replaceChildren(node);
    window.scrollTo(0, 0);
    const target = $('[data-autofocus]', view) || $('.page-title', view);
    if (target) target.focus({ preventScroll: true });
  }

  function renderRoute(fresh = false) {
    if (!state.user) return;
    if (fresh) state.cache = {};
    const name = currentRoute();
    const route = ROUTES[name];
    state.route = name;
    $$('.nav-link[data-route]').forEach((link) => {
      if (link.dataset.route === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    $('#crumb-current').textContent = route.title;
    document.title = `${route.title} · AI StudyPath`;
    if ($('#app-shell').classList.contains('nav-open')) {
      $('#app-shell').classList.remove('nav-open');
      $('#menu-toggle').setAttribute('aria-expanded', 'false');
    }
    mountView(route.render());
  }

  /* ======================================================================
     6. Authentication
     ====================================================================== */
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function showScreen(name) {
    $('#boot').hidden = true;
    $('#auth-screen').hidden = name !== 'auth';
    $('#app-shell').hidden = name !== 'app';
    if (name === 'auth') document.title = 'Sign in · AI StudyPath';
  }

  function setFieldError(input, message) {
    const errorEl = $(`#${input.id}-error`);
    if (message) {
      input.setAttribute('aria-invalid', 'true');
      const hint = input.getAttribute('data-hint-id');
      input.setAttribute('aria-describedby', [hint, errorEl.id].filter(Boolean).join(' '));
      errorEl.textContent = message;
      errorEl.hidden = false;
    } else {
      input.removeAttribute('aria-invalid');
      if (input.id === 'reg-password') input.setAttribute('aria-describedby', 'reg-password-hint');
      else input.removeAttribute('aria-describedby');
      errorEl.textContent = '';
      errorEl.hidden = true;
    }
  }

  function setFormError(id, message) {
    const el = $(`#${id}`);
    el.textContent = message || '';
    el.hidden = !message;
  }

  function clearAuthErrors() {
    $$('#auth-screen input').forEach((input) => setFieldError(input, ''));
    setFormError('login-form-error', '');
    setFormError('register-form-error', '');
  }

  function setAuthMode(mode, { focus = true } = {}) {
    clearAuthErrors();
    $('#login-panel').hidden = mode !== 'login';
    $('#register-panel').hidden = mode !== 'register';
    document.title = `${mode === 'login' ? 'Sign in' : 'Create account'} · AI StudyPath`;
    if (focus) {
      const first = mode === 'login' ? $('#login-identifier') : $('#reg-username');
      if (first) first.focus();
    }
  }

  function startSession(student) {
    state.user = student;
    state.cache = {};
    state.quiz = freshQuiz();
    const name = String(student.username || 'Student');
    $('#user-name').textContent = name;
    $('#user-avatar').textContent = (Array.from(name)[0] || 'S').toUpperCase();
    showScreen('app');
    setCollapsed(storageGet(SIDEBAR_KEY) === '1', false);
    if (!location.hash || location.hash === '#') {
      history.replaceState(null, '', `${location.pathname}${location.search}#/dashboard`);
    }
    renderRoute();
  }

  /* Sign in, then confirm the session cookie really works via /me. */
  async function signIn(identifier, password) {
    const login = await api('/login', { method: 'POST', body: { username_or_email: identifier, password } });
    if (!login || !login.student) throw new ApiError('Sign-in could not be confirmed. Please try again.', 200, login);
    try {
      const me = await api('/me');
      if (!me.student) throw new Error('missing student');
      return me.student;
    } catch (confirmError) {
      throw new ApiError('You were signed in, but your browser did not keep the session. Check that cookies are enabled for this site.', 401, null);
    }
  }

  async function onLoginSubmit(event) {
    event.preventDefault();
    const idInput = $('#login-identifier');
    const pwInput = $('#login-password');
    const button = $('#login-submit');
    const identifier = idInput.value.trim();
    const password = pwInput.value;

    setFormError('login-form-error', '');
    setFieldError(idInput, identifier ? '' : 'Enter your username or email.');
    setFieldError(pwInput, password ? '' : 'Enter your password.');
    if (!identifier || !password) { (identifier ? pwInput : idInput).focus(); return; }

    setBusy(button, true, 'Signing in…');
    try {
      const student = await signIn(identifier, password);
      pwInput.value = '';
      startSession(student);
    } catch (err) {
      setFormError('login-form-error', err.message);
      if (err.status === 401) { pwInput.select(); }
    } finally {
      setBusy(button, false);
    }
  }

  async function onRegisterSubmit(event) {
    event.preventDefault();
    const usernameInput = $('#reg-username');
    const emailInput = $('#reg-email');
    const pwInput = $('#reg-password');
    const confirmInput = $('#reg-confirm');
    const button = $('#register-submit');

    const username = usernameInput.value.trim();
    const email = emailInput.value.trim();
    const password = pwInput.value;
    const confirm = confirmInput.value;

    setFormError('register-form-error', '');
    const problems = [
      [usernameInput, !username ? 'Choose a username.' : username.length > 50 ? 'Username must be 50 characters or fewer.' : ''],
      [emailInput, !email ? 'Enter your email address.' : !EMAIL_RE.test(email) ? 'Enter a valid email address.' : ''],
      [pwInput, !password ? 'Create a password.' : password.length < 8 ? 'Password must contain at least 8 characters.' : ''],
      [confirmInput, !confirm ? 'Re-enter your password.' : confirm !== password ? 'Passwords do not match.' : ''],
    ];
    problems.forEach(([input, message]) => setFieldError(input, message));
    const firstProblem = problems.find(([, message]) => message);
    if (firstProblem) { firstProblem[0].focus(); return; }

    setBusy(button, true, 'Creating account…');
    try {
      await api('/register', { method: 'POST', body: { username, email, password } });
    } catch (err) {
      setBusy(button, false);
      if (err.status === 409) {
        setFormError('register-form-error', `${err.message}. That username or email may already be in use — try signing in, or choose different details.`);
      } else {
        setFormError('register-form-error', err.message);
      }
      return;
    }

    // Registration only creates the account; sign in so the backend confirms a real session.
    try {
      setBusy(button, true, 'Signing you in…');
      const student = await signIn(username, password);
      [pwInput, confirmInput].forEach((input) => { input.value = ''; });
      toast('Account created. Welcome to StudyPath!', 'success');
      startSession(student);
    } catch (err) {
      setAuthMode('login', { focus: false });
      $('#login-identifier').value = username;
      $('#login-password').focus();
      toast('Account created. Please sign in to continue.', 'success');
    } finally {
      setBusy(button, false);
    }
  }

  async function onLogout() {
    const button = $('#logout-btn');
    setBusy(button, true, 'Signing out…');
    try {
      await api('/logout', { method: 'POST' });
    } catch (err) {
      setBusy(button, false);
      if (state.user) toast(`Could not sign out: ${err.message}`, 'error');
      return;
    }
    setBusy(button, false);
    resetAppState();
    showScreen('auth');
    setAuthMode('login');
    toast('You have been signed out.', 'success');
  }

  /* ======================================================================
     7a. Dashboard
     ====================================================================== */
  function statCard(label, value, iconName, note) {
    return h('article', { class: 'card kpi' },
      h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-icon' }, icon(iconName, 18)), label),
      h('div', { class: 'kpi-value' }, value),
      note && h('p', { class: 'kpi-note' }, note));
  }

  function renderKpis(stats, { onboarding = true } = {}) {
    const total = Number(stats.total_questions) || 0;
    const noData = total === 0;
    const accuracyCard = h('article', { class: 'card kpi kpi-accuracy' },
      h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-icon' }, icon('target', 18)), 'Overall accuracy'),
      h('div', { class: 'kpi-acc-row' },
        ring(stats.accuracy, { size: 96, stroke: 10, empty: noData }),
        h('p', { class: 'kpi-note' }, noData ? 'No answers recorded yet' : `${num(stats.correct_answers)} of ${num(total)} answered correctly`)));

    const grid = h('div', { class: 'kpi-grid' },
      statCard('Quiz attempts', num(stats.total_attempts), 'quiz'),
      statCard('Questions answered', num(stats.total_questions), 'book'),
      statCard('Correct answers', num(stats.correct_answers), 'check'),
      accuracyCard);

    const wrapper = h('div', { class: 'view' }, grid);
    if (onboarding && !stats.total_attempts) {
      wrapper.append(h('section', { class: 'card card-onboarding' },
        h('span', { class: 'chip' }, icon('info', 14), 'Getting started'),
        h('h2', null, 'Take your first quiz'),
        h('p', null, 'Choose any topic and StudyPath will generate questions, grade your answers, and start mapping your strengths and knowledge gaps. Your numbers appear here as soon as you finish a quiz.'),
        h('a', { class: 'btn btn-primary', href: '#/quiz' }, icon('quiz', 16), 'Start your first quiz')));
    }
    return wrapper;
  }

  function renderRecommendCard(rec, { detailed = false } = {}) {
    if (rec && rec.recommended_topic) {
      return h('article', { class: 'card card-feature' },
        h('span', { class: 'chip chip-solid' }, icon('bulb', 14), 'Personalised recommendation'),
        h('h2', null, `Study next: ${rec.recommended_topic}`),
        h('p', { class: 'lead' }, rec.recommendation),
        h('div', { class: 'meta-row' },
          !isNil(rec.recommended_accuracy) && h('span', null, 'Recorded accuracy', h('strong', null, pct(rec.recommended_accuracy))),
          !isNil(rec.priority_score) && h('span', null, 'Priority score', h('strong', null, String(rec.priority_score)))),
        h('div', { class: 'btn-row' },
          practiseButton(rec.recommended_topic, 'Practise this topic', 'btn-primary'),
          !detailed && h('a', { class: 'card-link', href: '#/recommend' }, 'See breakdown', icon('arrow-right', 14))));
    }
    return h('article', { class: 'card card-onboarding' },
      h('span', { class: 'chip' }, icon('info', 14), 'Getting started'),
      h('h2', null, 'Your first recommendation is waiting'),
      h('p', null, (rec && rec.recommendation) || 'Take your first quiz to get personalised study recommendations.'),
      h('a', { class: 'btn btn-primary', href: '#/quiz' }, icon('quiz', 16), 'Take a quiz'));
  }

  function renderWeaknessSummary(data) {
    const results = Array.isArray(data.results) ? data.results : [];
    const card = h('article', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', { class: 'card-title' }, 'Weakness summary'), h('p', { class: 'card-sub' }, 'Concepts that need attention first')),
        h('a', { class: 'card-link', href: '#/weaknesses' }, 'View all', icon('arrow-right', 14))));

    if (!results.length) {
      card.append(emptyState({
        iconName: 'target', title: 'No concept data yet',
        text: 'Once you finish a quiz, each question’s concept is tracked so we can spot where you struggle.',
      }));
      return card;
    }

    const attention = results.filter((r) => r.status === 'Weak' || r.status === 'Needs practice').slice(0, 3);
    card.append(
      h('div', { class: 'meta-row', style: 'margin-bottom:16px' },
        h('span', null, 'Concepts analysed', h('strong', null, num(data.concepts_analyzed))),
        h('span', null, 'Weak', h('strong', null, num(data.weak_concepts)))));

    if (!attention.length) {
      const allThin = results.every((r) => r.status === 'Insufficient data');
      card.append(emptyState({
        inline: true,
        title: allThin ? 'Not enough data to rate concepts yet' : 'No weak or developing concepts detected',
        text: allThin ? 'Concepts need at least three recorded responses before they are rated.' : 'Keep practising to maintain this progress.',
      }));
      return card;
    }

    card.append(h('div', { class: 'row-list' }, attention.map((r) => h('div', { class: 'row-item' },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, r.concept),
        h('div', { class: 'row-meta' }, r.topic)),
      h('div', { class: 'row-value' }, badge(STATUS_KIND[r.status] || 'none', r.status), ' ', pct(r.accuracy)),
      h('div', { class: 'row-bar' }, bar(r.accuracy, STATUS_KIND[r.status]))))));
    return card;
  }

  function conceptRow(c) {
    const kind = c.enough_data ? band(c.accuracy) : 'none';
    return h('div', { class: 'row-item' },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, c.concept),
        h('div', { class: 'row-meta' }, `${c.topic} · ${plural(Number(c.questions_attempted) || 0, 'answer')}`)),
      h('div', { class: 'row-value' }, pct(c.accuracy)),
      h('div', { class: 'row-bar' }, bar(c.accuracy, kind)));
  }

  function renderConceptOverview(stats) {
    const concepts = Array.isArray(stats.concepts) ? stats.concepts : [];
    const card = h('article', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', { class: 'card-title' }, 'Concept performance'), h('p', { class: 'card-sub' }, concepts.length > 6 ? 'Six lowest-accuracy concepts' : 'Accuracy by concept')),
        h('a', { class: 'card-link', href: '#/progress' }, 'Full report', icon('arrow-right', 14))));
    if (!concepts.length) {
      card.append(emptyState({ iconName: 'chart', title: 'No concepts tracked yet', text: 'Complete a quiz and your accuracy for each concept will appear here.' }));
      return card;
    }
    card.append(h('div', { class: 'row-list' }, concepts.slice(0, 6).map(conceptRow)));
    return card;
  }

  function attemptPct(a) {
    if (!isNil(a.score_percent)) return Number(a.score_percent);
    const total = Number(a.total_questions);
    return total > 0 ? (Number(a.correct_answers) / total) * 100 : null;
  }

  function renderRecentAttempts(list) {
    const attempts = Array.isArray(list) ? list : [];
    const card = h('article', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', { class: 'card-title' }, 'Recent attempts'), h('p', { class: 'card-sub' }, 'Your latest quizzes')),
        h('a', { class: 'card-link', href: '#/progress' }, 'History', icon('arrow-right', 14))));
    if (!attempts.length) {
      card.append(emptyState({
        iconName: 'quiz', title: 'No quizzes yet', text: 'Your finished quizzes will be listed here.',
        action: h('a', { class: 'btn btn-secondary', href: '#/quiz' }, 'Start a quiz'),
      }));
      return card;
    }
    card.append(h('div', { class: 'row-list' }, attempts.slice(0, 5).map((a) => {
      const score = attemptPct(a);
      return h('div', { class: 'row-item' },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' }, a.topic),
          h('div', { class: 'row-meta' }, `${fmtDate(a.attempted_at)} · ${num(a.correct_answers)}/${num(a.total_questions)} correct`)),
        h('div', { class: 'row-value' }, badge(band(score), pct(score))));
    })));
    return card;
  }

  function viewDashboard() {
    const name = state.user.username;
    return h('div', { class: 'view' },
      h('section', { class: 'hero' },
        h('div', { class: 'hero-copy' },
          h('p', { class: 'eyebrow' }, 'Overview'),
          h('h1', { class: 'page-title', tabindex: '-1' }, `Welcome, ${name}`),
          h('p', { class: 'page-sub' }, 'Here is where your learning stands, based on the quizzes you have completed.')),
        h('div', { class: 'hero-actions' },
          h('a', { class: 'btn btn-primary btn-lg', href: '#/quiz' }, icon('quiz', 18), 'Start a new quiz'))),
      asyncBlock('stats', renderKpis, { skeleton: 'kpi' }),
      h('div', { class: 'grid-2' },
        asyncBlock('recommend', (rec) => renderRecommendCard(rec)),
        asyncBlock('weaknesses', renderWeaknessSummary)),
      h('div', { class: 'grid-2' },
        asyncBlock('stats', renderConceptOverview),
        asyncBlock('attempts', renderRecentAttempts)));
  }

  /* ======================================================================
     7b. Quiz
     ====================================================================== */
  function practiseTopic(topic) {
    const q = state.quiz;
    if (q.phase === 'loading') {
      toast('A quiz is still being generated. Please wait a moment.', 'info');
      navigate('quiz');
      return;
    }
    if (q.phase === 'taking' && Object.keys(q.answers).length &&
        !window.confirm('You have a quiz in progress. Discard it and start a new one?')) {
      return;
    }
    state.quiz = freshQuiz({ topic, difficulty: q.form.difficulty, num: q.form.num });
    navigate('quiz');
  }

  function refreshQuizView() {
    if (state.user && currentRoute() === 'quiz') mountView(viewQuiz());
  }

  function viewQuiz() {
    switch (state.quiz.phase) {
      case 'loading': return quizLoadingView();
      case 'taking': return quizTakingView();
      case 'results': return quizResultsView();
      default: return quizSetupView();
    }
  }

  function quizSetupView() {
    const q = state.quiz;
    const topicInput = h('input', {
      id: 'quiz-topic', name: 'topic', type: 'text', maxlength: '120', autocomplete: 'off', required: true,
      placeholder: 'e.g. Photosynthesis, Binary search trees, The French Revolution', value: q.form.topic,
      'data-autofocus': q.form.topic ? 'true' : null,
    });
    const topicError = h('p', { class: 'field-error', id: 'quiz-topic-error', hidden: true });
    const errorBox = h('div', { class: 'form-alert', role: 'alert', hidden: !q.setupError }, q.setupError);
    const recent = h('div', { class: 'field', hidden: true },
      h('span', { class: 'field-label' }, 'Recent topics'),
      h('div', { class: 'chip-row', id: 'recent-topics' }));

    const difficulty = h('fieldset', { class: 'segmented' },
      h('legend', null, 'Difficulty'),
      h('div', { class: 'seg-wrap' },
        ['easy', 'medium', 'hard'].map((d) => h('label', { class: 'seg-option' },
          h('input', { type: 'radio', name: 'difficulty', value: d, checked: q.form.difficulty === d }),
          h('span', null, cap(d))))));

    const countSelect = h('select', { id: 'quiz-count', name: 'num_questions' },
      Array.from({ length: 10 }, (_, i) => i + 1).map((n) =>
        h('option', { value: String(n), selected: Number(q.form.num) === n }, plural(n, 'question'))));

    const submit = h('button', { class: 'btn btn-primary btn-lg', type: 'submit', id: 'quiz-generate' },
      icon('quiz', 18), h('span', { class: 'btn-label' }, 'Generate quiz'));

    const form = h('form', { class: 'quiz-form-fields', id: 'quiz-setup-form', novalidate: true, onsubmit: (event) => {
      event.preventDefault();
      const topic = topicInput.value.trim();
      if (!topic) {
        topicInput.setAttribute('aria-invalid', 'true');
        topicInput.setAttribute('aria-describedby', 'quiz-topic-error');
        topicError.textContent = 'Enter a topic to practise.';
        topicError.hidden = false;
        topicInput.focus();
        return;
      }
      const picked = form.querySelector('input[name="difficulty"]:checked');
      startQuiz({ topic, difficulty: picked ? picked.value : 'medium', num: Number(countSelect.value) });
    } },
      errorBox,
      h('div', { class: 'field' },
        h('label', { for: 'quiz-topic' }, 'Topic'), topicInput, topicError),
      recent,
      h('div', { class: 'form-row' },
        difficulty,
        h('div', { class: 'field' }, h('label', { for: 'quiz-count' }, 'Number of questions'), countSelect)),
      h('div', null, submit));

    topicInput.addEventListener('input', () => {
      topicInput.removeAttribute('aria-invalid');
      topicInput.removeAttribute('aria-describedby');
      topicError.hidden = true;
    });

    // Quick-pick chips from the student's real quiz history.
    load('attempts').then((list) => {
      if (!recent.isConnected || !Array.isArray(list)) return;
      const topics = [...new Set(list.map((a) => a.topic).filter(Boolean))].slice(0, 6);
      if (!topics.length) return;
      add($('#recent-topics', recent), topics.map((t) => h('button', {
        class: 'chip', type: 'button',
        onclick: () => { topicInput.value = t; topicInput.focus(); },
      }, t)));
      recent.hidden = false;
    }).catch(() => { /* chips are optional */ });

    return h('div', { class: 'view' },
      pageHeader('Practice quiz', 'Generate an AI quiz on any topic. Your answers feed your progress, knowledge gaps and recommendations.'),
      h('section', { class: 'card quiz-card' }, form));
  }

  function quizLoadingView() {
    const q = state.quiz;
    return h('div', { class: 'view' },
      pageHeader('Generating your quiz'),
      h('section', { class: 'card loading-card', role: 'status', 'aria-live': 'polite' },
        h('span', { class: 'spinner spinner-lg', 'aria-hidden': 'true' }),
        h('h2', null, `Writing ${plural(Number(q.form.num), 'question')} on “${q.form.topic}”`),
        h('p', null, 'The AI is preparing questions and checking them. This usually takes 10–30 seconds.'),
        h('div', { class: 'skeleton-stack', 'aria-hidden': 'true' },
          h('span', { class: 'skeleton skeleton-line' }),
          h('span', { class: 'skeleton skeleton-line medium' }),
          h('span', { class: 'skeleton skeleton-line' }))));
  }

  async function startQuiz(form) {
    const q = state.quiz;
    if (q.phase === 'loading') return;
    q.form = Object.assign({}, q.form, form);
    q.setupError = '';
    q.phase = 'loading';
    refreshQuizView();
    try {
      const data = await api('/generate_quiz', {
        method: 'POST',
        body: { topic: q.form.topic, difficulty: q.form.difficulty, num_questions: Number(q.form.num) },
      });
      const valid = Number.isInteger(data.quiz_id) && Array.isArray(data.questions) && data.questions.length &&
        data.questions.every((item) => item && typeof item.question === 'string' && Array.isArray(item.options));
      if (!valid) throw new ApiError('The server returned a quiz in an unexpected format. Please try again.', 502, data);
      q.data = data;
      q.answers = {};
      q.result = null;
      q.startedAt = Date.now();
      q.phase = 'taking';
    } catch (err) {
      if (err.status === 401) return;
      q.phase = 'setup';
      q.setupError = err.message;
      toast(err.message, 'error');
    }
    refreshQuizView();
  }

  function updateQuizProgress() {
    const q = state.quiz;
    const total = q.data.questions.length;
    const answered = Object.keys(q.answers).length;
    const textEl = $('#quiz-progress-text');
    const fill = $('#quiz-progress-fill');
    const barEl = $('#quiz-progress-bar');
    if (!textEl) return;
    textEl.textContent = `${answered} of ${total} answered`;
    fill.style.width = `${(answered / total) * 100}%`;
    barEl.setAttribute('aria-valuenow', String(answered));
    $('#quiz-progress-left').textContent = answered === total ? 'Ready to submit' : `${plural(total - answered, 'question')} left`;
  }

  function onAnswer(questionIndex, optionIndex) {
    const q = state.quiz;
    q.answers[questionIndex] = optionIndex;
    const card = $(`#q-${questionIndex}`);
    if (card) {
      card.classList.remove('unanswered');
      const note = $('.q-unanswered-note', card);
      if (note) note.remove();
    }
    updateQuizProgress();
    const remaining = q.data.questions.filter((_, i) => q.answers[i] === undefined).length;
    if (!remaining) { const v = $('#quiz-validation'); if (v) v.hidden = true; }
  }

  function quizTakingView() {
    const q = state.quiz;
    const questions = q.data.questions;
    const total = questions.length;
    const answered = Object.keys(q.answers).length;

    const cards = questions.map((item, i) => h('div', { class: 'q-card', id: `q-${i}`, role: 'radiogroup', 'aria-labelledby': `q-label-${i}` },
      h('div', { class: 'q-head' },
        h('span', { class: 'q-num' }, `Question ${i + 1} of ${total}`),
        item.concept && h('span', { class: 'chip' }, item.concept)),
      h('p', { class: 'q-text', id: `q-label-${i}` }, item.question),
      h('div', { class: 'options' }, item.options.map((option, j) => h('label', { class: 'option' },
        h('input', { type: 'radio', name: `q${i}`, value: String(j), checked: q.answers[i] === j, onchange: () => onAnswer(i, j) }),
        h('span', { class: 'option-key', 'aria-hidden': 'true' }, 'ABCDEFGH'[j] || String(j + 1)),
        h('span', { class: 'option-text' }, option))))));

    const submitBtn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit', id: 'quiz-submit' },
      icon('check', 18), h('span', { class: 'btn-label' }, 'Submit quiz'));

    const form = h('form', { class: 'view', id: 'quiz-form', novalidate: true, onsubmit: (event) => { event.preventDefault(); submitQuiz(); } },
      h('div', { class: 'quiz-bar' },
        h('div', { class: 'quiz-bar-top' },
          h('span', { id: 'quiz-progress-text', 'aria-live': 'polite' }, `${answered} of ${total} answered`),
          h('span', { id: 'quiz-progress-left' }, answered === total ? 'Ready to submit' : `${plural(total - answered, 'question')} left`)),
        h('div', { class: 'bar', id: 'quiz-progress-bar', role: 'progressbar', 'aria-label': 'Quiz progress', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(answered) },
          h('div', { class: 'bar-fill', id: 'quiz-progress-fill', style: `width:${(answered / total) * 100}%` }))),
      h('div', { class: 'quiz-list' }, cards),
      h('div', { class: 'quiz-actions' },
        h('div', { class: 'form-alert', id: 'quiz-validation', role: 'alert', hidden: true }),
        h('div', { class: 'form-alert', id: 'quiz-submit-error', role: 'alert', hidden: true }),
        h('div', { class: 'quiz-actions-row' },
          h('button', { class: 'btn btn-ghost', type: 'button', id: 'quiz-discard', onclick: discardQuiz }, 'Discard quiz'),
          submitBtn),
        h('p', { class: 'quiz-note' }, 'Every question must be answered before you can submit. Your answers are kept if something goes wrong.')));

    return h('div', { class: 'view' },
      pageHeader(q.data.topic || q.form.topic, null),
      h('div', { class: 'quiz-meta' },
        h('span', { class: 'chip' }, `Difficulty: ${cap(q.data.difficulty || q.form.difficulty)}`),
        h('span', { class: 'chip' }, plural(total, 'question'))),
      form);
  }

  function discardQuiz() {
    const q = state.quiz;
    if (q.submitting) return;
    if (Object.keys(q.answers).length && !window.confirm('Discard this quiz and your answers?')) return;
    state.quiz = freshQuiz(q.form);
    refreshQuizView();
  }

  function showSubmitError(err) {
    const box = $('#quiz-submit-error');
    if (!box) return;
    box.replaceChildren(err.message);
    if (err.status === 409 || err.status === 404) {
      box.append(h('div', { class: 'alert-action' },
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => { state.quiz = freshQuiz(state.quiz.form); refreshQuizView(); } }, 'Start a new quiz')));
    }
    box.hidden = false;
    box.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  }

  async function submitQuiz() {
    const q = state.quiz;
    if (q.submitting || q.phase !== 'taking') return;
    const questions = q.data.questions;
    const missing = questions.map((_, i) => i).filter((i) => q.answers[i] === undefined);
    const validation = $('#quiz-validation');
    const submitError = $('#quiz-submit-error');
    if (submitError) submitError.hidden = true;

    $$('.q-card').forEach((card, i) => {
      const isMissing = missing.includes(i);
      card.classList.toggle('unanswered', isMissing);
      const existing = $('.q-unanswered-note', card);
      if (isMissing && !existing) card.append(h('p', { class: 'q-unanswered-note' }, 'Please choose an answer.'));
      if (!isMissing && existing) existing.remove();
    });

    if (missing.length) {
      validation.textContent = `Please answer ${missing.length === 1 ? 'question' : 'questions'} ${listJoin(missing.map((i) => i + 1))} before submitting.`;
      validation.hidden = false;
      const first = $(`#q-${missing[0]}`);
      first.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      const input = $('input', first);
      if (input) input.focus({ preventScroll: true });
      return;
    }
    validation.hidden = true;

    q.submitting = true;
    const button = $('#quiz-submit');
    setBusy(button, true, 'Submitting…');
    $$('#quiz-form input[type="radio"]').forEach((input) => { input.disabled = true; });
    $('#quiz-discard').disabled = true;

    const answers = {};
    questions.forEach((item, i) => { answers[String(i)] = item.options[q.answers[i]]; });
    const timeTaken = Math.round((Date.now() - q.startedAt) / 100) / 10;

    try {
      const result = await api('/submit_quiz', { method: 'POST', body: { quiz_id: q.data.quiz_id, answers, time_taken: timeTaken } });
      q.submitting = false;
      q.result = result;
      q.phase = 'results';
      state.cache = {}; // new attempt: stats, weaknesses, mistakes and recommendations are all stale
      toast('Quiz submitted and graded.', 'success');
      refreshQuizView();
    } catch (err) {
      q.submitting = false;
      if (err.status === 401) return;
      // Keep every selected answer so the student can simply retry.
      $$('#quiz-form input[type="radio"]').forEach((input) => { input.disabled = false; });
      const discard = $('#quiz-discard');
      if (discard) discard.disabled = false;
      setBusy($('#quiz-submit'), false);
      showSubmitError(err);
      toast(err.message, 'error');
    }
  }

  function quizResultsView() {
    const q = state.quiz;
    const r = q.result;
    const score = Number(r.score_percent);
    const headline = score >= 80 ? 'Excellent work' : score >= 50 ? 'Good progress' : 'Keep going';
    const sub = score >= 80 ? 'You have a firm grip on this material.'
      : score >= 50 ? 'You are getting there. The explanations below show what to tighten up.'
      : 'Review the explanations below — every miss is a chance to close a gap.';
    const review = Array.isArray(r.review) ? r.review : [];

    return h('div', { class: 'view' },
      pageHeader('Quiz results', r.topic),
      h('section', { class: 'card result-card' },
        ring(score, { size: 150, stroke: 14, label: 'score' }),
        h('div', { class: 'result-body' },
          h('div', null, h('h2', null, headline), h('p', { class: 'page-sub' }, sub)),
          h('div', { class: 'result-stats' },
            h('div', { class: 'result-stat' }, h('strong', null, num(r.correct_answers)), h('span', null, 'Correct')),
            h('div', { class: 'result-stat' }, h('strong', null, num(r.incorrect_answers)), h('span', null, 'Incorrect')),
            h('div', { class: 'result-stat' }, h('strong', null, num(r.total_questions)), h('span', null, 'Questions')),
            h('div', { class: 'result-stat' }, h('strong', null, fmtDuration(r.time_taken)), h('span', null, 'Time taken'))),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn btn-primary', type: 'button', onclick: () => startQuiz({}) }, icon('refresh', 16), 'Practise this topic again'),
            h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => { state.quiz = freshQuiz({ difficulty: q.form.difficulty, num: q.form.num }); refreshQuizView(); } }, 'Try a different topic'),
            h('a', { class: 'card-link', href: '#/weaknesses' }, 'See knowledge gaps', icon('arrow-right', 14))))),
      h('section', null,
        h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Answer review')),
        h('ol', { class: 'review-list' }, review.map((item, i) => h('li', { class: `card review-item ${item.is_correct ? 'is-correct' : 'is-wrong'}` },
          h('div', { class: 'review-top' },
            h('span', { class: 'q-num' }, `Question ${i + 1}`),
            item.is_correct ? badge('strong', 'Correct') : badge('weak', 'Incorrect'),
            item.concept && h('span', { class: 'chip' }, item.concept)),
          h('p', { class: 'review-q' }, item.question),
          h('div', { class: `answer-block ${item.is_correct ? 'answer-correct' : 'answer-wrong'}` },
            h('span', { class: 'label' }, 'Your answer'), item.selected_answer),
          !item.is_correct && h('div', { class: 'answer-block answer-correct' },
            h('span', { class: 'label' }, 'Correct answer'), item.correct_answer),
          item.explanation && h('div', { class: 'answer-block answer-explain' },
            h('span', { class: 'label' }, 'Explanation'), item.explanation))))));
  }

  /* ======================================================================
     7c. Progress
     ====================================================================== */
  function renderTrend(list) {
    const attempts = Array.isArray(list) ? list : [];
    const card = h('article', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', { class: 'card-title' }, 'Recent performance'), h('p', { class: 'card-sub' }, 'Score for each of your latest quizzes, oldest to newest'))));

    const points = attempts.slice().reverse().slice(-20)
      .map((a) => ({ score: attemptPct(a), topic: a.topic, date: a.attempted_at }))
      .filter((p) => p.score !== null);

    if (!points.length) {
      card.append(emptyState({ iconName: 'chart', title: 'No quiz history yet', text: 'Complete a quiz to start building your performance trend.',
        action: h('a', { class: 'btn btn-secondary', href: '#/quiz' }, 'Start a quiz') }));
      return card;
    }

    const W = 640, H = 240, P = { l: 42, r: 16, t: 14, b: 30 };
    const x = (i) => (points.length === 1 ? P.l + (W - P.l - P.r) / 2 : P.l + (i * (W - P.l - P.r)) / (points.length - 1));
    const y = (v) => P.t + (1 - v / 100) * (H - P.t - P.b);

    const svg = svgEl('svg', {
      class: 'trend', viewBox: `0 0 ${W} ${H}`, role: 'img',
      'aria-label': `Quiz scores across your last ${plural(points.length, 'attempt')}, from ${pct(points[0].score)} to ${pct(points[points.length - 1].score)}.`,
    });
    [0, 25, 50, 75, 100].forEach((tick) => {
      svg.append(
        svgEl('line', { class: tick === 70 ? 'trend-grid-strong' : 'trend-grid', x1: P.l, x2: W - P.r, y1: y(tick), y2: y(tick) }),
        svgEl('text', { class: 'trend-label', x: P.l - 8, y: y(tick) + 4, 'text-anchor': 'end' }, `${tick}%`));
    });
    add(svg, [
      svgEl('text', { class: 'trend-label', x: x(0), y: H - 8, 'text-anchor': points.length === 1 ? 'middle' : 'start' }, points.length === 1 ? 'Latest' : 'Oldest'),
      points.length > 1 && svgEl('text', { class: 'trend-label', x: x(points.length - 1), y: H - 8, 'text-anchor': 'end' }, 'Latest'),
    ]);

    if (points.length > 1) {
      const line = points.map((p, i) => `${x(i)},${y(p.score)}`).join(' ');
      svg.append(
        svgEl('polygon', { class: 'trend-area', points: `${x(0)},${y(0)} ${line} ${x(points.length - 1)},${y(0)}` }),
        svgEl('polyline', { class: 'trend-line', points: line }));
    }
    points.forEach((p, i) => svg.append(
      svgEl('circle', { class: 'trend-dot', cx: x(i), cy: y(p.score), r: 5 },
        svgEl('title', null, `${p.topic}: ${pct(p.score)} (${fmtDate(p.date)})`))));

    card.append(svg);
    if (points.length < 2) card.append(h('p', { class: 'card-sub' }, 'Complete another quiz to see a trend line.'));
    return card;
  }

  function renderTopicAccuracy(stats) {
    const concepts = Array.isArray(stats.concepts) ? stats.concepts : [];
    const card = h('article', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', { class: 'card-title' }, 'Accuracy by topic'), h('p', { class: 'card-sub' }, 'Combined from every concept in each topic, lowest first'))));
    if (!concepts.length) {
      card.append(emptyState({ iconName: 'chart', title: 'No topics tracked yet', text: 'Topic accuracy appears after your first graded quiz.' }));
      return card;
    }
    const topics = new Map();
    concepts.forEach((c) => {
      const t = topics.get(c.topic) || { topic: c.topic, answered: 0, correct: 0, concepts: 0 };
      t.answered += Number(c.questions_attempted) || 0;
      t.correct += Number(c.correct_answers) || 0;
      t.concepts += 1;
      topics.set(c.topic, t);
    });
    const rows = [...topics.values()].map((t) => Object.assign(t, { accuracy: t.answered ? (t.correct / t.answered) * 100 : null }))
      .sort((a, b) => (a.accuracy ?? 101) - (b.accuracy ?? 101));
    card.append(h('div', { class: 'row-list' }, rows.map((t) => h('div', { class: 'row-item' },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, t.topic),
        h('div', { class: 'row-meta' }, `${plural(t.answered, 'answer')} · ${plural(t.concepts, 'concept')}`)),
      h('div', { class: 'row-value' }, badge(band(t.accuracy), pct(t.accuracy))),
      h('div', { class: 'row-bar' }, bar(t.accuracy, band(t.accuracy)))))));
    return card;
  }

  function renderConceptTable(stats) {
    const concepts = Array.isArray(stats.concepts) ? stats.concepts : [];
    const card = h('article', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', { class: 'card-title' }, 'Concept breakdown'),
          h('p', { class: 'card-sub' }, 'Recent accuracy covers your last five answers on each concept. Concepts are rated once they have five or more answers.'))));
    if (!concepts.length) {
      card.append(emptyState({ iconName: 'chart', title: 'No concept data yet', text: 'Each question is tagged with a concept, so this table fills in as you practise.' }));
      return card;
    }
    const head = ['Concept', 'Answers', 'Accuracy', 'Recent', 'Evidence', 'Level'];
    card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
      h('caption', { class: 'sr-only' }, 'Accuracy by concept'),
      h('thead', null, h('tr', null, head.map((label, i) => h('th', { scope: 'col', class: i === 1 || i === 3 ? 'num' : null }, label)))),
      h('tbody', null, concepts.map((c) => {
        const answered = Number(c.questions_attempted) || 0;
        const rated = Boolean(c.enough_data);
        const kind = rated ? band(c.accuracy) : 'none';
        return h('tr', null,
          h('th', { scope: 'row' }, h('div', { class: 'cell-title' }, c.concept), h('div', { class: 'cell-sub' }, c.topic)),
          h('td', { class: 'num' }, `${num(c.correct_answers)}/${num(answered)}`),
          h('td', null, h('div', { class: 'cell-acc' }, bar(c.accuracy, kind), h('span', null, pct(c.accuracy)))),
          h('td', { class: 'num' }, pct(c.recent_accuracy)),
          h('td', null, rated ? 'Sufficient' : `Limited (${answered} of 5)`),
          h('td', null, badge(kind, rated ? BAND_LABEL[kind] : 'Not rated yet')));
      })))));
    return card;
  }

  function viewProgress() {
    return h('div', { class: 'view' },
      pageHeader('Progress', 'Your performance across every quiz, based only on answers you have submitted.'),
      asyncBlock('stats', (stats) => renderKpis(stats, { onboarding: false }), { skeleton: 'kpi' }),
      asyncBlock('attempts', renderTrend),
      h('div', { class: 'grid-2' },
        asyncBlock('stats', renderTopicAccuracy),
        asyncBlock('attempts', renderAttemptHistory)),
      asyncBlock('stats', renderConceptTable));
  }

  function renderAttemptHistory(list) {
    const attempts = Array.isArray(list) ? list : [];
    const card = h('article', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', { class: 'card-title' }, 'Attempt history'), h('p', { class: 'card-sub' }, attempts.length > 8 ? 'Your eight most recent quizzes' : 'Every quiz you have taken'))));
    if (!attempts.length) {
      card.append(emptyState({ iconName: 'quiz', title: 'No attempts yet', text: 'Finished quizzes will be listed here with their scores.' }));
      return card;
    }
    card.append(h('div', { class: 'row-list' }, attempts.slice(0, 8).map((a) => {
      const score = attemptPct(a);
      const extras = [fmtDate(a.attempted_at), `${num(a.correct_answers)}/${num(a.total_questions)} correct`];
      if (!isNil(a.time_taken) && Number(a.time_taken) > 0) extras.push(fmtDuration(a.time_taken));
      return h('div', { class: 'row-item' },
        h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, a.topic), h('div', { class: 'row-meta' }, extras.join(' · '))),
        h('div', { class: 'row-value' }, badge(band(score), pct(score))));
    })));
    return card;
  }

  /* ======================================================================
     7d. Knowledge gaps
     ====================================================================== */
  const STATUS_ORDER = ['Weak', 'Needs practice', 'Insufficient data', 'Strong so far'];
  const STATUS_NOTE = {
    'Weak': 'Accuracy is below 40% across enough responses to rate this concept. Prioritise it.',
    'Needs practice': 'Accuracy is between 40% and 70%. A focused practice set should help.',
    'Strong so far': 'Accuracy is 70% or higher so far. Revisit it occasionally to keep it fresh.',
    'Insufficient data': 'Fewer than three responses are recorded, so no rating is given yet. Answer more questions on this concept.',
  };

  function conceptCard(item) {
    const kind = STATUS_KIND[item.status] || 'none';
    return h('article', { class: `card concept-card status-${kind}` },
      h('div', { class: 'concept-head' }, badge(kind, item.status || 'Unrated')),
      h('div', null, h('h3', null, item.concept), h('p', { class: 'concept-topic' }, item.topic)),
      h('div', { class: 'concept-acc' }, bar(item.accuracy, kind), h('strong', null, pct(item.accuracy))),
      h('div', { class: 'concept-facts' },
        h('span', null, `${num(item.correct_answers)} of ${num(item.attempts)} correct · ${plural(Number(item.attempts) || 0, 'response')} recorded`),
        !isNil(item.weakness_score) && h('span', null, `Weakness score: ${Number(item.weakness_score).toFixed(2)} (0 to 1)`)),
      STATUS_NOTE[item.status] && h('p', { class: 'concept-note' }, STATUS_NOTE[item.status]),
      practiseButton(item.topic, `Practise ${item.topic}`));
  }

  function renderWeaknessPage(data) {
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) {
      return h('section', { class: 'card' }, emptyState({
        iconName: 'target', title: 'No knowledge gaps to show yet',
        text: 'StudyPath tracks the concept behind every question you answer. Finish a quiz and your strengths and gaps will appear here.',
        action: h('a', { class: 'btn btn-primary', href: '#/quiz' }, 'Take your first quiz'),
      }));
    }

    const counts = {};
    results.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    let filter = 'All';

    const list = h('div', { class: 'view' });
    const filterBar = h('div', { class: 'filter-bar', role: 'group', 'aria-label': 'Filter concepts by status' });
    const filters = ['All', ...STATUS_ORDER.filter((s) => counts[s])];

    const paint = () => {
      list.replaceChildren(...STATUS_ORDER
        .filter((status) => counts[status] && (filter === 'All' || filter === status))
        .map((status) => h('section', { class: 'group', 'aria-labelledby': `grp-${STATUS_ORDER.indexOf(status)}` },
          h('div', { class: 'group-head' },
            h('h2', { id: `grp-${STATUS_ORDER.indexOf(status)}` }, status),
            h('span', { class: 'group-count' }, plural(counts[status], 'concept'))),
          h('div', { class: 'card-grid' }, results.filter((r) => r.status === status).map(conceptCard)))));
      $$('.filter-btn', filterBar).forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.filter === filter)));
    };

    filters.forEach((name) => filterBar.append(h('button', {
      class: 'filter-btn', type: 'button', 'data-filter': name, 'aria-pressed': 'false',
      onclick: () => { filter = name; paint(); },
    }, name === 'All' ? `All (${results.length})` : `${name} (${counts[name]})`)));
    paint();

    return h('div', { class: 'view' },
      h('div', { class: 'summary-grid' },
        h('div', { class: 'card stat-tile' }, h('div', { class: 'kpi-top' }, 'Concepts analysed'), h('div', { class: 'kpi-value' }, num(data.concepts_analyzed))),
        h('div', { class: 'card stat-tile' }, h('div', { class: 'kpi-top' }, 'Weak concepts'), h('div', { class: 'kpi-value' }, num(data.weak_concepts)), h('p', { class: 'kpi-note' }, 'Rated weak by the backend')),
        h('div', { class: 'card stat-tile' }, h('div', { class: 'kpi-top' }, 'Need practice'), h('div', { class: 'kpi-value' }, num(counts['Needs practice'] || 0))),
        h('div', { class: 'card stat-tile' }, h('div', { class: 'kpi-top' }, 'Not enough data'), h('div', { class: 'kpi-value' }, num(counts['Insufficient data'] || 0)), h('p', { class: 'kpi-note' }, 'Fewer than 3 responses'))),
      filterBar, list);
  }

  function viewWeaknesses() {
    return h('div', { class: 'view' },
      pageHeader('Knowledge gaps', 'Concepts ranked by how much attention they need, from your submitted answers.'),
      asyncBlock('weaknesses', renderWeaknessPage));
  }

  /* ======================================================================
     7e. Mistake review
     ====================================================================== */
  function renderMistakes(data) {
    const mistakes = Array.isArray(data.recurring_mistakes) ? data.recurring_mistakes : [];
    if (!mistakes.length) {
      return h('section', { class: 'card' }, emptyState({
        iconName: 'mistake', title: 'No mistakes to review',
        text: 'Questions you answer incorrectly will be collected here with the correct answer and explanation. Take a quiz to get started.',
        action: h('a', { class: 'btn btn-primary', href: '#/quiz' }, 'Take a quiz'),
      }));
    }
    return h('div', { class: 'view' },
      h('p', { class: 'page-sub' }, `${plural(mistakes.length, 'question')} you have answered incorrectly, most-missed first.`),
      h('div', { class: 'card-grid' }, mistakes.map((m) => h('article', { class: 'card mistake-card' },
        h('div', { class: 'mistake-top' },
          h('span', { class: 'chip' }, m.topic),
          badge('weak', `Missed ${plural(Number(m.wrong_attempts) || 0, 'time')}`)),
        h('h3', null, m.question),
        h('div', { class: 'answer-block answer-correct' }, h('span', { class: 'label' }, 'Correct answer'), m.correct_answer),
        m.explanation && h('div', { class: 'answer-block answer-explain' }, h('span', { class: 'label' }, 'Explanation'), m.explanation),
        practiseButton(m.topic, `Practise ${m.topic}`)))));
  }

  function viewMistakes() {
    return h('div', { class: 'view' },
      pageHeader('Mistake review', 'Questions you have got wrong, with the answer and the reasoning behind it.'),
      asyncBlock('mistakes', renderMistakes));
  }

  /* ======================================================================
     7f. Recommendations
     ====================================================================== */
  function renderRecommendPage(rec) {
    const wrapper = h('div', { class: 'view' }, renderRecommendCard(rec, { detailed: true }));
    const topics = Array.isArray(rec.topic_performance) ? rec.topic_performance : [];
    if (!topics.length) return wrapper;

    const sorted = topics.slice().sort((a, b) => (Number(b.priority_score) || 0) - (Number(a.priority_score) || 0));
    wrapper.append(h('article', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', { class: 'card-title' }, 'How topics compare'),
          h('p', { class: 'card-sub' }, 'Priority score combines your error rate with any recent decline. Higher means revise sooner. Recent accuracy covers your three latest attempts per topic.'))),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
        h('caption', { class: 'sr-only' }, 'Topic performance and revision priority'),
        h('thead', null, h('tr', null, ['Topic', 'Attempts', 'Accuracy', 'Recent', 'Trend', 'Priority', ''].map((label, i) =>
          h('th', { scope: 'col', class: i > 0 && i < 6 ? 'num' : null }, label)))),
        h('tbody', null, sorted.map((t) => {
          const trend = Number(t.trend);
          return h('tr', null,
            h('th', { scope: 'row' },
              h('div', { class: 'cell-title' }, t.topic),
              t.needs_more_data && h('div', { class: 'cell-sub' }, 'Limited data: fewer than 10 questions')),
            h('td', { class: 'num' }, num(t.attempts)),
            h('td', { class: 'num' }, pct(t.accuracy)),
            h('td', { class: 'num' }, pct(t.recent_accuracy)),
            h('td', { class: 'num' }, isNil(t.trend) ? '—' : `${trend > 0 ? '+' : ''}${trend} pts`),
            h('td', { class: 'num' }, isNil(t.priority_score) ? '—' : String(t.priority_score)),
            h('td', null, practiseButton(t.topic, 'Practise', 'btn-ghost btn-sm')));
        }))))));
    return wrapper;
  }

  function viewRecommend() {
    return h('div', { class: 'view' },
      pageHeader('Recommendations', 'What to study next, based on your accuracy and recent trend in each topic.'),
      asyncBlock('recommend', renderRecommendPage));
  }

  /* ======================================================================
     8. Boot — all persistent listeners are attached exactly once here.
     ====================================================================== */
  function bindGlobalEvents() {
    document.addEventListener('click', (event) => {
      const themeBtn = event.target.closest('[data-theme-toggle]');
      if (themeBtn) {
        applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark', true);
        return;
      }
      const pwBtn = event.target.closest('[data-toggle-password]');
      if (pwBtn) {
        const input = document.getElementById(pwBtn.dataset.togglePassword);
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        pwBtn.setAttribute('aria-pressed', String(show));
        pwBtn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        return;
      }
      const modeBtn = event.target.closest('[data-auth-mode]');
      if (modeBtn) setAuthMode(modeBtn.dataset.authMode);
    });

    $('#login-form').addEventListener('submit', onLoginSubmit);
    $('#register-form').addEventListener('submit', onRegisterSubmit);
    $('#logout-btn').addEventListener('click', onLogout);

    // Clear a field's error as soon as the student edits it.
    $('#auth-screen').addEventListener('input', (event) => {
      if (event.target.matches('input')) setFieldError(event.target, '');
    });

    $('#sidebar-toggle').addEventListener('click', () => {
      setCollapsed(!$('#app-shell').classList.contains('sidebar-collapsed'), true);
    });
    $('#menu-toggle').addEventListener('click', () => openDrawer(true));
    $('#drawer-close').addEventListener('click', () => openDrawer(false));
    $('#scrim').addEventListener('click', () => openDrawer(false));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && $('#app-shell').classList.contains('nav-open')) openDrawer(false);
    });
    mobileQuery.addEventListener('change', () => { if (!mobileQuery.matches) openDrawer(false); });

    window.addEventListener('hashchange', () => renderRoute());
  }

  async function init() {
    applyTheme(getTheme(), false);
    bindGlobalEvents();
    try {
      const me = await api('/me');
      if (!me.student) throw new ApiError('Unexpected session response.', 200, me);
      startSession(me.student);
    } catch (err) {
      showScreen('auth');
      setAuthMode('login', { focus: false });
      // A 401 simply means "not signed in yet" — no toast for that.
      if (err.status !== 401) toast(`Couldn’t check your session. ${err.message}`, 'error');
    }
  }

  init();
})();