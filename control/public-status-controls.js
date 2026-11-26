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
    const diagnosticsButton = document.querySelector('#dashboard-diagnostics-open');
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
    const tasks = form.querySelector('select');
    const taskField = form.querySelector('#activity-task');
    const title = form.querySelector('h2');
    const message = form.querySelector('[role="status"]');
    const submit = form.querySelector('button[type="submit"]');
    const close = form.querySelector('#activity-close');
    let refresh;
    let selected;
    let action;
    let dialogVersion = 0;
    let signedIn = false;
    let configured = true;
    let pendingButton;
    let setupCode = /^#setup=([a-f0-9]{64})$/.exec(window.location.hash)?.[1];
    if (setupCode) history.replaceState(null, '', window.location.pathname + window.location.search);

    const { rows: roster, skills, questCatalog } = JSON.parse(document.querySelector('#fleet-roster').textContent);
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const search = document.querySelector('#search');
    const statusFilter = document.querySelector('#status-filter');
    const kindFilter = document.querySelector('#kind-filter');
    const filterFields = [search, statusFilter, kindFilter];
    const auto = document.querySelector('#auto');
    const banks = document.querySelector('#banks');
    const banksDialog = document.querySelector('#banks-dialog');
    const detailsDialog = document.querySelector('#fleet-details');
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

    function matches(name, status, kind) {
        return (statusFilter.value === 'all' || statusFilter.value === status) &&
            (kindFilter.value === 'all' || kindFilter.value === kind) &&
            name.toLowerCase().includes(search.value.trim().toLowerCase());
    }

    function matchingRows() {
        return roster.filter(({ name, category, kind }) => matches(name, category, kind));
    }

    function updateCards() {
        for (const card of cards) {
            const { name, status, kind } = card.dataset;
            card.hidden = !matches(name, status, kind);
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

    function renderQuestGrid(visible) {
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
            const marks = statuses.map(status => {
                const mark = questMarks[status];
                return `<td class="quest-mark ${status}" title="${mark.label}"><span class="visually-hidden">${mark.label}</span>
                    <span aria-hidden="true">${mark.symbol}</span></td>`;
            });
            return `<tr><th scope="row" class="quest-account">
                <button type="button" class="button" data-detail="${escape(name)}">${escape(name)}</button>
                <small title="${escape(labelTime(journal?.at))}">${summary}</small></th>
                <td class="quest-points"><a href="${escape(hiscore)}" target="_blank" rel="noopener"
                    title="Hiscores checked ${escape(labelTime(score?.checkedAt))}">${points}</a></td>${marks.join('')}</tr>`;
        });
        const legend = Object.entries(questMarks).map(([status, { symbol, label }]) =>
            `<span><b class="quest-mark ${status}" aria-hidden="true">${symbol}</b> ${label}</span>`);
        return `<div class="table-wrap quest-scroll" tabindex="0" role="region" aria-label="Scrollable quest grid">
          <table class="quest-grid">
            <thead><tr><th scope="col" class="quest-account">Account</th>
            <th scope="col" class="quest-points" title="Quest points from hiscores">QP</th>${headers.join('')}</tr></thead>
            <tbody>${rows.join('')}</tbody>
          </table>
        </div><p class="quest-legend">${legend.join('')}</p>`;
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
            panel.innerHTML = renderQuestGrid(visible);
            return;
        }
        const detail = ({ name, kind }) =>
            `<button type="button" class="button" data-detail="${escape(name)}">${escape(name)}</button><br><small>${kind}</small>`;
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
        if (saved?.filters?.length === filterFields.length) {
            filterFields.forEach((field, index) => { field.value = saved.filters[index]; });
        }
        if (saved?.auto === 'false') auto.setAttribute('aria-pressed', 'false');
        if (Number.isInteger(saved?.sort?.key) && saved.sort.key >= 0 && saved.sort.key < skills.length + 5) sort = saved.sort;
        selectTab(tabs.find(tab => tab.getAttribute('aria-controls') === saved?.view) || tabs[0]);
        document.querySelector('#refresh').addEventListener('click', () => window.location.reload());
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
        for (const modal of [banksDialog, detailsDialog]) {
            modal.querySelector('[data-close]').addEventListener('click', () => modal.close());
            modal.addEventListener('close', scheduleRefresh);
        }
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
            if (button !== banks && !button.matches('[data-bank], [data-detail], [data-unlock]')) return;
            await sessionReady;
            if (!signedIn) {
                openSignIn(button.hasAttribute('data-unlock') ? undefined : button);
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
        signInMessage.textContent = needsLink ? 'Open your one-time dashboard setup link.' : '';
        signIn.showModal();
    }

    const sessionReady = request('/bots/activity?session=status')
        .then(state => {
            configured = state.configured;
            setSignedIn(state.signedIn);
            if (!configured && setupCode && !signIn.open) openSignIn();
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
            if (button) button.click();
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
            action = button.dataset.action;
            title.textContent = button.textContent + ' for ' + button.dataset.bot;
            submit.textContent = action === 'start' ? 'Load activities' : 'Stop activity';
            submit.disabled = false;
            taskField.hidden = true;
            message.textContent = '';
            dialog.showModal();
            if (action === 'start') form.requestSubmit();
        });
    }
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', event => {
        if (close.disabled) event.preventDefault();
    });
    dialog.addEventListener('close', () => {
        dialogVersion++;
        form.reset();
        tasks.replaceChildren();
        if (!signIn.open && !dialog.open) scheduleRefresh();
    });

    async function request(path, payload) {
        const headers = {};
        const options = {
            headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
            signal: AbortSignal.timeout(payload?.action === 'stop' ? 38000 : 15000),
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
        diagnosticsRefresh.disabled = true;
        diagnosticsStatus.textContent = 'Loading diagnostics…';
        try {
            const { reading, history } = await request('/bots/activity?view=diagnostics');
            if (!diagnosticsDialog.open) return;
            const controller = reading?.controller;
            const game = reading?.game;
            const player = game?.player;
            const exit = controller?.lastTask;
            const rows = [
                ['Bot', controller?.bot ?? '—'],
                ['Controller', controller ? 'Responding' : 'Unavailable'],
                ['Managed client', controller?.client ? (controller.client.stopping ? 'Stopping' : 'Running since ' + labelTime(controller.client.startedAt)) : controller ? 'Stopped' : 'Unknown'],
                ['Activity', controller?.task?.name ?? (controller?.starting ? 'Starting ' + controller.starting : controller ? 'Idle' : 'Unknown')],
                ['Activity started', labelTime(controller?.task?.startedAt)],
                ['Last task exit', exit ? exit.name + ' · code ' + exit.exitCode + ' · ' + labelTime(exit.finishedAt) : '—'],
                ['Last start error', controller?.startError ?? '—'],
                ['Game state', game ? game.availability + (game.stateAgeMs == null ? '' : ' · ' + game.stateAgeMs + ' ms old at sample') : '—'],
                ['Game tick', game?.tick ?? '—'],
                ['Position', player ? 'X ' + player.x + ', Z ' + player.z : '—'],
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
            if (!diagnosticsDialog.open) return;
            if (error.status === 401) {
                setSignedIn(false);
                diagnosticsDialog.close();
                openSignIn(diagnosticsButton);
            } else {
                diagnosticsStatus.textContent = error.message;
            }
        } finally {
            diagnosticsRefresh.disabled = false;
        }
    }

    diagnosticsButton.addEventListener('click', async () => {
        await sessionReady;
        if (!signedIn) {
            openSignIn(diagnosticsButton);
            return;
        }
        clearTimeout(refresh);
        diagnosticsDialog.showModal();
        void loadDiagnostics();
    });
    diagnosticsDialog.querySelector('#diagnostics-close').addEventListener('click', () => diagnosticsDialog.close());
    diagnosticsRefresh.addEventListener('click', loadDiagnostics);
    diagnosticsDialog.addEventListener('close', () => {
        diagnosticsCurrent.replaceChildren();
        diagnosticsEvents.replaceChildren();
        if (!signIn.open) scheduleRefresh();
    });

    function updateRow(state) {
        if (state.bot !== selected.dataset.bot) return;
        const running = state.task || state.starting;
        selected.dataset.action = running ? 'stop' : 'start';
        selected.textContent = running ? 'Stop activity' : 'Start activity';
        const activity = state.task?.name?.replaceAll('-', ' ');
        selected.closest('[data-bot-row]').querySelector('[data-activity]').textContent =
            activity ? (state.task.stopping ? 'Stopping ' + activity : activity)
                : state.starting ? 'Starting ' + state.starting.replaceAll('-', ' ')
                    : state.startError ? 'Activity could not start' : '—';
    }

    async function watchStart(version, bot) {
        try {
            while (dialog.open && dialogVersion === version) {
                const state = await request('/bots/activity');
                if (dialogVersion !== version) return;
                if (state.bot !== bot) throw new Error('The configured bot changed.');
                updateRow(state);
                if (!state.starting) {
                    message.textContent = state.startError || (state.task ? 'Activity started.' : 'The activity is no longer running.');
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 1600));
            }
        } catch (error) {
            if (dialogVersion === version) message.textContent = error.message;
        }
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (submit.disabled) return;
        submit.disabled = true;
        close.disabled = true;
        message.textContent = 'Checking controller status…';
        let completed = false;
        let watching = false;
        try {
            const state = await request('/bots/activity');
            if (state.bot !== selected.dataset.bot) {
                throw new Error('The configured bot changed. Close this dialog and refresh the dashboard.');
            }
            if (action === 'stop') {
                if (state.task || state.starting) {
                    message.textContent = 'Stopping activity…';
                    await request('/bots/activity', { bot: state.bot, action: 'stop' });
                }
                message.textContent = state.task || state.starting ? 'Activity stopped.' : 'There is no activity to stop.';
                updateRow({ ...state, task: null, starting: null, startError: null });
            } else {
                if (state.task || state.starting) {
                    updateRow(state);
                    completed = true;
                    message.textContent = 'An activity is already running.';
                    return;
                }
                const names = Array.isArray(state.tasks)
                    ? state.tasks.filter(name => typeof name === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(name))
                    : [];
                if (names.length === 0) throw new Error('No activities are configured for this bot.');
                if (taskField.hidden || !names.includes(tasks.value)) {
                    tasks.replaceChildren(...names.map(name => new Option(name.replaceAll('-', ' '), name)));
                    taskField.hidden = false;
                    submit.textContent = 'Start activity';
                    message.textContent = 'Choose an activity, then select Start activity.';
                    tasks.focus();
                    return;
                }
                const task = tasks.value;
                await request('/bots/activity', { bot: state.bot, action: 'start', task });
                message.textContent = state.client ? 'Starting activity…' : 'Starting the game client and activity…';
                updateRow({ ...state, starting: task, startError: null });
                watching = true;
                void watchStart(dialogVersion, state.bot);
                return;
            }
            completed = true;
        } catch (error) {
            if (error.status === 401) {
                setSignedIn(false);
                dialog.close();
                openSignIn(selected);
                return;
            }
            message.textContent = error.message;
        } finally {
            submit.disabled = completed || watching;
            close.disabled = false;
        }
    });
    installFleet();
})();
