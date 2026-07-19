/* ============================================================
   Mach-Speed frontend — talks to POST /api/analyze (server.js)
   Renders the scorecard produced by report-compiler.js:
   { repo, repoType, score, verdict,
     summary: { passed, failed, checkIt, notApplicable, total },
     checks: [{ id, name, status, confidence, message, findings, weight }] }
   ============================================================ */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var form = $('scan-form');
  var input = $('repo-input');
  var btn = $('scan-btn');
  var loadingEl = $('loading');
  var loadingMsg = $('loading-msg');
  var errorEl = $('error');
  var resultsEl = $('results');
  var checksEl = $('checks');

  var GAUGE_C = 326.73; // 2 * PI * 52 (matches the SVG radius)
  var RECENTS_KEY = 'machspeed.recents.v1';

  var STAGES = [
    'Contacting GitHub…',
    'Reading the file tree…',
    'Classifying repo type…',
    'Running 12 specialists…',
    'Scanning for hardcoded secrets…',
    'Checking ports, hosts & start scripts…',
    'Compiling the scorecard…'
  ];

  var stageTimer = null;

  /* ── Loading state ────────────────────────────────────── */

  function setLoading(on) {
    if (on) {
      var i = 0;
      loadingMsg.textContent = STAGES[0];
      loadingEl.hidden = false;
      stageTimer = setInterval(function () {
        i = (i + 1) % STAGES.length;
        loadingMsg.textContent = STAGES[i];
      }, 3500);
    } else {
      clearInterval(stageTimer);
      stageTimer = null;
      loadingEl.hidden = true;
    }
  }

  /* ── Errors ───────────────────────────────────────────── */

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    errorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function hideError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  function friendlyError(err) {
    if (err && err.name === 'TypeError') {
      return 'Could not reach the analysis server.\nIf you opened this page directly, start Mach-Speed with "npm start" and open http://localhost:3000 instead.';
    }
    return (err && err.message) || 'Something went wrong during the scan.';
  }

  /* ── Escaping (findings contain arbitrary repo content) ─ */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ── Status metadata ──────────────────────────────────── */

  var STATUS_LABEL = {
    'pass': 'Pass',
    'fail': 'Fail',
    'check-it': 'Check it',
    'not-applicable': 'N/A'
  };

  var STATUS_ICON = {
    'pass': '<svg class="status-icon pass" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12.5l2.7 2.7L16.5 9"/></svg>',
    'fail': '<svg class="status-icon fail" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
    'check-it': '<svg class="status-icon check-it" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/></svg>',
    'not-applicable': '<svg class="status-icon not-applicable" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M7 12h10"/></svg>'
  };

  var VERDICT_NOTE = {
    'Excellent': 'Outstanding — this repo looks ready to deploy.',
    'Good': 'Mostly deploy-ready. A few things left to tighten up below.',
    'Fair': 'Deployable, but expect problems. Fix the failed checks first.',
    'Poor': 'Likely to fail on deploy. Work through the failed checks below.',
    'Critical': 'This will almost certainly not deploy in its current state.'
  };

  function impactOf(weight) {
    if (weight >= 8) return { cls: 'impact-high', label: 'High impact' };
    if (weight >= 4) return { cls: 'impact-med', label: 'Medium impact' };
    return { cls: 'impact-low', label: 'Low impact' };
  }

  /* ── Scan ─────────────────────────────────────────────── */

  function scan(repoUrl) {
    hideError();
    resultsEl.hidden = true;
    setLoading(true);
    btn.disabled = true;

    fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl: repoUrl })
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) {
            throw new Error((data && data.error) || ('Scan failed (HTTP ' + res.status + ')'));
          }
          if (!data || typeof data.score !== 'number' || !Array.isArray(data.checks)) {
            throw new Error('Unexpected response from the analysis server.');
          }
          return data;
        });
      })
      .then(function (data) {
        render(data);
        saveRecent(data);
      })
      .catch(function (err) {
        showError(friendlyError(err));
      })
      .finally(function () {
        setLoading(false);
        btn.disabled = false;
      });
  }

  /* ── Render ───────────────────────────────────────────── */

  function render(data) {
    // Header / gauge
    $('repo-link').textContent = data.repo || '';
    $('repo-link').href = 'https://github.com/' + (data.repo || '');

    var verdict = data.verdict || '';
    var verdictEl = $('verdict');
    verdictEl.textContent = verdict;
    verdictEl.className = 'verdict ' + verdict.toLowerCase();

    var typeEl = $('repo-type');
    typeEl.textContent = data.repoType ? ('type: ' + data.repoType) : '';

    $('overview-note').textContent = VERDICT_NOTE[verdict] || '';

    // Gauge arc
    var score = Math.max(0, Math.min(10, data.score));
    $('score-num').textContent = score;
    var arc = $('gauge-arc');
    var hue = Math.round(score * 12); // 0=red … 120=green
    arc.style.stroke = 'hsl(' + hue + ', 45%, 36%)';
    // Animate: start full-offset, then transition to target
    arc.style.strokeDashoffset = String(GAUGE_C);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        arc.style.strokeDashoffset = String(GAUGE_C * (1 - score / 10));
      });
    });

    // Summary strip
    var s = data.summary || {};
    $('summary-strip').innerHTML =
      statHtml('pass', s.passed, 'passed') +
      statHtml('fail', s.failed, 'failed') +
      statHtml('check-it', s.checkIt, 'check it') +
      statHtml('not-applicable', s.notApplicable, 'n/a');

    // Check cards — failures first, then check-it, pass, n/a
    var order = { 'fail': 0, 'check-it': 1, 'pass': 2, 'not-applicable': 3 };
    var checks = data.checks.slice().sort(function (a, b) {
      return (order[a.status] != null ? order[a.status] : 4) -
             (order[b.status] != null ? order[b.status] : 4);
    });

    checksEl.innerHTML = checks.map(checkCardHtml).join('');
    bindFindingsToggles();

    // Reset filters to "all"
    setActiveFilter('all');

    resultsEl.hidden = false;
    resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function statHtml(status, num, label) {
    return '<div class="stat ' + status + '">' +
      '<span class="stat-num">' + esc(num == null ? 0 : num) + '</span>' +
      '<span>' + esc(label) + '</span></div>';
  }

  function checkCardHtml(check) {
    var status = check.status || 'check-it';
    var icon = STATUS_ICON[status] || STATUS_ICON['check-it'];
    var impact = impactOf(check.weight || 1);
    var findings = Array.isArray(check.findings) ? check.findings : [];
    var id = 'findings-' + Math.random().toString(36).slice(2, 9);

    var chips =
      '<span class="mini-chip status ' + esc(status) + '">' + esc(STATUS_LABEL[status] || status) + '</span>' +
      '<span class="mini-chip ' + impact.cls + '">' + impact.label + '</span>';

    var confidenceHtml =
      '<div class="confidence">' +
        '<span class="conf-dots">' + confDots(check.confidence) + '</span>' +
        '<span>' + esc(check.confidence || 'low') + ' confidence</span>' +
      '</div>';

    var findingsHtml = '';
    if (findings.length > 0) {
      findingsHtml =
        '<button type="button" class="findings-toggle" data-target="' + id + '">' +
          findings.length + (findings.length === 1 ? ' finding' : ' findings') +
          '<span class="arrow">▾</span>' +
        '</button>' +
        '<ul class="findings" id="' + id + '">' +
          findings.map(findingHtml).join('') +
        '</ul>';
    }

    return '<article class="check-card status-' + esc(status) + '" data-status="' + esc(status) + '">' +
      '<div class="check-head">' + icon +
        '<div class="check-title">' +
          '<div class="check-name">' + esc(check.name || check.id || 'Check') + '</div>' +
          '<div class="check-id">' + esc(check.id || '') + '</div>' +
        '</div>' +
        '<div class="check-chips">' + chips + '</div>' +
      '</div>' +
      '<p class="check-message">' + esc(check.message || '') + '</p>' +
      confidenceHtml +
      findingsHtml +
    '</article>';
  }

  function confDots(confidence) {
    var level = confidence === 'high' ? 3 : confidence === 'medium' ? 2 : 1;
    var out = '';
    for (var i = 1; i <= 3; i++) {
      out += '<span class="conf-dot' + (i <= level ? ' on' : '') + '"></span>';
    }
    return out;
  }

  function findingHtml(f) {
    // Findings are plain objects whose exact shape varies per specialist.
    if (typeof f === 'string') {
      return '<li class="finding"><div class="finding-top"><span class="finding-text">' + esc(f) + '</span></div></li>';
    }
    if (!f || typeof f !== 'object') {
      return '<li class="finding"><div class="finding-top"><span class="finding-text">' + esc(String(f)) + '</span></div></li>';
    }

    var text = f.issue || f.message || f.description || f.title || f.problem || f.detail || '';
    if (!text) {
      // Fallback: render simple key: value pairs, skipping location fields.
      var parts = [];
      for (var k in f) {
        if (Object.prototype.hasOwnProperty.call(f, k) &&
            ['file', 'path', 'line', 'severity'].indexOf(k) === -1) {
          parts.push(k + ': ' + f[k]);
        }
      }
      text = parts.join(' · ') || 'Finding';
    }

    var loc = '';
    var file = f.file || f.path || '';
    if (file) loc = esc(file) + (f.line != null ? ':' + esc(f.line) : '');

    var sev = f.severity
      ? '<span class="sev ' + esc(String(f.severity).toLowerCase()) + '">' + esc(f.severity) + '</span>'
      : '';

    return '<li class="finding">' +
      '<div class="finding-top">' + sev +
        '<span class="finding-text">' + esc(text) + '</span>' +
      '</div>' +
      (loc ? '<span class="finding-loc">' + loc + '</span>' : '') +
    '</li>';
  }

  function bindFindingsToggles() {
    var toggles = checksEl.querySelectorAll('.findings-toggle');
    for (var i = 0; i < toggles.length; i++) {
      toggles[i].addEventListener('click', function () {
        var target = $(this.getAttribute('data-target'));
        if (!target) return;
        var open = target.classList.toggle('open');
        this.classList.toggle('open', open);
      });
    }
  }

  /* ── Filters ──────────────────────────────────────────── */

  function setActiveFilter(filter) {
    var buttons = document.querySelectorAll('#filters .filter');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('active', buttons[i].getAttribute('data-filter') === filter);
    }
    var cards = checksEl.querySelectorAll('.check-card');
    for (var j = 0; j < cards.length; j++) {
      var show = filter === 'all' || cards[j].getAttribute('data-status') === filter;
      cards[j].style.display = show ? '' : 'none';
    }
  }

  function bindFilters() {
    var buttons = document.querySelectorAll('#filters .filter');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function () {
        setActiveFilter(this.getAttribute('data-filter'));
      });
    }
  }

  /* ── Recent scans (localStorage) ──────────────────────── */

  function loadRecents() {
    try {
      var raw = localStorage.getItem(RECENTS_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function saveRecent(data) {
    if (!data.repo) return;
    var list = loadRecents().filter(function (r) { return r.repo !== data.repo; });
    list.unshift({ repo: data.repo, score: data.score, verdict: data.verdict, at: Date.now() });
    list = list.slice(0, 6);
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list)); } catch (e) { /* private mode */ }
    renderRecents();
  }

  function renderRecents() {
    var list = loadRecents();
    var wrap = $('recents');
    var holder = $('recents-list');
    if (!list.length) { wrap.hidden = true; return; }

    holder.innerHTML = list.map(function (r) {
      var cls = r.score >= 7 ? 'good' : r.score >= 4 ? 'mid' : 'bad';
      return '<button type="button" class="chip" data-repo="' + esc(r.repo) + '">' +
        esc(r.repo) + '<span class="recent-score ' + cls + '">' + esc(r.score) + '/10</span>' +
      '</button>';
    }).join('');

    var chips = holder.querySelectorAll('.chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function () {
        input.value = this.getAttribute('data-repo');
        scan(this.getAttribute('data-repo'));
      });
    }
    wrap.hidden = false;
  }

  /* ── Wire up ──────────────────────────────────────────── */

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = input.value.trim();
    if (!v) {
      showError('Paste a GitHub repo first — for example: github.com/you/your-app');
      input.focus();
      return;
    }
    scan(v);
  });

  var exampleChips = document.querySelectorAll('.examples .chip');
  for (var i = 0; i < exampleChips.length; i++) {
    exampleChips[i].addEventListener('click', function () {
      input.value = this.getAttribute('data-repo');
      scan(this.getAttribute('data-repo'));
    });
  }

  bindFilters();
  renderRecents();
  input.focus();
})();
