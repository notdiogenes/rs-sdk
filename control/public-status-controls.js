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
    const bankPanel = document.querySelector('#bank-panel');
    const bankStatus = document.querySelector('#bank-status');
    const bankTitle = document.querySelector('#bank-title');
    const bankDetail = document.querySelector('#bank-item-detail');
    const bankBack = document.querySelector('#bank-back');
    let bankVersion = 0;
    const detailsDialog = document.querySelector('#fleet-details');
    const inventoryDialog = document.querySelector('#inventory-dialog');
    const inventoryStatus = document.querySelector('#inventory-status');
    const inventoryItems = document.querySelector('#inventory-items');
    const inventoryDetail = document.querySelector('#inventory-item-detail');
    const inventoryRefresh = document.querySelector('#inventory-refresh');
    const inventoryEat = document.querySelector('#inventory-eat');
    const inventoryDrop = document.querySelector('#inventory-drop');
    const inventoryActionStatus = document.querySelector('#inventory-action-status');
    let inventoryBot;
    let inventoryVersion = 0;
    let inventoryBySlot = new Map();
    let inventoryCanAct = false;
    let inventoryLoading = false;
    let inventoryPending = false;
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
            let hasSkills = false;
            for (const badge of badges.querySelectorAll('[data-card-skill]')) {
                const skill = badge.dataset.cardSkill;
                const level = stored?.skills?.levels[skill];
                badge.hidden = !Number.isFinite(level);
                if (badge.hidden) continue;
                const value = number(level);
                badge.querySelector('[data-skill-level]').textContent = value;
                badge.title = `${skill} ${value}`;
                hasSkills = true;
            }
            badges.hidden = !hasSkills;
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

    // The game bank_main:inv component uses 8 columns and 72 scrollable rows.
    const bankColumns = 8;
    const bankRows = 72;

    function showBankOverview() {
        bankVersion++;
        delete banksDialog.dataset.bankView;
        bankTitle.textContent = 'Bank snapshots';
        bankStatus.textContent = 'Balances are recorded when a bot opens its bank in-game.';
        bankDetail.hidden = true;
        bankBack.hidden = true;
        const visible = matchingRows();
        bankPanel.innerHTML = dataError
            ? `<p class="empty" role="status">${escape(dataError)}</p>` : visible.length
            ? table(['Account', 'Coins', 'Stacks', 'Last observed'], visible.map(row => {
                const bank = stats.get(row.name)?.bank;
                const name = escape(row.name);
                return [`<button type="button" class="bank-account" data-bank-account="${name}">${name}</button>`,
                    number(bank?.coins), number(bank?.stacks), escape(labelTime(bank?.at))];
            }), 'Last observed bank balances') : '<p class="empty">No bots match your filters.</p>';
    }

    function bankGrid(items) {
        const slots = bankColumns * bankRows;
        const bySlot = new Map(items.filter(({ slot }) => Number.isInteger(slot) && slot >= 0 && slot < slots)
            .map(item => [item.slot, item]));
        const rows = [...new Set(Array.from(bySlot.keys(), slot => Math.floor(slot / bankColumns)))].sort((a, b) => a - b);
        if (!rows.length) return '<p class="empty">This bank is empty.</p>';
        const cells = rows.flatMap(row => Array.from({ length: bankColumns }, (_, column) => {
            const slot = row * bankColumns + column;
            const item = bySlot.get(slot);
            if (!item) return '<li class="inventory-cell inventory-empty" aria-hidden="true"></li>';
            const description = escape(`Slot ${slot + 1} · ${item.name} · ${number(item.count)}`);
            return `<li class="inventory-cell"><button type="button" class="inventory-slot" data-bank-slot="${slot}"
                aria-label="${description}" title="${description}" aria-pressed="false" data-bank-description="${description}">
                <span class="inventory-fallback" aria-hidden="true">${escape(item.name)}</span>${itemSprite(item, true)}${itemQuantity(item)}</button></li>`;
        }));
        return `<div class="bank-scroll"><ol class="bank-grid" style="--bank-columns:${bankColumns}" role="list" aria-label="Bank slots">${cells.join('')}</ol></div>`;
    }

    async function showBank(name, fromOverview = false) {
        const version = ++bankVersion;
        banksDialog.dataset.bankView = 'account';
        bankTitle.textContent = 'Bank snapshot for ' + name;
        bankStatus.textContent = 'Reading bank snapshot…';
        bankDetail.hidden = true;
        bankBack.hidden = !fromOverview;
        bankPanel.replaceChildren();
        if (fromOverview) bankTitle.focus();
        try {
            const { bank = stats.get(name)?.bank } = await request('/bots/activity?view=bank&bot=' + encodeURIComponent(name));
            if (!banksDialog.open || version !== bankVersion) return;
            if (!bank) {
                bankStatus.textContent = 'Fleet Desk has not observed this bank open yet.';
                return;
            }
            bankStatus.textContent = `Last observed ${labelTime(bank.at)} · ${number(bank.stacks)} stacks · ${number(bank.coins)} coins`;
            if (!Array.isArray(bank.items)) {
                bankPanel.innerHTML = '<p class="empty">Item slots will appear after Fleet Desk next observes this bank open.</p>';
                return;
            }
            bankPanel.innerHTML = bankGrid(bank.items);
        } catch (error) {
            if (banksDialog.open && version === bankVersion) bankStatus.textContent = error.message;
        }
    }

    function openBanks(name) {
        clearTimeout(refresh);
        banksDialog.showModal();
        if (name) void showBank(name);
        else showBankOverview();
    }

    const backpackSlots = 28;

    function resetInventory() {
        inventoryBySlot.clear();
        inventoryCanAct = false;
        inventoryItems.replaceChildren();
        inventoryItems.hidden = true;
        inventoryDetail.hidden = true;
        updateInventoryActions();
    }

    function selectedInventoryItem() {
        const selected = inventoryItems.querySelector('[aria-pressed="true"]');
        return selected && inventoryBySlot.get(Number(selected.dataset.inventorySlot));
    }

    function updateInventoryActions() {
        const item = inventoryCanAct && selectedInventoryItem();
        inventoryEat.hidden = !item?.canEat;
        inventoryDrop.hidden = !item?.canDrop;
        inventoryEat.disabled = inventoryLoading || inventoryPending;
        inventoryDrop.disabled = inventoryLoading || inventoryPending;
        inventoryRefresh.disabled = inventoryLoading || inventoryPending;
    }

    function showInventoryAction(message, outcome = '') {
        inventoryActionStatus.textContent = message;
        inventoryActionStatus.dataset.outcome = outcome;
    }

    function selectInventoryItem(button) {
        inventoryItems.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-pressed', 'true');
        inventoryDetail.textContent = button.dataset.inventoryDescription;
        inventoryDetail.hidden = false;
        updateInventoryActions();
    }

    function inventoryQuantity(count) {
        if (count >= 1_000_000) return `${number(Math.floor(count / 1_000_000))}M`;
        if (count >= 100_000) return `${number(Math.floor(count / 1_000))}K`;
        return number(count);
    }

    function itemSprite(item, lazy = false) {
        const stack = Number.isInteger(item.count) && item.count > 1 && item.count <= 0x7fffffff;
        const url = stack ? item.spriteUrl?.replace(/(?:-\d+)?\.png$/, `-${item.count}.png`) : item.spriteUrl;
        return url ? `<img class="inventory-sprite" src="${escape(url)}" ${lazy ? 'loading="lazy"' : ''}
            width="32" height="32" alt="" decoding="async" referrerpolicy="no-referrer">` : '';
    }

    function itemQuantity(item) {
        return item.count > 1 ? `<span class="inventory-quantity" aria-hidden="true">${inventoryQuantity(item.count)}</span>` : '';
    }

    function showLoadedSprite(event) {
        const image = event.target;
        if (image.matches('.inventory-sprite') && image.naturalWidth > 0) image.parentElement.classList.add('has-sprite');
    }

    function renderInventory(items) {
        const previousSlot = inventoryItems.querySelector('[aria-pressed="true"]')?.dataset.inventorySlot;
        inventoryBySlot = new Map(items.filter(({ slot }) => Number.isInteger(slot) && slot >= 0 && slot < backpackSlots)
            .map(item => [item.slot, item]));
        inventoryItems.innerHTML = Array.from({ length: backpackSlots }, (_, slot) => {
            const item = inventoryBySlot.get(slot);
            if (!item) return '<li class="inventory-cell inventory-empty" aria-hidden="true"></li>';
            const description = escape(`Slot ${slot + 1} · ${item.name} · ${number(item.count)}`);
            return `<li class="inventory-cell"><button type="button" class="inventory-slot" data-inventory-slot="${slot}"
                aria-label="${description}" title="${description}" aria-pressed="false" data-inventory-description="${description}">
                <span class="inventory-fallback" aria-hidden="true">${escape(item.name)}</span>${itemSprite(item)}${itemQuantity(item)}</button></li>`;
        }).join('');
        inventoryItems.hidden = false;
        inventoryDetail.hidden = true;
        const buttons = [...inventoryItems.querySelectorAll('[data-inventory-slot]')];
        const selected = buttons.find(button => button.dataset.inventorySlot === previousSlot) ?? buttons[0];
        if (selected) selectInventoryItem(selected);
        else updateInventoryActions();
        return inventoryBySlot.size;
    }

    function showInventory(snapshot) {
        const used = renderInventory(snapshot.items);
        inventoryStatus.textContent = `${used}/${backpackSlots} slots used · Snapshot ${labelTime(snapshot.capturedAt)}`;
    }

    function inventoryPath() {
        return '/bots/activity?view=inventory&bot=' + encodeURIComponent(inventoryBot);
    }

    async function loadInventory() {
        const version = ++inventoryVersion;
        inventoryLoading = true;
        updateInventoryActions();
        inventoryStatus.textContent = 'Reading inventory…';
        inventoryItems.setAttribute('aria-busy', 'true');
        try {
            const snapshot = await request(inventoryPath());
            if (version !== inventoryVersion || !inventoryDialog.open) return;
            if (snapshot.availability !== 'live') {
                resetInventory();
                inventoryStatus.textContent = snapshot.availability === 'offline'
                    ? 'This bot is offline.' : 'The game has not published a fresh inventory.';
                return;
            }
            inventoryCanAct = snapshot.controls === true;
            showInventory(snapshot);
        } catch (error) {
            if (version === inventoryVersion && inventoryDialog.open) {
                resetInventory();
                inventoryStatus.textContent = error.message;
            }
        } finally {
            if (version === inventoryVersion) {
                inventoryLoading = false;
                updateInventoryActions();
                inventoryItems.removeAttribute('aria-busy');
            }
        }
    }

    async function runInventoryAction(action) {
        if (inventoryPending || inventoryLoading || !inventoryCanAct) return;
        const item = selectedInventoryItem();
        if (!item || (action === 'eat' ? !item.canEat : !item.canDrop)) return;
        if (action === 'drop' && !window.confirm(`Drop ${number(item.count)} × ${item.name} from slot ${item.slot + 1}?`)) return;
        const version = inventoryVersion;
        inventoryPending = true;
        updateInventoryActions();
        showInventoryAction(action === 'eat' ? 'Waiting for the game to confirm Eat…' : 'Waiting for the game to confirm Drop…');
        try {
            const { message, inventory } = await request(inventoryPath(), { action, slot: item.slot, id: item.id, count: item.count });
            if (version !== inventoryVersion || !inventoryDialog.open) return;
            showInventory(inventory);
            showInventoryAction(message, 'success');
        } catch (error) {
            if (version !== inventoryVersion || !inventoryDialog.open) return;
            showInventoryAction(error.message, 'error');
            await loadInventory();
        } finally {
            inventoryPending = false;
            updateInventoryActions();
            if (document.activeElement === document.body && inventoryDialog.open) {
                inventoryItems.querySelector('[aria-pressed="true"]')?.focus();
            }
        }
    }

    function openInventory(name) {
        inventoryBot = name;
        resetInventory();
        showInventoryAction('');
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
        inventoryRefresh.addEventListener('click', () => {
            showInventoryAction('');
            void loadInventory();
        });
        inventoryEat.addEventListener('click', () => void runInventoryAction('eat'));
        inventoryDrop.addEventListener('click', () => void runInventoryAction('drop'));
        inventoryDialog.addEventListener('close', () => { inventoryVersion++; });
        banksDialog.addEventListener('close', () => { bankVersion++; });
        bankBack.addEventListener('click', () => {
            showBankOverview();
            bankTitle.focus();
        });
        bankPanel.addEventListener('load', showLoadedSprite, true);
        bankPanel.addEventListener('click', event => {
            const account = event.target.closest('[data-bank-account]');
            if (account) {
                void showBank(account.dataset.bankAccount, true);
                return;
            }
            const slot = event.target.closest('[data-bank-slot]');
            if (!slot) return;
            bankPanel.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
            slot.setAttribute('aria-pressed', 'true');
            bankDetail.textContent = slot.dataset.bankDescription;
            bankDetail.hidden = false;
        });
        inventoryItems.addEventListener('load', showLoadedSprite, true);
        inventoryItems.addEventListener('click', event => {
            const button = event.target.closest('[data-inventory-slot]');
            if (button) selectInventoryItem(button);
        });
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
    const auditViewButtons = [...document.querySelectorAll('[data-audit-mode]')];
    const auditTitle = document.querySelector('#audit-title');
    const auditRunTools = document.querySelector('#audit-run-tools');
    const auditBack = document.querySelector('#audit-back');
    const auditCopy = document.querySelector('#audit-copy');
    const auditSummaryPhase = document.querySelector('#audit-summary-phase');
    const auditSummaryPhaseField = document.querySelector('#audit-summary-phase-field');
    const auditRevision = document.querySelector('#audit-revision');
    const auditRevisionField = document.querySelector('#audit-revision-field');
    const auditPhase = document.querySelector('#audit-phase');
    const auditBaseline = document.querySelector('#audit-baseline');
    const auditBaselineField = document.querySelector('#audit-baseline-field');
    const auditRevisions = document.querySelector('#audit-revisions');
    const auditKind = document.querySelector('#audit-kind');
    const auditClearEvent = document.querySelector('#audit-clear-event');
    const auditOperationBack = document.querySelector('#audit-operation-back');
    const auditEventClock = new Intl.DateTimeFormat('en-US', {
        timeZone: document.currentScript.dataset.timeZone, hour: 'numeric', minute: '2-digit', second: '2-digit',
    });
    const auditStatus = document.querySelector('#audit-status');
    const auditScroll = document.querySelector('#audit-scroll');
    const auditContent = document.querySelector('#audit-content');
    const auditOlder = document.querySelector('#audit-older');
    const auditLink = new URLSearchParams(location.search);
    let auditPending = auditLink.has('audit');
    let auditRun = '';
    let auditMode = 'insights';
    let auditEvent = '';
    let auditOperation = '';
    let auditShare = '';
    let auditAppliedScope;
    let auditCursor = null;
    let auditVersion = 0;
    let auditRows = [];

    const auditJson = value => `<details><summary>Raw evidence</summary><pre>${escape(JSON.stringify(value, null, 2))}</pre></details>`;
    const auditList = (title, rows, render) => rows?.length
        ? `<section><h3>${title}</h3><ul>${rows.map(render).join('')}</ul></section>` : '';
    const auditTime = at => auditEventClock.format(new Date(at));
    const auditName = value => value.replaceAll('-', ' ');
    const auditDuration = ms => {
        if (!Number.isFinite(ms)) return '—';
        if (ms > 0 && ms < 1000) return number(ms) + ' ms';
        return ms >= 3_600_000 ? `${num.format(Math.round(ms / 36_000) / 100)} h`
            : ms >= 60_000 ? `${num.format(Math.round(ms / 6_000) / 10)} min` : `${num.format(Math.round(ms / 100) / 10)} s`;
    };
    const auditPercent = value => Number.isFinite(value) ? `${num.format(Math.round(value * 1000) / 10)}%` : '—';
    const auditRevisionLabel = revision => revision
        ? `<code title="${escape(revision)}">${escape(revision.slice(0, 10))}</code>` : 'Unreported';
    const auditStatusLabel = status => `<span class="audit-status-badge" data-status="${escape(status)}">${escape(status)}</span>`;
    const auditTrace = (label, run, phase = '', event = '', kind = '') => run
        ? `<button type="button" class="audit-link" data-audit-run="${escape(run)}" data-audit-phase="${escape(phase ?? '')}"
            data-audit-event="${escape(event)}" data-audit-kind="${escape(kind)}">${escape(label)}</button>`
        : escape(label);

    const auditEventRow = ({ id, at, phase, kind, name, data }) => {
        const operation = data.operationId ?? data.parentOperationId;
        const feedback = Array.isArray(data.feedback) ? data.feedback : [];
        const visibility = data.targetAtResult ?? (typeof data.targetVisible === 'boolean'
            ? { visible: data.targetVisible, pickpocketVisible: data.optionVisible } : null);
        return `<li class="audit-row audit-event" data-event-id="${id}" tabindex="-1">
            <small class="audit-event-meta"><time datetime="${new Date(at).toISOString()}" title="${escape(labelTime(at))}">${escape(auditTime(at))}</time>
                <span>${escape(auditName(phase))}</span><span>${escape(auditName(kind))}</span></small>
            <div class="audit-event-title"><strong>${escape(auditName(name))}</strong>
                ${data.outcome ? auditStatusLabel(data.outcome) : ''}${Number.isFinite(data.elapsedMs) ? '<small>' + auditDuration(data.elapsedMs) + '</small>' : ''}
                ${operation ? (auditOperation ? '<small>Operation ' + number(operation) + '</small>'
                    : '<button type="button" class="audit-link" data-audit-operation="' + escape(operation) + '">Operation ' + number(operation) + '</button>') : ''}
            </div>
            ${data.message || data.sdk?.message ? '<p>' + escape(data.message || data.sdk.message) + '</p>' : ''}
            ${kind === 'intent' && data.intent ? '<p>' + escape(data.intent) + '</p>' : ''}
            ${visibility ? '<p>Target ' + (visibility.visible ? 'visible' : 'missing') +
                (visibility.visible && typeof visibility.pickpocketVisible === 'boolean'
                    ? ' · option ' + (visibility.pickpocketVisible ? 'visible' : 'missing') : '') + '</p>' : ''}
            ${feedback.map(item => '<p class="audit-feedback">' + escape(item.text) + '</p>').join('')}
            ${auditJson(data)}</li>`;
    };
    const auditRunRow = row => `<li class="audit-row audit-run-row">
        <div><button type="button" class="audit-link" data-audit-run="${escape(row.id)}"
            aria-label="Open ${escape(row.task)} run for ${escape(row.bot)} at ${escape(labelTime(row.started_at))}">${escape(auditName(row.task))}</button>
            ${auditStatusLabel(row.status)}</div>
        <small>${escape(row.bot)} · ${escape(labelTime(row.started_at))} · ${auditRevisionLabel(row.revision)}
            ${row.ended_at ? ' · ' + auditDuration(row.ended_at - row.started_at) : ''}</small>
        ${row.failure_message ? '<p>' + escape(row.failure_message) + '</p>' : ''}</li>`;

    const auditPanel = (title, body) => `<section class="insight-panel"><h3>${title}</h3>${body}</section>`;
    const auditBar = (label, value, amount, max, link = '', tone = '') => `<div class="insight-bar">
        <div class="insight-bar-heading">${link || '<span>' + escape(label) + '</span>'}<strong>${escape(value)}</strong></div>
        <progress class="${tone}" aria-label="${escape(label + ' ' + value)}" value="${amount}" max="${Math.max(1, max)}"></progress></div>`;
    const auditEmpty = message => `<p class="audit-empty">${escape(message)}</p>`;
    const auditMetric = (label, value, note) => `<div><dt>${label}</dt><dd>${value}</dd>${note ? '<p>' + note + '</p>' : ''}</div>`;
    const auditSamples = sample => Object.entries({
        running: sample.running, succeeded: sample.succeeded, failed: sample.failed, stopped: sample.stopped, interrupted: sample.interrupted,
    }).filter(([, count]) => count).map(([status, count]) => `${number(count)} ${status}`).join(' · ');
    const auditScopeLabel = r => [r.scope.bot || 'All bots', r.scope.task ? auditName(r.scope.task) : 'All tasks',
        r.scope.phase && auditName(r.scope.phase)].filter(Boolean).join(' · ');
    const auditPicksPerMinute = r => r.scope.task?.startsWith('pickpocket-') && !r.scope.phase && r.durationMs && r.pickpocket.count
        ? r.pickpocket.successes * 60_000 / r.durationMs : null;
    const auditRate = value => Number.isFinite(value) ? number(Math.round(value * 100) / 100) : '—';
    const auditSearchShare = r => r.durationMs && !r.scope.phase && r.scope.task?.startsWith('pickpocket-')
        ? (r.phases.find(p => p.phase === 'thieving-search')?.duration_ms ?? 0) / r.durationMs : null;
    function renderComparison(report, baseline) {
        const revisionTitle = r => auditRevisionLabel(r.scope.revision);
        const attempts = r => r.pickpocket.count ? number(r.pickpocket.successes) + ' / ' + number(r.pickpocket.count) : '—';
        const pickpocketTask = report.scope.task?.startsWith('pickpocket-');
        const timeoutRate = r => r.pickpocket.count ? (r.attempts.find(row => row.name === 'pickpocket-attempt-timeout')?.count ?? 0) / r.pickpocket.count : null;
        const rows = [
            ['Runs', r => number(r.sample.runs)],
            ['Recorded time', r => r.sample.runs ? auditDuration(r.durationMs) : '—'],
        ];
        if (pickpocketTask) rows.push(
            ['Time searching', r => auditPercent(auditSearchShare(r))],
            ['Successful pickpockets', attempts],
            ['Pickpocket success rate', r => auditPercent(r.pickpocket.successRate)],
            ['Successful pickpockets / min', r => auditRate(auditPicksPerMinute(r))],
            ['Pickpocket timeout rate', r => auditPercent(timeoutRate(r))],
        );
        if (Number.isFinite(report.throughput.xpPerHour) || Number.isFinite(baseline.throughput.xpPerHour)) {
            rows.push(['XP / hour', r => Number.isFinite(r.throughput.xpPerHour) ? number(Math.round(r.throughput.xpPerHour)) : '—']);
        }
        return auditPanel('Revision comparison', `<p class="insight-note">Same bot, task, phase and date window. Rates use recorded phase time.</p>
            ${!report.scope.task ? '<p class="insight-note">Choose a task to compare rates for the same activity.</p>' : ''}
            <div class="table-wrap" tabindex="0" aria-label="Revision comparison table">
            <table class="audit-comparison"><thead><tr><th scope="col">Metric</th>
                <th scope="col">Revision ${revisionTitle(report)}</th><th scope="col">Baseline ${revisionTitle(baseline)}</th></tr></thead>
            <tbody>${rows.map(([label, value]) => '<tr><th scope="row">' + label + '</th><td>' + value(report) +
                '</td><td>' + value(baseline) + '</td></tr>').join('')}</tbody></table></div>
            ${!report.sample.runs || !baseline.sample.runs ? auditEmpty('One revision has no matching runs in this scope.') : ''}`);
    }

    function renderInsights(report, baseline) {
        const { sample, durationMs, phases, attempts, pickpocket, throughput, trend, setbacks, failures } = report;
        const scope = escape(auditScopeLabel(report));
        const summary = sample.runs ? `<dl class="audit-metrics">
            ${auditMetric('Runs', number(sample.runs), auditSamples(sample))}
            ${auditMetric('Recorded time', auditDuration(durationMs), phases[0]?.share
                ? escape(auditName(phases[0].phase)) + ' · ' + auditPercent(phases[0].share) : '')}
            ${pickpocket.count ? auditMetric('Pickpocket success', auditPercent(pickpocket.successRate),
                number(pickpocket.successes) + ' / ' + number(pickpocket.count) + ' attempts') : ''}
            ${Number.isFinite(throughput.xpPerHour) ? auditMetric('XP / hour', number(Math.round(throughput.xpPerHour)), 'Across recorded phases') : ''}
            </dl>` : auditEmpty('No runs started in this window. Try a wider date range or clear a filter.');
        const outcomes = [...attempts].sort((a, b) => b.elapsed_ms - a.elapsed_ms || b.count - a.count);
        const totalOutcomes = attempts.reduce((total, row) => total + row.count, 0);
        const dailyMax = Math.max(0, ...trend.days.map(row => row.duration_ms));
        const daily = trend.days.map(row => auditBar(row.date, auditDuration(row.duration_ms), row.duration_ms, dailyMax) +
            `<p class="insight-note">${row.attempts ? number(row.successes) + '/' + number(row.attempts) + ' successful pickpockets · ' : ''}
                ${number(row.setbacks)} setbacks${row.xpPerHour === null ? '' : ' · ' + number(Math.round(row.xpPerHour)) + ' XP/h'}</p>`).join('');
        return `<p class="audit-scope">${scope}${report.scope.revision ? ' · ' + auditRevisionLabel(report.scope.revision) : ''}</p>
            ${baseline ? renderComparison(report, baseline) : ''}${summary}
            <div class="insight-grid">
            ${auditPanel('Time by phase', phases.filter(phase => phase.duration_ms > 0).map(phase =>
                auditBar(auditName(phase.phase), `${auditDuration(phase.duration_ms)} · ${auditPercent(phase.share)}`, phase.duration_ms,
                    durationMs, auditTrace(auditName(phase.phase), phase.run_id, phase.phase))).join('') || '<p>No phase time recorded.</p>')}
            ${auditPanel('Recorded outcomes', outcomes.length ? `<p class="insight-note">Sorted by time spent. Select an outcome to see a retained example.</p>
                <ul>${outcomes.map(row => `<li class="audit-row insight-outcome">
                <div>${auditTrace(auditName(row.name), row.trace_run_id, report.scope.phase, row.name)}
                    ${row.trace_run_id === null ? '<small class="trace-unavailable">Detail expired</small>' : ''}</div>
                <span>${number(row.count)} · ${auditPercent(row.count / totalOutcomes)}</span><strong>${auditDuration(row.elapsed_ms)}</strong>
                </li>`).join('')}</ul>` : '<p>No instrumented attempt outcomes.</p>')}
            ${auditPanel('Setbacks', setbacks.map(row => `<p class="audit-row">${auditTrace(auditName(row.name), row.trace_run_id, row.phase, row.name, 'setback')}
                · ${number(row.count)} across ${number(row.runs)} ${row.runs === 1 ? 'run' : 'runs'} · ${escape(row.task)}
                ${row.trace_run_id === null ? '<small class="trace-unavailable">Detail expired</small>' : ''}
                <br><small>${number(row.successful_runs)} in successful runs · ${number(row.before_later_failure)} before a terminal failure</small></p>`).join('')
                || '<p>No recorded setbacks.</p>')}
            ${auditPanel('Terminal failures', failures.map(row => `<p class="audit-row">${auditTrace(row.step || 'Open failed run', row.run_id, row.phase, '', 'failure')}
                · ${number(row.count)} runs · ${number(row.bots)} bots · ${escape(row.task)}${row.message ? '<br><small>' + escape(row.message) + '</small>' : ''}</p>`).join('')
                || '<p>No recorded terminal failures.</p>')}
            </div>
            ${auditPanel('Daily activity · US Eastern', `<p class="insight-note">Trend coverage starts ${escape(labelTime(trend.coverageStart))}. The current day can be partial.</p>
                ${daily || '<p>No trend data in this window yet.</p>'}`)}`;
    }

    function renderAuditRun(report, rows) {
        const { run, phases, signals, failureEvidence } = report;
        const totalTime = phases.reduce((total, phase) => total + phase.duration_ms, 0);
        const title = auditOperation ? 'Operation ' + number(Number(auditOperation)) : auditEvent ? auditName(auditEvent) : 'Timeline';
        const phaseLinks = phases.map(phase => `<li class="audit-row"><button type="button" class="audit-link"
            data-run-phase="${escape(phase.phase)}">${escape(auditName(phase.phase))}</button>
            · ${auditDuration(phase.duration_ms)} · ${number(phase.actions)} actions · ${number(phase.setbacks)} setbacks</li>`).join('');
        const signalRows = signals.map(signal => `<li class="audit-row"><button type="button" class="audit-link"
            data-run-event="${escape(signal.name)}" data-run-phase="${escape(signal.phase)}" data-run-kind="${escape(signal.kind)}">${escape(auditName(signal.name))}</button>
            · ${number(signal.count)}${Number.isFinite(signal.elapsed_ms) ? ' · ' + auditDuration(signal.elapsed_ms) : ''}
            ${signal.evidence ? auditJson(signal.evidence) : ''}</li>`).join('');
        return `<div class="audit-run-meta">${auditStatusLabel(run.status)} <span>${escape(labelTime(run.started_at))}</span>
            <span>Revision ${auditRevisionLabel(run.revision)}</span><span>${auditDuration(totalTime)} recorded</span></div>
            ${run.failure_message ? '<p class="audit-failure">' + escape([run.failure_phase, run.failure_step, run.failure_message].filter(Boolean).join(' · ')) + '</p>' : ''}
            ${failureEvidence.length ? `<details class="audit-run-summary" ${run.status === 'failed' && !rows.length ? 'open' : ''}>
                <summary>Retained failure evidence (${number(failureEvidence.length)})</summary><ul>${failureEvidence.map(auditEventRow).join('')}</ul></details>` : ''}
            ${phases.length || signals.length ? `<details class="audit-run-summary"><summary>Phase totals and recorded outcomes</summary>
                <div class="insight-grid">${phases.length ? auditPanel('Phase totals', '<ul>' + phaseLinks + '</ul>') : ''}
                ${signals.length ? auditPanel('Recorded outcomes', '<ul>' + signalRows + '</ul>') : ''}</div></details>` : ''}
            <section><h3 id="audit-timeline-title">${escape(title)}</h3>
            ${auditOperation ? '<p class="insight-note">Events linked by operation ID, shown in sequence.</p>' : ''}
            ${rows.length ? '<ul class="audit-timeline">' + rows.map(auditEventRow).join('') + '</ul>'
                : auditEmpty(run.details_available < run.detail_count
                    ? 'No matching events remain in the retained timeline. Run totals and saved failure evidence are still available when recorded.'
                    : 'No retained events match this view. Change the event type or phase to see more.')}</section>`;
    }

    function auditScopeParams() {
        const params = new URLSearchParams({ mode: auditMode, days: auditDays.value || '35' });
        if (auditBot.value.trim()) params.set('bot', auditBot.value.trim());
        if (auditTask.value.trim()) params.set('task', auditTask.value.trim());
        if (auditMode !== 'runs' && auditSummaryPhase.value.trim()) params.set('phase', auditSummaryPhase.value.trim());
        if (auditMode === 'insights' && auditRevision.value.trim()) params.set('revision', auditRevision.value.trim());
        if (auditMode === 'insights' && auditBaseline.value.trim()) params.set('baseline', auditBaseline.value.trim());
        return params;
    }

    function updateAuditLink(scope, more) {
        const params = new URLSearchParams({ audit: '1', ...Object.fromEntries(scope), ...more });
        auditShare = '/bots?' + params;
        history.replaceState(null, '', auditShare);
        auditCopy.disabled = false;
        auditCopy.textContent = 'Copy link';
    }

    async function loadAudit(older = false, firstBefore, firstLimit) {
        const version = ++auditVersion;
        const scope = (auditRun || older) && auditAppliedScope ? auditAppliedScope : auditScopeParams();
        const baseline = scope.get('baseline');
        const params = new URLSearchParams({ view: 'audit', format: 'json', limit: firstLimit || '50' });
        const more = {};
        if (auditRun) {
            const phase = auditPhase.value;
            params.set('run', auditRun);
            more.run = auditRun;
            more.runPhase = phase;
            if (phase) params.set('phase', phase);
            if (auditEvent) params.set('event', more.event = auditEvent);
            if (auditKind.value) params.set('kind', auditKind.value);
            more.kind = auditKind.value || 'all';
            if (auditOperation) params.set('operation', more.operation = auditOperation);
            if (scope.get('bot')) params.set('bot', scope.get('bot'));
        } else {
            for (const [key, value] of scope) params.set(key, value);
        }
        if (older && auditCursor) params.set('before', auditCursor);
        if (firstBefore) params.set('before', more.before = firstBefore);
        if (firstLimit) more.limit = firstLimit;
        const view = auditRun ? 'run details' : scope.get('mode');
        auditStatus.textContent = older ? 'Loading older entries…' : `Loading ${view}…`;
        if (!older) auditCopy.disabled = true;
        auditOlder.disabled = true;
        auditContent.inert = !older;
        auditContent.setAttribute('aria-busy', 'true');
        try {
            const compare = !auditRun && scope.get('mode') === 'insights' && baseline;
            const revision = scope.get('revision')?.toLowerCase();
            if (compare && (!revision || revision.startsWith(baseline.toLowerCase()) || baseline.toLowerCase().startsWith(revision))) {
                throw new Error('Choose two distinct revisions to compare.');
            }
            const report = await request('/bots/activity?' + params);
            if (!auditDialog.open || auditVersion !== version) return;
            auditAppliedScope = scope;
            auditCursor = report.nextBefore;
            auditOlder.hidden = !auditCursor;
            auditOlder.textContent = auditRun ? 'Load older events' : 'Load older runs';
            if (auditRun) {
                const { run } = report;
                const currentPhase = auditPhase.value;
                auditPhase.replaceChildren(new Option('All phases', ''),
                    ...report.phases.map(phase => new Option(auditName(phase.phase), phase.phase)));
                if (currentPhase && !report.phases.some(phase => phase.phase === currentPhase)) {
                    auditPhase.add(new Option(auditName(currentPhase), currentPhase));
                }
                auditPhase.value = currentPhase;
                auditTitle.textContent = run.bot + ' · ' + auditName(run.task);
                const events = report.events.slice().reverse();
                auditRows = older ? [...auditRows, ...events] : events;
                auditStatus.textContent = `${number(auditRows.length)} of ${number(report.matchingEvents)} matching events shown · ${number(run.details_available)} retained`;
                auditContent.innerHTML = renderAuditRun(report, auditOperation ? auditRows.slice().reverse() : auditRows);
                if (older && events.length) auditContent.querySelector(`.audit-timeline [data-event-id="${events[0].id}"]`)?.focus();
            } else if (scope.get('mode') === 'insights') {
                auditStatus.textContent = report.sample.runs ? auditSamples(report.sample) : 'No runs match these filters.';
                auditRevisions.replaceChildren(...report.revisions.map(row => new Option(`${row.revision.slice(0, 10)} · ${row.runs} runs`, row.revision)));
                auditContent.innerHTML = renderInsights(report, report.baseline);
            } else if (scope.get('mode') === 'summary') {
                auditStatus.textContent = report.breakpoints.length || report.totals.length || report.signals.length
                    ? `Runs started within the last ${scope.get('days')} days` : 'No audit activity matches these filters.';
                auditContent.innerHTML = auditList('Recurring failures', report.breakpoints, point => `<li class="audit-row">
                    <strong>${escape(point.task)}</strong> · ${escape([point.phase, point.step, point.site].filter(Boolean).join(' · '))}
                    <p>${number(point.runs)} runs · ${number(point.bots)} bots · ${escape(point.example_message ?? '')}</p>
                    <small>Revision ${auditRevisionLabel(point.revision)}</small></li>`) +
                auditList('Phase totals', report.totals, phase => `<li class="audit-row">${escape([phase.task, phase.phase, phase.run_outcome].join(' · '))}
                    <p>${number(phase.runs)} runs · ${auditDuration(phase.duration_ms)} · ${number(phase.actions)} actions · ${number(phase.setbacks)} setbacks</p></li>`) +
                auditList('Milestones and setbacks', report.signals, signal => `<li class="audit-row">${escape([signal.task, signal.phase, signal.name].join(' · '))}
                    <p>${number(signal.count)} occurrences · ${number(signal.before_later_failure)} before a later failure</p>
                    <small>Revision ${auditRevisionLabel(signal.revision)}</small>${auditJson(signal)}</li>`);
            } else {
                auditRows = older ? [...auditRows, ...report.runs] : report.runs;
                auditStatus.textContent = auditRows.length ? `${number(auditRows.length)} runs shown` : 'No runs match these filters.';
                auditContent.innerHTML = auditList('Runs', auditRows, auditRunRow);
            }
            if (!older) {
                auditScroll.scrollTop = 0;
                updateAuditLink(scope, more);
            }
        } catch (error) {
            if (auditVersion === version) {
                auditStatus.textContent = error.message;
                if (!older) {
                    auditOlder.hidden = true;
                    auditContent.innerHTML = auditEmpty('The requested audit view could not be loaded.');
                    auditScroll.scrollTop = 0;
                }
            }
        } finally {
            if (auditVersion === version) {
                auditOlder.disabled = false;
                auditContent.inert = false;
                auditContent.removeAttribute('aria-busy');
            }
        }
    }

    function updateAuditRunTools() {
        auditOperationBack.hidden = !auditOperation;
        auditPhase.disabled = auditKind.disabled = Boolean(auditOperation);
        auditClearEvent.hidden = !auditEvent || Boolean(auditOperation);
    }

    function showAuditRun({ run = '', phase = '', event = '', kind, operation = '', before, limit } = {}) {
        auditRun = run;
        auditEvent = event;
        auditOperation = operation;
        auditKind.value = kind === 'all' ? '' : kind ?? (event ? '' : 'key');
        auditPhase.replaceChildren(new Option('All phases', ''), ...(phase ? [new Option(auditName(phase), phase)] : []));
        auditPhase.value = phase;
        auditRows = [];
        auditCursor = null;
        auditForm.hidden = Boolean(run);
        auditRunTools.hidden = !run;
        auditBack.textContent = 'Back to ' + ({ insights: 'Insights', summary: 'Summary', runs: 'runs' })[auditMode];
        updateAuditRunTools();
        auditTitle.textContent = run ? 'Audit run' : 'Activity audit';
        void loadAudit(false, before, limit);
    }

    function openAudit(params) {
        clearTimeout(refresh);
        auditPending = false;
        auditAppliedScope = undefined;
        auditBot.value = params.get('bot') || '';
        auditTask.value = params.get('task') || '';
        auditDays.value = params.get('days') || '35';
        auditMode = ['summary', 'runs'].includes(params.get('mode')) ? params.get('mode') : 'insights';
        auditSummaryPhase.value = !params.has('run') || params.has('runPhase') ? params.get('phase') || '' : '';
        auditRevision.value = params.get('revision') || '';
        auditBaseline.value = params.get('baseline') || '';
        showAuditFilters();
        if (!auditDialog.open) auditDialog.showModal();
        showAuditRun({ run: params.get('run') || '', phase: params.get('runPhase') ?? params.get('phase') ?? '',
            event: params.get('event') || '', kind: params.get('kind') ?? undefined, operation: params.get('operation') || '',
            before: params.get('before'), limit: params.get('limit') });
    }

    auditForm.addEventListener('submit', event => { event.preventDefault(); showAuditRun(); });
    function showAuditFilters() {
        auditSummaryPhaseField.hidden = auditSummaryPhase.disabled = auditMode === 'runs';
        auditRevision.disabled = auditRevisionField.hidden = auditMode !== 'insights';
        auditBaseline.disabled = auditBaselineField.hidden = auditMode !== 'insights';
        for (const button of auditViewButtons) button.setAttribute('aria-pressed', String(button.dataset.auditMode === auditMode));
    }
    for (const button of auditViewButtons) button.addEventListener('click', () => {
        auditMode = button.dataset.auditMode;
        showAuditFilters();
        if (auditForm.reportValidity()) showAuditRun();
    });
    auditContent.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button) return;
        const data = button.dataset;
        if (data.auditRun) {
            showAuditRun({ run: data.auditRun, phase: data.auditPhase, event: data.auditEvent, kind: data.auditKind || undefined });
            auditBack.focus();
        } else if (data.auditOperation) {
            auditOperation = data.auditOperation;
            updateAuditRunTools();
            void loadAudit();
            auditOperationBack.focus();
        } else if (data.runPhase) {
            auditOperation = '';
            auditPhase.value = data.runPhase;
            auditEvent = data.runEvent || '';
            auditKind.value = data.runKind ?? 'key';
            updateAuditRunTools();
            void loadAudit();
            auditPhase.focus();
        }
    });
    auditCopy.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(new URL(auditShare, location.origin).href);
            auditCopy.textContent = 'Link copied';
        } catch { auditCopy.textContent = 'Copy from address bar'; }
    });
    auditDialog.querySelector('[data-close]').addEventListener('click', () => auditDialog.close());
    auditDialog.addEventListener('close', () => {
        auditVersion++;
        auditContent.replaceChildren();
        auditOlder.hidden = true;
        if (new URLSearchParams(location.search).has('audit')) history.replaceState(null, '', '/bots');
        scheduleRefresh();
    });
    auditOlder.addEventListener('click', () => loadAudit(true));
    auditPhase.addEventListener('change', () => loadAudit());
    auditKind.addEventListener('change', () => loadAudit());
    auditOperationBack.addEventListener('click', () => {
        auditOperation = '';
        updateAuditRunTools();
        void loadAudit();
        auditKind.focus();
    });
    auditClearEvent.addEventListener('click', () => {
        auditEvent = '';
        updateAuditRunTools();
        void loadAudit();
        auditKind.focus();
    });
    document.querySelector('#audit-refresh').addEventListener('click', () => loadAudit());
    auditBack.addEventListener('click', () => {
        if (auditAppliedScope) {
            auditBot.value = auditAppliedScope.get('bot') || '';
            auditTask.value = auditAppliedScope.get('task') || '';
            auditDays.value = auditAppliedScope.get('days') || '35';
            auditSummaryPhase.value = auditAppliedScope.get('phase') || '';
            auditRevision.value = auditAppliedScope.get('revision') || '';
            auditBaseline.value = auditAppliedScope.get('baseline') || '';
        }
        showAuditRun();
        auditViewButtons.find(button => button.dataset.auditMode === auditMode)?.focus();
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
            const label = button.getAttribute('aria-label') || button.textContent;
            title.textContent = label + ' for ' + button.dataset.bot;
            submit.textContent = label;
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
