(() => {
    const refreshMs = Number(document.currentScript.dataset.refresh) * 1000;
    const diagnosticClock = new Intl.DateTimeFormat('en-US', {
        timeZone: document.currentScript.dataset.timeZone,
        year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
    });
    const dialog = document.querySelector('[aria-labelledby="activity-title"]');
    const form = dialog.querySelector('form');
    const account = document.querySelector('#dashboard-account');
    let diagnosticsTrigger;
    let diagnosticsVersion = 0;
    const diagnosticsDialog = document.querySelector('#dashboard-diagnostics');
    const diagnosticsStatus = diagnosticsDialog.querySelector('#diagnostics-status');
    const diagnosticsCurrent = diagnosticsDialog.querySelector('#diagnostics-current');
    const diagnosticsEvents = diagnosticsDialog.querySelector('#diagnostics-events');
    const diagnosticsRefresh = diagnosticsDialog.querySelector('#diagnostics-refresh');
    const signIn = document.querySelector('#dashboard-sign-in');
    const signInForm = signIn.querySelector('form');
    const password = signInForm.querySelector('#dashboard-password');
    const signInMessage = signInForm.querySelector('[role="status"]');
    const signInSubmit = signInForm.querySelector('[type="submit"]');
    const title = form.querySelector('h2');
    const message = form.querySelector('[role="status"]');
    const submit = form.querySelector('button[type="submit"]');
    const close = form.querySelector('#activity-close');
    let refresh;
    let selected;
    let signedIn = false;
    let configured = true;
    let pendingButton;
    let setupCode = /^#setup=([a-f0-9]{64})$/.exec(window.location.hash)?.[1];
    if (setupCode) history.replaceState(null, '', window.location.pathname + window.location.search);

    const { rows: roster, skills, questCatalog } = JSON.parse(document.querySelector('#fleet-roster').textContent);
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const search = document.querySelector('#search');
    const statusFilter = document.querySelector('#status-filter');
    const filterFields = [search, statusFilter];
    const auto = document.querySelector('#auto');
    const banks = document.querySelector('#banks');
    const banksDialog = document.querySelector('#banks-dialog');
    const detailsDialog = document.querySelector('#fleet-details');
    const inventoryDialog = document.querySelector('#inventory-dialog');
    const inventoryStatus = document.querySelector('#inventory-status');
    const inventoryItems = document.querySelector('#inventory-items');
    const inventoryRefresh = document.querySelector('#inventory-refresh');
    let inventoryBot;
    let inventoryVersion = 0;
    const cards = [...document.querySelectorAll('[data-bot-row]')];
    const groupElements = [...document.querySelectorAll('[data-group]')];
    const fleetEmpty = document.querySelector('#fleet-empty');
    const num = new Intl.NumberFormat('en-US');
    const escape = value => String(value).replace(/[&<>"']/g, character => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
    ));
    const number = value => Number.isFinite(value) ? num.format(value) : '—';
    const table = (headers, rows, label) => `<div class="table-wrap" tabindex="0" aria-label="${label}">
      <table><thead><tr>${headers.map(header => `<th scope="col">${header}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(row => '<tr>' + `<th scope="row">${row[0]}</th>` +
        row.slice(1).map(cell => `<td>${cell}</td>`).join('') + '</tr>').join('')}</tbody></table></div>`;
    const skillTotal = snapshot => snapshot && skills.every(([name]) => Number.isFinite(snapshot.levels[name]))
        ? Object.values(snapshot.levels).reduce((total, level) => total + level, 0) : null;
    let stats = new Map();
    let quests = {};
    let journals = {};
    let questsLoading = false;
    let questsError = '';
    const questMarks = {
        complete: { symbol: '✓', label: 'Complete' },
        'in-progress': { symbol: '▶', label: 'In progress' },
        'not-started': { symbol: '·', label: 'Not started' },
        unknown: { symbol: '—', label: 'Unreported' },
    };
    let dataError = '';
    let updating = false;
    let dataVersion = 0;
    let fleetDataReady = Promise.resolve();
    let sort = { key: 0, direction: 1 };
    let view = 'fleet-panel';
    let shownQuestColumns = 0;

    function matches(name, status) {
        return (statusFilter.value === 'all' || statusFilter.value === status) &&
            name.toLowerCase().includes(search.value.trim().toLowerCase());
    }

    function matchingRows() {
        return roster.filter(({ name, category }) => matches(name, category));
    }

    function updateCards() {
        for (const card of cards) {
            const { name, status } = card.dataset;
            card.hidden = !matches(name, status);
            const stored = stats.get(name);
            const levels = card.querySelector('[data-card-levels]');
            const badges = card.querySelector('[data-card-skills]');
            const xp = card.querySelector('[data-card-xp]');
            const points = quests[name]?.points;
            levels.textContent = [Number.isFinite(points) && `${number(points)} QP`, stored?.skills?.combat != null &&
                `Cb ${number(stored.skills.combat)}`].filter(Boolean).join(' · ');
            levels.hidden = !levels.textContent;
            badges.innerHTML = skills.slice(0, 7).filter(([skill]) => stored?.skills?.levels[skill] != null)
                .map(([skill, short]) => `<span title="${skill}">${short} ${number(stored.skills.levels[skill])}</span>`).join('');
            badges.hidden = !badges.textContent;
            xp.hidden = stored?.xpGained == null;
            xp.textContent = xp.hidden ? '' : `${number(stored.xpGained)} XP · last hour`;
        }
        for (const group of groupElements) {
            const count = group.querySelectorAll('[data-bot-row]:not([hidden])').length;
            group.hidden = count === 0;
            group.querySelector('.count').textContent = count;
        }
        fleetEmpty.hidden = cards.some(card => !card.hidden);
        const reported = Object.values(quests).map(entry => entry.points).filter(Number.isFinite);
        document.querySelector('#quest-total').textContent = reported.length
            ? number(reported.reduce((sum, points) => sum + points, 0)) : '—';
    }

    function questColumnsFor(panel) {
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
        // Budget the Account and QP widths, borders, and one rem per quest.
        const capacity = Math.max(1, Math.floor((panel.clientWidth - 2) / rem - 9.5));
        const bandCount = Math.max(1, Math.ceil(questCatalog.length / capacity));
        return Math.max(1, Math.ceil(questCatalog.length / bandCount));
    }

    function renderQuestGrid(visible, columns) {
        const headers = questCatalog.map(({ id, name }) => {
            const observed = visible.map(row => journals[row.name]?.progress[id]).filter(Boolean);
            const complete = observed.filter(status => status === 'complete').length;
            const count = observed.length ? `${complete}/${observed.length}` : '';
            return `<th scope="col"><span class="quest-column-name">${escape(name)}
                ${count ? `<small aria-label="${complete} complete out of ${observed.length} reported">${count}</small>` : ''}
                </span></th>`;
        });
        const rows = visible.map(({ name, hiscore }) => {
            const journal = journals[name];
            const statuses = questCatalog.map(({ id }) => journal?.progress[id] || 'unknown');
            const completed = statuses.filter(status => status === 'complete').length;
            const underway = statuses.filter(status => status === 'in-progress').length;
            const summary = journal ? `${completed} done${underway ? ` · ${underway} underway` : ''}`
                : 'Awaiting journal';
            const score = quests[name];
            const points = number(score?.points);
            const scoreSource = score?.source === 'game' ? 'Game snapshot' : 'Hiscores';
            const marks = statuses.map(status => {
                const mark = questMarks[status];
                return `<td class="quest-mark ${status}" title="${mark.label}"><span class="visually-hidden">${mark.label}</span>
                    <span aria-hidden="true">${mark.symbol}</span></td>`;
            });
            const account = `<th scope="row" class="quest-account">
                <button type="button" class="button" data-detail="${escape(name)}">${escape(name)}</button>
                <small title="${escape(labelTime(journal?.at))}">${summary}</small></th>
                <td class="quest-points"><a href="${escape(hiscore)}" target="_blank" rel="noopener"
                    title="${scoreSource} · ${escape(labelTime(score?.checkedAt))}">${points}</a></td>`;
            return { account, marks };
        });
        const legend = Object.entries(questMarks).map(([status, { symbol, label }]) =>
            `<span><b class="quest-mark ${status}" aria-hidden="true">${symbol}</b> ${label}</span>`);
        const bands = [];
        for (let start = 0; start < Math.max(1, headers.length); start += columns) {
            const end = start + columns;
            bands.push(`<div class="table-wrap quest-band"><table class="quest-grid" aria-label="Quest progress">
              <thead><tr><th scope="col" class="quest-account">Account</th>
              <th scope="col" class="quest-points" title="Quest points">QP</th>
              ${headers.slice(start, end).join('')}</tr></thead>
              <tbody>${rows.map(({ account, marks }) => `<tr>${account}${marks.slice(start, end).join('')}</tr>`).join('')}</tbody>
            </table></div>`);
        }
        return bands.join('') + `<p class="quest-legend">${legend.join('')}</p>`;
    }

    function renderView() {
        updateCards();
        if (view === 'fleet-panel') return;
        const panel = document.getElementById(view);
        if (!signedIn) {
            panel.innerHTML = '<p class="empty"><button type="button" data-unlock>Sign in</button></p>';
            return;
        }
        const visible = matchingRows();
        const showQuests = view === 'quests-panel';
        const loading = showQuests ? questsLoading : updating;
        const error = showQuests ? questsError : dataError;
        if (!visible.length || loading || error) {
            panel.innerHTML = `<p class="empty" role="status">${escape(error ||
                (loading ? 'Loading dashboard data…' : 'No bots match your filters.'))}</p>`;
            return;
        }
        if (showQuests) {
            shownQuestColumns = questColumnsFor(panel);
            panel.innerHTML = renderQuestGrid(visible, shownQuestColumns);
            return;
        }
        const detail = ({ name }) =>
            `<button type="button" class="button" data-detail="${escape(name)}">${escape(name)}</button>`;
        const columns = [['Account', 'Account'], ['QP', 'Quest points'], ['CB', 'Combat level'], ['TOT', 'Total level'],
            ...skills.map(([name, short]) => [short, name]), ['Last sampled', 'Last sampled']];
        const entries = visible.map(row => {
            const snapshot = stats.get(row.name)?.skills;
            return { row, values: [row.name, quests[row.name]?.points, snapshot?.combat, skillTotal(snapshot),
                ...skills.map(([name]) => snapshot?.levels[name]), snapshot?.at] };
        });
        const { key, direction } = sort;
        entries.sort((a, b) => {
            const x = a.values[key], y = b.values[key];
            if (x == null) return y == null ? 0 : 1;
            if (y == null) return -1;
            return direction * (typeof x === 'string' ? x.localeCompare(y) : x - y);
        });
        panel.innerHTML = table(columns.map(([short, long], index) => `<button type="button" data-sort="${index}"
            title="${long}">${short}${index === key ? (direction === 1 ? ' ↑' : ' ↓') : ''}</button>`),
            entries.map(({ row, values }) => [detail(row), ...values.slice(1, -1).map(value => value === 99
                ? '<strong class="points">99</strong>' : number(value)), escape(labelTime(values.at(-1)))]),
            'Scrollable skill levels') + '<p class="table-caption">Last observed base levels. Offline bots retain their latest snapshot.</p>';
        panel.querySelectorAll('thead th')[key].setAttribute('aria-sort', direction === 1 ? 'ascending' : 'descending');
    }

    function selectTab(tab, focus = false) {
        view = tab.getAttribute('aria-controls');
        for (const button of tabs) {
            const selected = button === tab;
            button.setAttribute('aria-selected', selected);
            button.tabIndex = selected ? 0 : -1;
            document.getElementById(button.getAttribute('aria-controls')).hidden = !selected;
        }
        if (focus) tab.focus();
        saveView();
        renderView();
    }

    function saveView() {
        try {
            sessionStorage.setItem('fleet-view', JSON.stringify({
                view, filters: filterFields.map(field => field.value), auto: auto.getAttribute('aria-pressed'), sort,
            }));
        } catch { /* The dashboard also works when browser storage is disabled. */ }
    }

    function loadFleetData() {
        const version = ++dataVersion;
        updating = true;
        questsLoading = true;
        dataError = '';
        questsError = '';
        renderView();
        const snapshotsReady = request('/bots/activity?view=fleet-data').then(snapshots => {
                if (version !== dataVersion) return;
                stats = new Map(snapshots.map(entry => [entry.name, entry]));
            }).catch(error => {
                if (version === dataVersion) dataError = error.message;
            }).finally(() => {
                if (version !== dataVersion) return;
                updating = false;
                renderView();
            });
        void request('/bots/activity?view=quests').then(result => {
            if (version !== dataVersion) return;
            quests = result.scores;
            journals = result.journals;
        }).catch(error => {
            if (version === dataVersion) questsError = error.message;
        }).finally(() => {
            if (version !== dataVersion) return;
            questsLoading = false;
            renderView();
        });
        return snapshotsReady;
    }

    function openBanks(name) {
        const visible = matchingRows().filter(row => name === undefined || row.name === name);
        document.querySelector('#bank-panel').innerHTML = dataError
            ? `<p class="empty" role="status">${escape(dataError)}</p>` : visible.length
            ? table(['Account', 'Coins', 'Stacks', 'Last observed'], visible.map(row => {
                const bank = stats.get(row.name)?.bank;
                return [escape(row.name), number(bank?.coins), number(bank?.stacks), escape(labelTime(bank?.at))];
            }), 'Last observed bank balances') : '<p class="empty">No bots match your filters.</p>';
        document.querySelector('#bank-title').textContent = name ? 'Bank snapshot for ' + name : 'Bank snapshots';
        clearTimeout(refresh);
        banksDialog.showModal();
    }

    async function loadInventory() {
        const version = ++inventoryVersion;
        inventoryRefresh.disabled = true;
        inventoryStatus.textContent = 'Reading inventory…';
        inventoryItems.replaceChildren();
        try {
            const snapshot = await request('/bots/activity?view=inventory&bot=' + encodeURIComponent(inventoryBot));
            if (version !== inventoryVersion || !inventoryDialog.open) return;
            if (snapshot.availability !== 'live') {
                inventoryStatus.textContent = snapshot.availability === 'offline'
                    ? 'This bot is offline.' : 'The game has not published a fresh inventory.';
                return;
            }
            inventoryStatus.textContent = snapshot.items.length
                ? `Snapshot ${labelTime(snapshot.capturedAt)}` : 'The backpack is empty.';
            if (snapshot.items.length) {
                inventoryItems.innerHTML = table(['Slot', 'Item', 'Quantity'], snapshot.items.map(item =>
                    [number(item.slot + 1), escape(item.name), number(item.count)]), 'Current backpack inventory');
            }
        } catch (error) {
            if (version === inventoryVersion && inventoryDialog.open) inventoryStatus.textContent = error.message;
        } finally {
            if (version === inventoryVersion) inventoryRefresh.disabled = false;
        }
    }

    function openInventory(name) {
        inventoryBot = name;
        document.querySelector('#inventory-title').textContent = `Current inventory · ${name}`;
        clearTimeout(refresh);
        inventoryDialog.showModal();
        void loadInventory();
    }

    function openDetails(name) {
        const card = cards.find(element => element.dataset.name === name);
        if (!card) return;
        const row = stats.get(name);
        const snapshot = row?.skills;
        document.querySelector('#fleet-details-title').textContent = name;
        document.querySelector('#fleet-details-status').textContent = card.querySelector('.reason').textContent.trim();
        const report = document.querySelector('#fleet-details-content');
        report.replaceChildren();
        for (const element of card.querySelectorAll('.task-line, .log, .facts, .location-line, .skills')) {
            report.append(element.cloneNode(true));
        }
        const summary = document.createElement('p');
        summary.className = 'table-caption';
        summary.textContent = snapshot ? `Total level ${number(skillTotal(snapshot))} · Sampled ${labelTime(snapshot.at)}`
            : 'No skill snapshot has been reported.';
        report.append(summary);
        clearTimeout(refresh);
        detailsDialog.showModal();
    }

    function installFleet() {
        let saved;
        try { saved = JSON.parse(sessionStorage.getItem('fleet-view')); } catch { /* Reset stored preferences. */ }
        if (saved?.filters?.length >= filterFields.length) {
            filterFields.forEach((field, index) => { field.value = saved.filters[index]; });
        }
        if (saved?.auto === 'false') auto.setAttribute('aria-pressed', 'false');
        if (Number.isInteger(saved?.sort?.key) && saved.sort.key >= 0 && saved.sort.key < skills.length + 5) sort = saved.sort;
        selectTab(tabs.find(tab => tab.getAttribute('aria-controls') === saved?.view) || tabs[0]);
        document.querySelector('#refresh').addEventListener('click', () => window.location.reload());
        window.addEventListener('resize', () => {
            if (view !== 'quests-panel') return;
            const panel = document.getElementById(view);
            if (questColumnsFor(panel) !== shownQuestColumns) renderView();
        });
        auto.addEventListener('click', () => {
            auto.setAttribute('aria-pressed', auto.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
            saveView();
            scheduleRefresh();
        });
        for (const field of filterFields) {
            field.addEventListener('input', () => { saveView(); renderView(); });
        }
        for (const tab of tabs) {
            tab.addEventListener('click', () => selectTab(tab));
            tab.addEventListener('keydown', event => {
                const index = tabs.indexOf(tab);
                const next = { ArrowLeft: (index + tabs.length - 1) % tabs.length,
                    ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
                if (next === undefined) return;
                event.preventDefault();
                selectTab(tabs[next], true);
            });
        }
        for (const modal of [banksDialog, detailsDialog, inventoryDialog]) {
            modal.querySelector('[data-close]').addEventListener('click', () => modal.close());
            modal.addEventListener('close', scheduleRefresh);
        }
        inventoryRefresh.addEventListener('click', loadInventory);
        inventoryDialog.addEventListener('close', () => { inventoryVersion++; });
        document.addEventListener('click', async event => {
            const button = event.target.closest('button');
            if (!button) return;
            if (button.hasAttribute('data-sort')) {
                const key = Number(button.dataset.sort);
                sort = { key, direction: key === sort.key ? -sort.direction : 1 };
                saveView();
                renderView();
                document.querySelector(`[data-sort="${key}"]`)?.focus();
                return;
            }
            if (button !== banks && !button.matches('[data-bank], [data-detail], [data-inventory], [data-diagnostics], [data-unlock]')) return;
            await sessionReady;
            if (!signedIn) {
                openSignIn(button.hasAttribute('data-unlock') ? undefined : button);
                return;
            }
            if (button.dataset.diagnostics) {
                openDiagnostics(button);
                return;
            }
            if (button.dataset.inventory) {
                openInventory(button.dataset.inventory);
                return;
            }
            await fleetDataReady;
            if (!signedIn) return;
            if (button.dataset.detail) {
                openDetails(button.dataset.detail);
            } else if (button === banks || button.dataset.bank) {
                openBanks(button.dataset.bank);
            }
        });
        scheduleRefresh();
    }

    function scheduleRefresh() {
        clearTimeout(refresh);
        if (auto.getAttribute('aria-pressed') === 'true') {
            refresh = setTimeout(() => {
                if (document.querySelector('dialog[open]') || document.activeElement === search) scheduleRefresh();
                else window.location.reload();
            }, refreshMs);
        }
    }

    function setSignedIn(value) {
        signedIn = value;
        account.textContent = value ? 'Sign out' : 'Sign in';
        if (value) {
            fleetDataReady = loadFleetData();
        } else {
            dataVersion++;
            updating = false;
            stats.clear();
            quests = {};
            journals = {};
            questsLoading = false;
            renderView();
        }
    }

    function openSignIn(button) {
        clearTimeout(refresh);
        pendingButton = button;
        password.autocomplete = configured ? 'current-password' : 'new-password';
        password.minLength = configured ? 0 : 12;
        signInSubmit.textContent = configured ? 'Sign in' : 'Set password and sign in';
        const needsLink = !configured && !setupCode;
        signInSubmit.disabled = needsLink;
        password.disabled = needsLink;
        signInMessage.textContent = needsLink ? 'Open your one-time dashboard setup link.'
            : auditPending || button?.matches('#audit-open,[data-audit-bot]') ? 'Sign in to open the audit history.' : '';
        signIn.showModal();
    }

    const auditDialog = document.querySelector('#audit-dialog');
    const auditForm = document.querySelector('#audit-filters');
    const auditBot = document.querySelector('#audit-bot');
    const auditTask = document.querySelector('#audit-task');
    const auditDays = document.querySelector('#audit-days');
    const auditMode = document.querySelector('#audit-mode');
    const auditSummaryPhase = document.querySelector('#audit-summary-phase');
    const auditSummaryPhaseField = document.querySelector('#audit-summary-phase-field');
    const auditPhase = document.querySelector('#audit-phase');
    const auditStatus = document.querySelector('#audit-status');
    const auditContent = document.querySelector('#audit-content');
    const auditOlder = document.querySelector('#audit-older');
    const auditLink = new URLSearchParams(location.search);
    let auditPending = auditLink.has('audit');
    let auditRun = '';
    let auditCursor = null;
    let auditVersion = 0;
    let auditRows = [];

    const auditJson = value => `<details><summary>Evidence</summary><pre>${escape(JSON.stringify(value, null, 2))}</pre></details>`;
    const auditList = (title, rows, render) => rows?.length
        ? `<section><h3>${title}</h3><ul>${rows.map(render).join('')}</ul></section>` : '';
    const auditEventRow = ({ at, phase, kind, name, data }) => `<li class="audit-row">
        <small>${escape([labelTime(at), phase, kind, data.operationId && 'Operation ' + data.operationId].filter(Boolean).join(' · '))}</small>
        <p><strong>${escape(name)}</strong>${data.outcome ? ' · ' + escape(data.outcome) : ''}</p>
        ${data.intent ? '<p>' + escape(data.intent) + '</p>' : ''}
        ${data.message ? '<p>' + escape(data.message) + '</p>' : ''}${auditJson(data)}</li>`;
    const auditRunRow = row => `<li class="audit-row"><button type="button" data-audit-run="${escape(row.id)}"
        aria-label="Open ${escape(row.task)} run for ${escape(row.bot)} at ${escape(labelTime(row.started_at))}">${escape(row.task)}</button>
        <span> ${escape(row.bot)} · ${escape(row.status)}</span><p><small>${escape(labelTime(row.started_at))}</small></p>
        ${row.failure_message ? '<p>' + escape(row.failure_message) + '</p>' : ''}</li>`;

    async function loadAudit(older = false, firstBefore, firstLimit) {
        const version = ++auditVersion;
        const params = new URLSearchParams({ view: 'audit', limit: firstLimit || '50' });
        if (auditRun) {
            params.set('run', auditRun);
            if (auditPhase.value) params.set('phase', auditPhase.value);
        } else {
            params.set('mode', auditMode.value);
            params.set('days', auditDays.value || '35');
            if (auditBot.value.trim()) params.set('bot', auditBot.value.trim());
            if (auditTask.value.trim()) params.set('task', auditTask.value.trim());
            if (auditMode.value === 'summary' && auditSummaryPhase.value.trim()) params.set('phase', auditSummaryPhase.value.trim());
        }
        if (older && auditCursor) params.set('before', auditCursor);
        if (firstBefore) params.set('before', firstBefore);
        auditStatus.textContent = 'Loading audit history…';
        auditOlder.disabled = true;
        try {
            const report = await request('/bots/activity?' + params);
            if (!auditDialog.open || auditVersion !== version) return;
            auditCursor = report.nextBefore;
            auditOlder.hidden = !auditCursor;
            auditOlder.textContent = auditRun ? 'Load older events' : 'Load older runs';
            if (auditRun) {
                const row = report.run;
                if (!auditBot.value) auditBot.value = row.bot;
                const currentPhase = auditPhase.value;
                auditPhase.replaceChildren(new Option('All phases', ''), ...report.phases.map(phase => new Option(phase.phase, phase.phase)));
                auditPhase.value = currentPhase;
                document.querySelector('#audit-title').textContent = row.bot + ' · ' + row.task;
                auditRows = older ? [...report.events, ...auditRows] : report.events;
                auditStatus.textContent = `${row.status} · ${auditRows.length} events shown · ${number(row.details_available)} retained`;
                auditContent.innerHTML = `<p class="audit-meta">${escape(labelTime(row.started_at))} · Revision ${escape(row.revision ?? 'unreported')}</p>
                    ${row.failure_message ? '<p>' + escape([row.failure_phase, row.failure_step, row.failure_message].filter(Boolean).join(' · ')) + '</p>' : ''}
                    ${auditList('Timeline', auditRows, auditEventRow)}
                    ${auditList('Retained failure evidence', report.failureEvidence, auditEventRow)}
                    ${auditList('Phase totals', report.phases, phase => `<li class="audit-row">${escape(phase.phase)}
                        · ${number(Math.round(phase.duration_ms / 1000))} s · ${number(phase.actions)} actions · ${number(phase.setbacks)} setbacks</li>`)}
                    ${auditList('Milestones and setbacks', report.signals, signal => `<li class="audit-row">${escape(signal.name)}
                        · ${escape(signal.phase)} · ${number(signal.count)}${signal.evidence ? auditJson(signal.evidence) : ''}</li>`)}`;
            } else if (auditMode.value === 'summary') {
                auditStatus.textContent = report.breakpoints.length || report.totals.length || report.signals.length
                    ? `Runs started within the last ${auditDays.value || 35} days` : 'No audit activity matches these filters.';
                auditContent.innerHTML = auditList('Recurring failures', report.breakpoints, point => `<li class="audit-row">
                    <strong>${escape(point.task)}</strong> · ${escape([point.phase, point.step, point.site].filter(Boolean).join(' · '))}
                    <p>${number(point.runs)} runs · ${number(point.bots)} bots · ${escape(point.example_message ?? '')}</p>
                    <small>Revision ${escape(point.revision ?? 'unreported')}</small></li>`) +
                    auditList('Phase totals', report.totals, phase => `<li class="audit-row">${escape([phase.task, phase.phase, phase.run_outcome].join(' · '))}
                        <p>${number(phase.runs)} runs · ${number(Math.round(phase.duration_ms / 1000))} s · ${number(phase.actions)} actions · ${number(phase.setbacks)} setbacks</p></li>`) +
                    auditList('Milestones and setbacks', report.signals, signal => `<li class="audit-row">${escape([signal.task, signal.phase, signal.name].join(' · '))}
                        <p>${number(signal.count)} occurrences · ${number(signal.before_later_failure)} before a later failure</p>
                        <small>Revision ${escape(signal.revision ?? 'unreported')}</small>${auditJson(signal)}</li>`);
            } else {
                auditRows = older ? [...auditRows, ...report.runs] : report.runs;
                auditStatus.textContent = auditRows.length ? `${auditRows.length} runs shown` : 'No runs match these filters.';
                auditContent.innerHTML = auditList('Runs', auditRows, auditRunRow);
            }
        } catch (error) {
            if (auditVersion === version) auditStatus.textContent = error.message;
        } finally {
            if (auditVersion === version) auditOlder.disabled = false;
        }
    }

    function showAuditRun(run = '', phase = '', before, limit) {
        auditRun = run;
        auditPhase.replaceChildren(new Option('All phases', ''), ...(phase ? [new Option(phase, phase)] : []));
        auditPhase.value = phase;
        auditRows = [];
        auditCursor = null;
        auditOlder.hidden = true;
        auditForm.hidden = Boolean(run);
        document.querySelector('#audit-run-tools').hidden = !run;
        document.querySelector('#audit-title').textContent = run ? 'Audit run' : 'Audit history';
        auditContent.replaceChildren();
        void loadAudit(false, before, limit);
    }

    function openAudit(params) {
        clearTimeout(refresh);
        auditPending = false;
        auditBot.value = params.get('bot') || '';
        auditTask.value = params.get('task') || '';
        auditDays.value = params.get('days') || '35';
        auditMode.value = params.get('mode') === 'summary' ? 'summary' : 'runs';
        auditSummaryPhase.value = auditMode.value === 'summary' ? params.get('phase') || '' : '';
        auditSummaryPhaseField.hidden = auditMode.value !== 'summary';
        if (!auditDialog.open) auditDialog.showModal();
        showAuditRun(params.get('run') || '', params.get('phase') || '', params.get('before'), params.get('limit'));
    }

    auditForm.addEventListener('submit', event => { event.preventDefault(); showAuditRun(); });
    auditMode.addEventListener('change', () => { auditSummaryPhaseField.hidden = auditMode.value !== 'summary'; });
    auditContent.addEventListener('click', event => {
        const button = event.target.closest('[data-audit-run]');
        if (button) showAuditRun(button.dataset.auditRun);
    });
    auditDialog.querySelector('[data-close]').addEventListener('click', () => auditDialog.close());
    auditDialog.addEventListener('close', () => {
        auditVersion++;
        if (auditLink.has('audit')) history.replaceState(null, '', '/bots');
        scheduleRefresh();
    });
    auditOlder.addEventListener('click', () => loadAudit(true));
    auditPhase.addEventListener('change', () => loadAudit());
    document.querySelector('#audit-refresh').addEventListener('click', () => loadAudit());
    document.querySelector('#audit-back').addEventListener('click', () => {
        auditMode.value = 'runs';
        auditSummaryPhaseField.hidden = true;
        showAuditRun();
    });
    document.querySelectorAll('#audit-open,[data-audit-bot]').forEach(button => button.addEventListener('click', async () => {
        await sessionReady;
        if (!signedIn) return openSignIn(button);
        openAudit(new URLSearchParams(button.dataset.auditBot ? { bot: button.dataset.auditBot } : {}));
    }));

    const sessionReady = request('/bots/activity?session=status')
        .then(state => {
            configured = state.configured;
            setSignedIn(state.signedIn);
            if (auditPending && signedIn) openAudit(auditLink);
            else if ((auditPending || !configured && setupCode) && !signIn.open) openSignIn();
        }).catch(() => {});
    account.addEventListener('click', async () => {
        await sessionReady;
        if (!signedIn) {
            openSignIn();
            return;
        }
        account.disabled = true;
        try {
            await request('/bots/activity?session=logout', {});
            setSignedIn(false);
        } catch (error) {
            openSignIn();
            signInMessage.textContent = error.message;
        } finally {
            account.disabled = false;
        }
    });
    signInForm.querySelector('[type="button"]').addEventListener('click', () => {
        if (!signInSubmit.disabled || password.disabled) signIn.close();
    });
    signIn.addEventListener('cancel', event => {
        if (signInSubmit.disabled && !password.disabled) event.preventDefault();
    });
    signIn.addEventListener('close', () => {
        signInForm.reset();
        pendingButton = undefined;
        if (auditPending && !signedIn) {
            auditPending = false;
            history.replaceState(null, '', '/bots');
        }
        if (!dialog.open && !diagnosticsDialog.open) scheduleRefresh();
    });
    signInForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (signInSubmit.disabled) return;
        signInSubmit.disabled = true;
        try {
            await request(configured ? '/bots/activity?session=login' : '/bots/activity?session=setup',
                configured ? { password: password.value } : { password: password.value, code: setupCode });
            configured = true;
            setupCode = undefined;
            setSignedIn(true);
            const button = pendingButton;
            signIn.close();
            if (auditPending) openAudit(auditLink);
            else if (button) button.click();
        } catch (error) {
            signInMessage.textContent = error.message;
        } finally {
            password.value = '';
            signInSubmit.disabled = false;
        }
    });

    for (const button of document.querySelectorAll('[data-bot][data-action]')) {
        button.addEventListener('click', async () => {
            await sessionReady;
            if (!signedIn) {
                openSignIn(button);
                return;
            }
            clearTimeout(refresh);
            selected = button;
            title.textContent = button.textContent + ' for ' + button.dataset.bot;
            submit.textContent = button.textContent;
            submit.disabled = false;
            message.textContent = '';
            dialog.showModal();
        });
    }
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', event => {
        if (close.disabled) event.preventDefault();
    });
    dialog.addEventListener('close', () => {
        form.reset();
        if (!signIn.open && !dialog.open) scheduleRefresh();
    });

    async function request(path, payload) {
        const headers = { Accept: 'application/json' };
        const options = {
            headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
            signal: AbortSignal.timeout(['stop', 'pause'].includes(payload?.action) ? 45000 : 15000),
        };
        if (payload !== undefined) {
            headers['Content-Type'] = 'application/json';
            options.method = 'POST';
            options.body = JSON.stringify(payload);
        }
        let response;
        try {
            response = await fetch(path, options);
        } catch {
            throw new Error('The control API did not respond. Check the activity before retrying.');
        }
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(result.error || 'The control API could not complete the request.');
            error.status = response.status;
            throw error;
        }
        return result;
    }

    function labelTime(value) {
        return value ? diagnosticClock.format(new Date(value)) : '—';
    }

    async function loadDiagnostics() {
        const version = ++diagnosticsVersion;
        const bot = diagnosticsTrigger.dataset.diagnostics;
        diagnosticsRefresh.disabled = true;
        diagnosticsStatus.textContent = 'Loading diagnostics…';
        try {
            const { reading, history } = await request('/bots/activity?view=diagnostics&bot=' + encodeURIComponent(bot));
            if (!diagnosticsDialog.open || version !== diagnosticsVersion) return;
            const controller = reading?.controller;
            const game = reading?.game;
            const player = game?.player;
            const exit = controller?.lastTask;
            const rows = [
                ['Bot', reading?.bot ?? bot],
                ['Controller', controller ? 'Responding' : 'Unavailable'],
                ['Managed client', controller?.client ? (controller.client.stopping ? 'Stopping' : 'Running since ' + labelTime(controller.client.startedAt)) : controller ? 'Stopped' : 'Unknown'],
                ['Activity', controller?.task?.activity ?? controller?.task?.name ??
                    (controller?.starting ? 'Starting ' + controller.starting : controller ? 'Idle' : 'Unknown')],
                ['Waiting for', controller?.task?.recovery
                    ? `HP recovery to ${controller.task.recovery.resumeAt} HP · since ${labelTime(controller.task.recovery.since)}` : '—'],
                ['Activity started', labelTime(controller?.task?.startedAt)],
                ['Last task exit', exit ? exit.name + ' · code ' + exit.exitCode + ' · ' + labelTime(exit.finishedAt) : '—'],
                ['Last start error', controller?.startError ?? '—'],
                ['Game state', game ? game.availability + (game.stateAgeMs == null ? '' : ' · ' + game.stateAgeMs + ' ms old at sample') : '—'],
                ['Game tick', game?.tick ?? '—'],
                ['Position', player ? 'X ' + player.x + ', Z ' + player.z + (player.plane == null ? '' : ' · Plane ' + player.plane) : '—'],
                ['Health / combat', player ? player.hp + '/' + player.maxHp + (player.inCombat ? ' · In combat' : ' · Out of combat') : '—'],
                ['Last movement observed', labelTime(reading?.movedAt)],
                ['Last XP gain observed', labelTime(reading?.gainedXpAt)],
            ];
            diagnosticsCurrent.replaceChildren(...rows.map(([label, value]) => {
                const row = document.createElement('tr');
                const heading = document.createElement('th');
                heading.scope = 'row';
                heading.textContent = label;
                row.append(heading);
                row.insertCell().textContent = value;
                return row;
            }));
            diagnosticsEvents.replaceChildren(...(history.length ? history : [{ message: 'No events recorded yet.' }]).map(({ at, message }) => {
                const entry = document.createElement('li');
                if (at) {
                    const time = document.createElement('time');
                    time.dateTime = at;
                    time.textContent = labelTime(at) + ' · ';
                    entry.append(time);
                }
                entry.append(message);
                return entry;
            }));
            diagnosticsStatus.textContent = 'Sampled ' + labelTime(reading?.checkedAt);
        } catch (error) {
            if (!diagnosticsDialog.open || version !== diagnosticsVersion) return;
            if (error.status === 401) {
                setSignedIn(false);
                diagnosticsDialog.close();
                openSignIn(diagnosticsTrigger);
            } else {
                diagnosticsStatus.textContent = error.message;
            }
        } finally {
            if (version === diagnosticsVersion) diagnosticsRefresh.disabled = false;
        }
    }

    function openDiagnostics(button) {
        clearTimeout(refresh);
        diagnosticsTrigger = button;
        diagnosticsDialog.querySelector('#diagnostics-title').textContent = `Diagnostics · ${button.dataset.diagnostics}`;
        diagnosticsDialog.showModal();
        void loadDiagnostics();
    }
    diagnosticsDialog.querySelector('#diagnostics-close').addEventListener('click', () => diagnosticsDialog.close());
    diagnosticsRefresh.addEventListener('click', loadDiagnostics);
    diagnosticsDialog.addEventListener('close', () => {
        diagnosticsVersion++;
        diagnosticsCurrent.replaceChildren();
        diagnosticsEvents.replaceChildren();
        if (!signIn.open) scheduleRefresh();
    });

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (submit.disabled) return;
        submit.disabled = close.disabled = true;
        message.textContent = 'Stopping activity…';
        try {
            const bot = selected.dataset.bot;
            await request('/bots/activity?bot=' + encodeURIComponent(bot), { bot, action: 'stop' });
            window.location.reload();
        } catch (error) {
            if (error.status === 401) {
                setSignedIn(false);
                dialog.close();
                openSignIn(selected);
            } else {
                message.textContent = error.message;
            }
        } finally {
            submit.disabled = close.disabled = false;
        }
    });

    const planDialog = document.querySelector('#plan-dialog');
    const planForm = planDialog.querySelector('form');
    const planTitle = planDialog.querySelector('#plan-title');
    const planName = planDialog.querySelector('#plan-bot-name');
    const planNameField = planDialog.querySelector('#plan-name-field');
    const planError = planDialog.querySelector('#plan-error');
    const planSteps = planDialog.querySelector('#plan-steps');
    const planAdd = planDialog.querySelector('#plan-add');
    const planEdit = planDialog.querySelector('#plan-edit');
    const planSave = planDialog.querySelector('#plan-save');
    const planClose = planDialog.querySelector('#plan-close');
    let planBot = null;
    let planState = null;
    let planCatalog = [];
    let planSkills = [];
    let draft = [];
    let editing = false;
    let planChanged = false;
    let planVersion = 0;
    let planWatch;

    const planUrl = () => '/bots/activity?view=plan' + (planBot ? '&bot=' + encodeURIComponent(planBot) : '');
    const metaFor = id => planCatalog.find(entry => entry.id === id);
    const labelFor = id => metaFor(id)?.label || (id === 'skip-tutorial' ? 'Skip Tutorial Island' : id);
    const questChoices = () => planCatalog.filter(entry => entry.category === 'Quests');
    const finishLabel = finish => finish.type === 'level' ? `Until ${finish.skill} ${finish.level}`
        : finish.type === 'minutes' ? `${finish.minutes} min`
        : finish.type === 'forever' ? 'Indefinite grind' : 'Until complete';
    const requirementLabel = req => req.type === 'quest' ? labelFor(req.task) : `${req.skill} ${req.level}`;

    function node(tag, text, className) {
        const element = document.createElement(tag);
        if (text) element.textContent = text;
        if (className) element.className = className;
        return element;
    }

    function planButton(text, fn, title = text) {
        const button = node('button', text);
        button.type = 'button';
        button.title = title;
        button.setAttribute('aria-label', title);
        button.addEventListener('click', fn);
        return button;
    }

    function planField(label, input) {
        const field = node('label', label);
        field.append(input);
        return field;
    }

    function planSelect(values, value, change) {
        const select = node('select');
        values.forEach(([id, text]) => select.append(new Option(text, id)));
        select.value = value;
        select.addEventListener('change', () => change(select.value));
        return select;
    }

    function planNumber(value, min, max, change) {
        const input = node('input');
        input.type = 'number';
        input.required = true;
        input.min = String(min);
        input.max = String(max);
        input.value = Number.isFinite(value) ? String(value) : '';
        input.addEventListener('input', () => change(input.valueAsNumber));
        return input;
    }

    function defaultStep(task = planCatalog[0]?.id) {
        return { task, requirements: [], finish: metaFor(task)?.usage === 'once'
            ? { type: 'complete' } : { type: 'minutes', minutes: 30 } };
    }

    function renderRequirement(item, step, index) {
        const row = node('div', '', 'plan-requirement');
        const kind = planSelect([['level', 'Skill level'], ['quest', 'Quest']], item.type, type => {
            step.requirements[index] = type === 'quest'
                ? { type, task: questChoices().find(q => q.id !== step.task)?.id }
                : { type, skill: planSkills[0], level: 10 };
            renderPlan();
        });
        const field = item.type === 'quest'
            ? planField('Quest', planSelect(questChoices().filter(q => q.id !== step.task)
                .map(q => [q.id, q.label]), item.task, task => { item.task = task; }))
            : planField('Skill', planSelect(planSkills.map(skill => [skill, skill]), item.skill, skill => { item.skill = skill; }));
        row.append(planField('Requirement type', kind), field);
        if (item.type === 'level') row.append(planField('Minimum level', planNumber(item.level, 1, 99, value => { item.level = value; })));
        row.append(planButton('Remove', () => { step.requirements.splice(index, 1); renderPlan(); }, 'Remove this requirement'));
        return row;
    }

    function renderStep(step, index) {
        const meta = metaFor(step.task);
        const row = node('li', '', 'plan-step');
        const select = node('select');
        for (const category of [...new Set(planCatalog.map(entry => entry.category))]) {
            const group = node('optgroup');
            group.label = category;
            planCatalog.filter(entry => entry.category === category).forEach(entry => group.append(new Option(entry.label, entry.id)));
            select.append(group);
        }
        select.value = step.task;
        select.addEventListener('change', () => {
            const replacement = defaultStep(select.value);
            replacement.requirements = step.requirements.filter(req => req.type !== 'quest' || req.task !== replacement.task);
            draft[index] = replacement;
            renderPlan();
        });
        const ordering = node('div', '', 'plan-order');
        for (const [symbol, offset, title] of [['↑', -1, 'Move activity up'], ['↓', 1, 'Move activity down']]) {
            const button = planButton(symbol, () => {
                const next = index + offset;
                [draft[index], draft[next]] = [draft[next], draft[index]];
                renderPlan();
            }, title);
            button.disabled = index + offset < 0 || index + offset >= draft.length;
            ordering.append(button);
        }
        ordering.append(planButton('Remove', () => { draft.splice(index, 1); renderPlan(); }, 'Remove this activity'));
        const head = node('div', '', 'plan-step-head');
        head.append(planField('Activity', select), ordering);
        row.append(head, node('small', meta?.usage === 'once' ? 'One-time quest' : 'Repeatable activity', 'plan-kind'));
        if (meta?.usage === 'repeatable') {
            const stopRow = node('div', '', 'plan-end');
            const modes = [['minutes', 'Time spent'], ...(meta.trains?.length ? [['level', 'Skill level']] : []), ['forever', 'Indefinite grind']];
            stopRow.append(planField('Finish when', planSelect(modes, step.finish.type, type => {
                step.finish = type === 'minutes' ? { type, minutes: 30 }
                    : type === 'level' ? { type, skill: meta.trains[0], level: 40 } : { type };
                renderPlan();
            })));
            if (step.finish.type === 'minutes') {
                stopRow.append(planField('Minutes', planNumber(step.finish.minutes, 1, 10080, value => { step.finish.minutes = value; })));
            } else if (step.finish.type === 'level') {
                stopRow.append(planField('Skill', planSelect(meta.trains.map(skill => [skill, skill]), step.finish.skill, skill => { step.finish.skill = skill; })),
                    planField('Target level', planNumber(step.finish.level, 1, 99, value => { step.finish.level = value; })));
            }
            row.append(stopRow);
        }
        const requirements = node('details', '', 'plan-requirements');
        requirements.open = step.requirements.length > 0;
        requirements.append(node('summary', 'Prerequisites' + (step.requirements.length ? ` (${step.requirements.length} added)` : '')));
        if (meta?.requirements?.length) requirements.append(node('p', 'Automatic · ' + meta.requirements.map(requirementLabel).join(' · ')));
        step.requirements.forEach((item, i) => requirements.append(renderRequirement(item, step, i)));
        const add = planButton('Add prerequisite', () => {
            step.requirements.push({ type: 'level', skill: planSkills[0], level: 10 });
            renderPlan();
        });
        add.disabled = step.requirements.length >= 4;
        requirements.append(add);
        row.append(requirements);
        return row;
    }

    function renderPlan() {
        planNameField.hidden = !!planBot || !editing;
        planName.disabled = planNameField.hidden;
        const list = editing ? draft : planState?.steps ?? [];
        planSteps.replaceChildren(...list.map((step, index) => {
            if (editing) return renderStep(step, index);
            const row = node('li', '', 'plan-step plan-readonly');
            row.append(node('strong', labelFor(step.task)), node('small', finishLabel(step.finish)));
            const state = index < planState.index ? 'Done' : index === planState.index ? 'Current' : 'Queued';
            row.append(node('small', state, 'plan-kind'));
            return row;
        }));
        planAdd.hidden = !editing;
        planAdd.disabled = draft.length >= 12;
        planEdit.hidden = editing || !planState || planState.status === 'running';
        planEdit.textContent = planState?.status === 'complete' ? 'New plan' : 'Edit as new plan';
        planSave.hidden = !editing && (!planState || planState.status === 'complete');
        planSave.disabled = editing && !draft.length;
        planSave.textContent = editing ? planBot ? 'Start plan' : 'Create bot and start'
            : planState?.status === 'running' ? 'Pause plan' : 'Resume plan';
        if (!editing && planState) {
            const work = planState.work;
            const progress = work?.finish.type === 'minutes' ? ` · ${Math.floor(planState.elapsedMs / 60000)} of ${work.finish.minutes} min` : '';
            planError.textContent = planState.message ||
                (work && planState.status === 'running'
                    ? `${work.inserted ? 'Prerequisite · ' : ''}${labelFor(work.task)}${progress}${work.reason ? ' · ' + work.reason : ''}`
                    : planState.status === 'running' ? 'Waiting for live game state…'
                        : planState.status === 'complete' ? 'Plan complete.' : 'Plan paused.');
        }
    }

    async function refreshPlan(version, initialLoad = false) {
        try {
            const data = await request(planUrl());
            if (version !== planVersion || !planDialog.open) return;
            planCatalog = data.catalog;
            planSkills = data.skills;
            planState = data.plan;
            if (initialLoad) {
                editing = !planState;
                draft = editing ? [defaultStep()] : [];
                planError.textContent = '';
            }
            renderPlan();
            if (!editing && planState?.status === 'running') planWatch = setTimeout(() => void refreshPlan(version), 3000);
        } catch (error) {
            if (version === planVersion) planError.textContent = error.message;
        }
    }

    for (const button of document.querySelectorAll('#new-bot, [data-plan-bot]')) {
        button.addEventListener('click', async () => {
            await sessionReady;
            if (!signedIn) { openSignIn(button); return; }
            clearTimeout(refresh);
            planBot = button.dataset.planBot || null;
            planState = null;
            draft = [];
            editing = planChanged = false;
            planName.value = '';
            planTitle.textContent = planBot ? `Activity plan · ${planBot}` : 'New bot';
            planError.textContent = 'Loading activities…';
            renderPlan();
            planDialog.showModal();
            void refreshPlan(++planVersion, true);
        });
    }

    planAdd.addEventListener('click', () => { draft.push(defaultStep()); renderPlan(); });
    planEdit.addEventListener('click', () => {
        draft = planState.status === 'complete' ? [defaultStep()] : structuredClone(planState.steps);
        editing = true;
        planError.textContent = '';
        renderPlan();
    });
    planClose.addEventListener('click', () => planDialog.close());
    planDialog.addEventListener('cancel', event => { if (planClose.disabled) event.preventDefault(); });
    planDialog.addEventListener('close', () => {
        planVersion++;
        clearTimeout(planWatch);
        if (planChanged) window.location.reload();
        else scheduleRefresh();
    });
    planForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (planSave.disabled) return;
        if (editing && draft.some((step, index) => step.finish.type === 'forever' && index !== draft.length - 1)) {
            planError.textContent = 'Move the indefinite grind to the end of the plan.';
            return;
        }
        clearTimeout(planWatch);
        const version = ++planVersion;
        planSave.disabled = planClose.disabled = true;
        const action = editing ? planBot ? 'start' : 'create' : planState.status === 'running' ? 'pause' : 'resume';
        try {
            const data = await request(planUrl(), editing ? { action, steps: draft, ...(!planBot ? { name: planName.value.trim() } : {}) } : { action });
            if (version !== planVersion) return;
            planBot = data.bot;
            planState = data.plan;
            planChanged = true;
            planTitle.textContent = `Activity plan · ${planBot}`;
            editing = false;
            renderPlan();
            if (planState?.status === 'running') planWatch = setTimeout(() => void refreshPlan(version), 1500);
        } catch (error) {
            if (version === planVersion) planError.textContent = error.message;
        } finally {
            if (version === planVersion) planSave.disabled = planClose.disabled = false;
        }
    });

    installFleet();
})();
