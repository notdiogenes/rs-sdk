import { fleetSkills } from './dashboard-fleet-stats';
import { fleetActionIcon, fleetSkillIcon, type FleetActionIcon } from './dashboard-fleet-icons';
import { questHiscore, type QuestColumn } from './dashboard-quests';
import { activity, activityIds } from './dashboard-task-catalog';
import type { Bot, ControlActivity, Snapshot } from './public-status';
import type { LastActivity } from './dashboard-last-activity';

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const groups = { attention: 'Needs attention', active: 'Running', idle: 'Idle', offline: 'Offline' } as const;
// Row order from the game's stats tab. Runecraft shares the last row with the total.
const skillTabOrder = [
    'Attack', 'Hitpoints', 'Mining',
    'Strength', 'Agility', 'Smithing',
    'Defence', 'Herblore', 'Fishing',
    'Ranged', 'Thieving', 'Cooking',
    'Prayer', 'Crafting', 'Firemaking',
    'Magic', 'Fletching', 'Woodcutting',
    'Runecraft',
] satisfies (typeof fleetSkills[number][0])[];
type Group = keyof typeof groups;
const displayTimeZone = 'America/New_York';
const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: displayTimeZone, hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
});
const activityClock = new Intl.DateTimeFormat('en-US', {
    timeZone: displayTimeZone, month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

function classify(bot: Bot, managed: ControlActivity | undefined, now: number): { category: Group; reason: string } {
    if (managed?.failed) return { category: 'attention', reason: bot.activity };
    if (bot.status === 'Unknown') return { category: 'attention', reason: 'Game state is unavailable' };
    if (managed?.transitioning) return { category: 'idle', reason: bot.activity };
    if (bot.status === 'Offline') return managed?.running
        ? { category: 'attention', reason: 'Activity running while the bot is offline' }
        : { category: 'offline', reason: 'Logged out' };
    if (managed?.waiting) return { category: 'idle', reason: managed.waiting };
    const lastEffect = bot.lastActivity ? Date.parse(bot.lastActivity.at) : 0;
    if (bot.inCombat || now - lastEffect < 2 * 60_000) {
        return { category: 'active', reason: bot.inCombat ? 'In combat' : 'Recent game activity' };
    }
    if (!managed?.running) return { category: 'idle', reason: 'No recent activity' };
    const startedAt = managed.startedAt ? Date.parse(managed.startedAt) : now;
    if (now - Math.max(startedAt, lastEffect) > 5 * 60_000) {
        return { category: 'attention', reason: 'No game activity observed in 5 minutes' };
    }
    return { category: 'idle', reason: 'Waiting for game activity' };
}

function timeAgo(now: number, value?: number) {
    if (value === undefined || !Number.isFinite(value)) return '—';
    const seconds = Math.max(0, Math.floor((now - value) / 1000));
    if (seconds < 5) return 'Now';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function elapsedTime(now: number, startedAt?: string) {
    const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt ?? '')) / 1000));
    if (!Number.isFinite(seconds)) return '—';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        const remaining = minutes % 60;
        return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    const remaining = hours % 24;
    return remaining ? `${days}d ${remaining}h` : `${days}d`;
}

function fact(label: string, value: string, className = '') {
    return `<div><dt>${label}</dt><dd class="${className}">${escape(value)}</dd></div>`;
}

function cardAction(label: string, icon: FleetActionIcon, attributes: string) {
    return `<button type="button" class="card-action" ${attributes} aria-label="${escape(label)}" title="${escape(label)}">${fleetActionIcon(icon)}</button>`;
}

function card(bot: Bot, category: Group, reason: string, managed: ControlActivity | undefined, now: number,
    reportedActivity?: LastActivity) {
    const name = escape(bot.name);
    const last = reportedActivity ?? bot.lastActivity;
    const timestamp = last ? `<time datetime="${escape(last.at)}">${activityClock.format(new Date(last.at))}</time>` : '';
    const activityDetail = last?.reason.split(' · ').map(signal => {
        if (signal !== 'Moved') return signal;
        return bot.location ? `Moved to ${bot.location}` : 'Position changed';
    }).join(' · ') ?? 'No activity observed';
    const watch = bot.status === 'Online'
        ? `<a class="card-action" href="https://maxbittker.github.io/rs-world/?follow=${encodeURIComponent(bot.name)}" target="_blank" rel="noopener"
            aria-label="Watch live" title="Watch live in a new tab">${fleetActionIcon('watch')}</a>` : '';
    const pausePlan = bot.plan?.status === 'running';
    const activityButton = managed?.running
        ? cardAction(pausePlan ? 'Pause plan' : 'Stop activity', pausePlan ? 'pause' : 'stop', `data-bot="${name}" data-action="stop"`) : '';
    const planButton = cardAction(bot.plan ? 'View plan' : 'Plan activities', 'plan', `data-plan-bot="${name}"`);
    const showReason = reason !== bot.activity && (category === 'attention' || managed?.waiting === reason);
    return `<article class="bot" data-bot-row data-name="${name}" data-status="${category}">
    <div class="bot-header">
      <div class="bot-identity"><h3>${name}</h3><span class="badge bot-status ${category}" title="${escape(reason)}">${groups[category]}</span></div>
      <span class="quest-count" data-card-levels hidden></span></div>
    <div class="card-task">
      ${bot.activity === '—' ? '' : `<p class="task-line" data-activity>${escape(bot.activity)}</p>`}
      ${showReason ? `<p class="reason">${escape(reason)}</p>` : ''}
    </div>
    <div class="last-activity">
      <span>Last activity</span>${timestamp}<strong>${escape(activityDetail)}</strong>
    </div>
    <dl class="facts">
      ${fact('Heartbeat', timeAgo(now, bot.heartbeat))}
      ${fact('Elapsed', elapsedTime(now, managed?.startedAt), 'elapsed-value')}
      ${fact('Last Action', timeAgo(now, bot.lastActivity ? Date.parse(bot.lastActivity.at) : undefined))}
      ${fact('Client', bot.status, 'status-' + bot.status.toLowerCase())}
    </dl>
    <div class="location-line"><strong>${escape(bot.location ?? 'Location unavailable')}</strong><small data-card-xp hidden></small></div>
    <div class="skills" data-card-skills role="group" aria-label="Combat skills" hidden>
      ${fleetSkills.slice(0, 7).map(([skill]) => `<span class="skill-badge" data-card-skill="${escape(skill)}" hidden>
        ${fleetSkillIcon(skill)}<span class="visually-hidden">${escape(skill)} </span><span data-skill-level></span>
      </span>`).join('')}
    </div>
    <div class="card-footer">
      <div class="card-actions">
        ${cardAction('Details', 'details', `data-detail="${name}"`)}
        ${cardAction('Current inventory', 'inventory', `data-inventory="${name}"`)}
        ${cardAction('View skill stats', 'skills', `data-skill-stats="${name}" aria-haspopup="dialog"`)}
        ${cardAction('Diagnostics', 'diagnostics', `data-diagnostics="${name}"`)}
        ${cardAction('Audit history', 'audit', `data-audit-bot="${name}"`)}
        ${cardAction('Bank', 'bank', `data-bank="${name}"`)}
        ${planButton}
      </div>
      ${activityButton || watch ? `<div class="card-actions card-primary-actions">${activityButton}${watch}</div>` : ''}
    </div>
    </article>`;
}

type Page = { nonce: string; revision?: string; data?: Snapshot; taskActivity?: ReadonlyMap<string, LastActivity>;
    questCatalog: QuestColumn[]; fleetStyle: string; controls: string; refreshSeconds: number; displayTimeZone: string };

export function fleetPage({ nonce, revision = '', data, taskActivity, questCatalog, fleetStyle, controls, refreshSeconds, displayTimeZone }: Page) {
    const now = data ? Date.parse(data.checkedAt) : Date.now();
    const roster = (data?.bots ?? []).map(bot => {
        const managed = bot.control;
        return { bot, managed, ...classify(bot, managed, now) };
    });
    const counts = { attention: 0, active: 0, idle: 0, offline: 0 };
    for (const { category } of roster) counts[category]++;
    const online = roster.filter(({ bot }) => bot.status === 'Online').length;
    const metric = (label: string, value: number | string, detail: string, className = '', attributes = '') =>
        `<div class="metric"><span>${label}</span><strong class="${className}" ${attributes}>${value}</strong><small>${detail}</small></div>`;
    const tab = (id: string, label: string) => `<button type="button" id="${id}-tab" role="tab"
        aria-controls="${id}-panel" aria-selected="${id === 'fleet'}"${id === 'fleet' ? '' : ' tabindex="-1"'}>${label}</button>`;
    const sections = Object.entries(groups).map(([id, label]) => {
        const members = roster.filter(({ category }) => category === id);
        if (!members.length) return '';
        return `<section class="group" data-group="${id}"><div class="group-title">
          <h2 class="${id}">${label}</h2><span class="count">${members.length}</span>
          ${id === 'attention' ? '<small>Review activity and connection status</small>' : ''}
          </div><div class="grid">${members.map(({ bot, category, reason, managed }) =>
            card(bot, category, reason, managed, now, taskActivity?.get(bot.name))).join('')}</div></section>`;
    }).join('');
    const rowList = roster.map(({ bot, category }) => ({
        name: bot.name, category, hiscore: questHiscore(bot.name),
    }));
    // Bot names and skill names are allowlisted without markup characters.
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleet desk</title>
<style>${fleetStyle}</style>
</head>
<body>
<header>
  <div class="brand"><strong>Fleet desk</strong><div>
    <p>${counts.active} running, ${counts.attention} need attention, ${counts.offline} offline</p>
    ${data ? `<small>Snapshot <time datetime="${data.checkedAt}">${clock.format(new Date(now))}</time></small>` : ''}
  </div></div>
  <div class="toolbar">
    <nav role="tablist" aria-label="Dashboard views">${tab('fleet', 'Fleet')}${tab('stats', 'Stats')}${tab('quests', 'Quests')}</nav>
    <input id="search" type="search" aria-label="Search accounts" placeholder="Search accounts" autocomplete="off">
    <button type="button" id="monitor-open" aria-haspopup="dialog">Monitor</button>
    <button type="button" id="new-bot">New bot</button>
    <button type="button" id="banks">Check banks</button>
    <button type="button" id="audit-open">Audit history</button>
    <button type="button" id="refresh" aria-keyshortcuts="Control+R">Refresh</button>
    <button type="button" id="auto" aria-pressed="true">Auto</button>
    <button type="button" id="dashboard-account">Sign in</button>
    <small id="fleet-refresh-status" role="status" hidden></small>
  </div>
</header>
<main>
  <div class="summary" aria-label="Fleet summary">
    ${metric(groups.active, counts.active, 'Recent game activity', 'active')}
    ${metric('Online', online, `of ${roster.length} accounts`, 'swarm')}
    ${metric('Needs attention', counts.attention, 'Check game state or activity', 'attention')}
    ${metric('Idle', counts.idle, 'Waiting or no recent activity', 'paused')}
    ${metric('Quest points', '—', 'Game snapshots or hiscores', 'points', 'id="quest-total"')}
  </div>
  <div id="fleet-panel" role="tabpanel" aria-labelledby="fleet-tab">
    ${sections}<p class="empty" id="fleet-empty"${sections ? ' hidden' : ''}>${!data
        ? 'Bot status is temporarily unavailable.' : roster.length ? 'No bots match your filters.' : 'No bots configured.'}</p>
  </div>
  <div id="stats-panel" role="tabpanel" aria-labelledby="stats-tab" hidden></div>
  <div id="quests-panel" role="tabpanel" aria-labelledby="quests-tab" hidden></div>
</main>
<dialog id="monitor-dialog" aria-labelledby="monitor-title"><div class="dialog-body">
  <div class="dialog-header monitor-header">
    <div class="monitor-heading"><h2 id="monitor-title">Resource monitor</h2>
      <p id="monitor-status" role="status">VPS process usage by bot and PID</p>
    </div>
    <dl class="monitor-meta">
      <div><dt>Sample interval</dt><dd id="monitor-interval">—</dd></div>
      <div><dt>Latest sample</dt><dd><time id="monitor-latest">—</time></dd></div>
    </dl>
    <button type="button" id="monitor-close" autofocus>Close</button>
  </div>
  <section class="monitor-summary" aria-label="Resource totals">
    <article class="metric monitor-bots"><span>Bot processes</span><strong id="monitor-bot-rss">—</strong><small id="monitor-bot-detail">Lite clients and SDK tasks</small></article>
    <article class="metric monitor-shared"><span>Shared pathfinder</span><strong id="monitor-shared-rss">—</strong><small id="monitor-shared-detail">—</small></article>
    <article class="metric"><span>Fleet process MEM</span><strong id="monitor-fleet-rss">—</strong><small id="monitor-fleet-detail">—</small></article>
  </section>
  <div class="monitor-workspace">
    <section class="monitor-panel" aria-labelledby="monitor-history-title">
      <div class="monitor-panel-header"><div><h3 id="monitor-history-title">Resource history</h3><p id="monitor-chart-info">CPU as a percentage of one core</p></div><span id="monitor-peak"></span></div>
      <div class="monitor-chart-controls">
        <select id="monitor-subject" aria-label="Select processes for resource history" disabled><option>No process data</option></select>
        <div class="monitor-segment" role="group" aria-label="Metric">
          <button type="button" data-monitor-metric="cpu" aria-pressed="true">CPU</button><button type="button" data-monitor-metric="rss" aria-pressed="false">MEM</button>
        </div>
        <div class="monitor-segment" role="group" aria-label="Time range">
          <button type="button" data-monitor-window="30" aria-pressed="true">30s</button><button type="button" data-monitor-window="300" aria-pressed="false">5m</button><button type="button" data-monitor-window="3600" aria-pressed="false">1h</button>
        </div>
        <label class="monitor-overlay"><input id="monitor-overlay-pathfinder" type="checkbox" disabled>Overlay pathfinder</label>
      </div>
      <div class="monitor-chart-frame">
        <canvas id="monitor-chart" role="img" aria-label="Process resource history" tabindex="0"></canvas>
        <p id="monitor-chart-empty">Waiting for samples…</p>
        <output id="monitor-chart-hover" aria-live="off" hidden></output>
      </div>
      <div class="monitor-chart-footer"><div id="monitor-legend" aria-label="Chart legend"></div><span id="monitor-resolution"></span></div>
    </section>
    <section class="monitor-panel" aria-labelledby="monitor-process-title">
      <div class="monitor-panel-header"><h3 id="monitor-process-title">Process breakdown</h3><span id="monitor-copy-status" role="status"></span></div>
      <div class="monitor-table" tabindex="0" aria-labelledby="monitor-process-title">
        <table aria-label="Process PID, resident memory, CPU, and start time">
          <thead><tr><th scope="col">Process</th><th scope="col">PID</th><th scope="col">MEM</th><th scope="col">CPU</th><th scope="col">Started</th></tr></thead>
          <tbody><tr><td colspan="5">Waiting for samples…</td></tr></tbody>
        </table>
      </div>
    </section>
  </div>
</div></dialog>
<dialog id="fleet-details" aria-labelledby="fleet-details-title"><div class="dialog-body">
  <div class="dialog-header"><h2 id="fleet-details-title"></h2><button type="button" data-close>Close</button></div>
  <p id="fleet-details-status" role="status"></p>
  <div id="fleet-details-content"></div>
</div></dialog>
<dialog id="skill-stats-dialog" aria-labelledby="skill-stats-title" aria-describedby="skill-stats-status"><div class="dialog-body">
  <div class="dialog-header"><h2 id="skill-stats-title">Skills</h2><button type="button" data-close autofocus>Close</button></div>
  <p id="skill-stats-status" role="status"></p>
  <dl class="skill-stats-grid" id="skill-stats-grid" hidden>
    ${skillTabOrder.map(skill => `<div class="skill-stat" data-skill-stat="${skill}">
      <dt>${fleetSkillIcon(skill)}<span>${skill}</span></dt><dd>—</dd>
    </div>`).join('')}
    <div class="skill-stat skill-stat-total"><dt>Total level</dt><dd id="skill-stats-total">—</dd></div>
  </dl>
</div></dialog>
<dialog id="inventory-dialog" aria-labelledby="inventory-title"><div class="dialog-body">
  <div class="dialog-header"><h2 id="inventory-title">Current inventory</h2>
    <div class="inventory-header-actions">
      <button type="button" id="inventory-refresh" aria-label="Refresh inventory" title="Refresh inventory">
        <svg class="inventory-action-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.8 5.6a6 6 0 1 0 .1 4.5M13.8 1.9v3.7h-3.7"/></svg>
      </button>
      <button type="button" data-close>Close</button>
    </div>
  </div>
  <p id="inventory-status" role="status"></p>
  <div class="inventory-layout" id="inventory-layout" hidden>
    <ol id="inventory-items" class="inventory-grid" role="list" aria-label="Backpack slots"></ol>
    <section class="inventory-inspector" aria-label="Selected item">
      <div class="inventory-selection">
        <div id="inventory-preview" class="inventory-preview" aria-hidden="true" hidden></div>
        <div aria-live="polite" aria-atomic="true">
          <p id="inventory-item-detail" class="inventory-selection-name"></p>
          <p id="inventory-item-meta" class="inventory-selection-meta" hidden></p>
        </div>
      </div>
      <div class="inventory-toolbar" role="group" aria-label="Item actions">
        <button type="button" id="inventory-eat" aria-disabled="true">
          <svg class="inventory-action-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 1.5v4a2.5 2.5 0 0 0 5 0v-4m-2.5 0v13m8.5 0v-13c-2 0-3 2.5-3 5v1h3"/></svg>Eat
        </button>
        <button type="button" id="inventory-drop" class="inventory-destructive" aria-disabled="true">
          <svg class="inventory-action-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8m-3-3 3 3 3-3M3 11v2.5h10V11"/></svg>Drop
        </button>
      </div>
      <p class="inventory-selection-meta inventory-read-only" id="inventory-read-only" hidden>Item actions are unavailable for this client.</p>
      <div class="inventory-confirmation" id="inventory-drop-confirmation" role="group" aria-labelledby="inventory-drop-question" hidden>
        <p id="inventory-drop-question"></p>
        <div class="inventory-toolbar">
          <button type="button" id="inventory-drop-cancel">Cancel</button>
          <button type="button" id="inventory-drop-submit" class="inventory-destructive">Confirm drop</button>
        </div>
      </div>
      <div id="inventory-action-status" class="inventory-action-status" role="status" aria-atomic="true">
        <p id="inventory-action-title"></p>
        <p id="inventory-action-detail"></p>
      </div>
    </section>
  </div>
</div></dialog>
<dialog id="banks-dialog" aria-labelledby="bank-title"><div class="dialog-body">
  <div class="dialog-header"><h2 id="bank-title" tabindex="-1">Bank snapshots</h2><button type="button" data-close>Close</button></div>
  <p id="bank-status" role="status"></p>
  <div id="bank-panel"></div>
  <p id="bank-item-detail" class="inventory-item-detail" aria-live="polite" hidden></p>
  <button type="button" id="bank-back" hidden>All bank snapshots</button>
</div></dialog>
<dialog aria-labelledby="activity-title"><form class="dialog-body">
  <h2 id="activity-title"></h2>
  <p role="status" aria-live="polite"></p>
  <div><button type="submit"></button> <button type="button" id="activity-close">Close</button></div>
</form></dialog>
<dialog id="plan-dialog" aria-labelledby="plan-title"><form class="dialog-body" id="plan-form">
  <div class="dialog-header"><h2 id="plan-title">Activity plan</h2><button type="button" id="plan-close">Close</button></div>
  <label id="plan-name-field" hidden>Bot name <input id="plan-bot-name" maxlength="12" pattern="[A-Za-z0-9]{1,12}" placeholder="Random name" autocomplete="off"></label>
  <p id="plan-error" role="status" aria-live="polite"></p>
  <ol id="plan-steps"></ol>
  <div class="plan-toolbar">
    <button type="button" id="plan-add">Add activity</button>
    <button type="button" id="plan-edit" hidden>New plan</button>
    <button type="submit" id="plan-save">Start plan</button>
  </div>
</form></dialog>
<dialog id="dashboard-sign-in" aria-labelledby="sign-in-title"><form class="dialog-body">
  <h2 id="sign-in-title">Dashboard sign-in</h2>
  <label>Dashboard password <input id="dashboard-password" type="password" autocomplete="current-password" required autofocus></label>
  <p role="status" aria-live="polite"></p>
  <div><button type="submit">Sign in</button> <button type="button">Close</button></div>
</form></dialog>
<dialog id="dashboard-diagnostics" aria-labelledby="diagnostics-title"><div class="dialog-body">
  <h2 id="diagnostics-title">Diagnostics</h2>
  <p id="diagnostics-status" role="status" aria-live="polite"></p>
  <table aria-label="Current bot diagnostics"><tbody id="diagnostics-current"></tbody></table>
  <h3>Recent events</h3>
  <ul id="diagnostics-events"></ul>
  <button type="button" id="diagnostics-refresh">Refresh</button>
  <button type="button" id="diagnostics-close">Close</button>
</div></dialog>
<dialog id="audit-dialog" aria-labelledby="audit-title"><div class="dialog-body">
  <div class="audit-chrome">
  <div class="dialog-header"><h2 id="audit-title">Activity audit</h2>
    <div class="audit-actions"><button type="button" id="audit-copy" disabled>Copy link</button><button type="button" data-close>Close</button></div>
  </div>
  <form id="audit-filters" class="audit-toolbar">
    <nav id="audit-views" aria-label="Audit views">
      <button type="button" data-audit-mode="insights" aria-pressed="true">Insights</button>
      <button type="button" data-audit-mode="runs" aria-pressed="false">Runs</button>
      <button type="button" data-audit-mode="summary" aria-pressed="false">Summary</button>
    </nav>
    <label>Bot <input id="audit-bot" list="audit-bots" maxlength="12" placeholder="All bots" autocomplete="off"></label>
    <datalist id="audit-bots">${roster.map(({ bot }) => `<option value="${escape(bot.name)}"></option>`).join('')}</datalist>
    <label>Task <input id="audit-task" list="audit-tasks" maxlength="64" placeholder="All tasks" autocomplete="off"></label>
    <datalist id="audit-tasks">${activityIds.map(id => `<option value="${escape(id)}">${escape(activity(id).label)}</option>`).join('')}</datalist>
    <label>Days <input id="audit-days" type="number" min="1" max="35" value="35" required></label>
    <label id="audit-summary-phase-field" hidden>Phase <input id="audit-summary-phase" maxlength="64" placeholder="All phases"></label>
    <label id="audit-revision-field">Revision <input id="audit-revision" list="audit-revisions" maxlength="40" pattern="[0-9a-fA-F]{7,40}" placeholder="Any revision" autocomplete="off"></label>
    <label id="audit-baseline-field">Baseline revision <input id="audit-baseline" list="audit-revisions" maxlength="40" pattern="[0-9a-fA-F]{7,40}" placeholder="Optional" autocomplete="off"></label>
    <datalist id="audit-revisions"></datalist>
    <button type="submit">Apply</button>
  </form>
  <div id="audit-run-tools" class="audit-toolbar" hidden>
    <button type="button" id="audit-back">Back to runs</button>
    <button type="button" id="audit-operation-back" hidden>Back to events</button>
    <label>Phase <select id="audit-phase"><option value="">All phases</option></select></label>
    <label>Event type <select id="audit-kind">
      <option value="key">Key events</option><option value="">All events</option><option value="setback">Setbacks</option>
      <option value="failure">Failures</option><option value="milestone">Milestones</option><option value="result">Results</option>
      <option value="action">Dispatches</option><option value="intent">Intents</option><option value="check">Checks</option>
      <option value="decision">Decisions</option><option value="phase">Phase changes</option><option value="state">State</option>
      <option value="worker">Worker</option><option value="task-event">Task events</option>
    </select></label>
    <button type="button" id="audit-clear-event" hidden>Clear outcome</button>
    <button type="button" id="audit-refresh">Refresh</button>
  </div>
  <p id="audit-status" role="status" aria-live="polite"></p>
  </div>
  <div id="audit-scroll">
    <div id="audit-content"></div>
    <button type="button" id="audit-older" hidden>Load older</button>
  </div>
</div></dialog>
<script nonce="${nonce}" type="application/json" id="fleet-roster">${JSON.stringify({ rows: rowList, skills: fleetSkills, questCatalog }).replaceAll('<', '\\u003c')}</script>
<script nonce="${nonce}" data-revision="${revision}" data-refresh="${refreshSeconds}" data-time-zone="${displayTimeZone}">${controls}</script>
</body></html>`;
}
