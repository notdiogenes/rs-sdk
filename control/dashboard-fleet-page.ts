import { fleetSkills } from './dashboard-fleet-stats';
import { questHiscore, type QuestColumn } from './dashboard-quests';
import type { Bot, ControlActivity, Snapshot } from './public-status';

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const groups = { attention: 'Needs attention', active: 'Producing', idle: 'Idle', offline: 'Offline' } as const;
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

function fact(label: string, value: string, className = '') {
    return `<div><dt>${label}</dt><dd class="${className}">${escape(value)}</dd></div>`;
}

function card(bot: Bot, category: Group, reason: string, managed: ControlActivity | undefined, now: number) {
    const name = escape(bot.name);
    const last = bot.lastActivity;
    const effect = last ? `<time datetime="${escape(last.at)}">${activityClock.format(new Date(last.at))}</time>` : '—';
    const watch = bot.status === 'Online'
        ? `<a href="https://maxbittker.github.io/rs-world/?follow=${encodeURIComponent(bot.name)}" target="_blank" rel="noopener">Watch ↗</a>` : '';
    const activityButton = managed?.running
        ? `<button type="button" data-bot="${name}" data-action="stop">${bot.plan?.status === 'running' ? 'Pause plan' : 'Stop activity'}</button>` : '';
    const planButton = `<button type="button" data-plan-bot="${name}">${bot.plan ? 'View plan' : 'Plan activities'}</button>`;
    const planDetail = bot.plan && bot.plan.status !== 'complete'
        ? `<small class="plan-card-status" title="${escape(bot.plan.message ?? '')}">Plan · ${bot.plan.status} · step ${bot.plan.index + 1} of ${bot.plan.length}</small>` : '';
    return `<article class="bot" data-bot-row data-name="${name}" data-status="${category}">
    <div class="bot-header"><h3>${name} <span class="badge">Managed</span></h3>
      <span class="quest-count" data-card-levels hidden></span></div>
    <p class="reason" title="${escape(reason)}"><span class="badge ${category}">${groups[category]}</span> ${escape(reason)}</p>
    <p class="task-line" data-activity>${escape(bot.activity)}</p>${planDetail}
    <p class="log" title="Last activity">Last activity · ${effect}${last ? ' · ' + escape(last.reason) : ''}</p>
    <dl class="facts">
      ${fact('Heartbeat', timeAgo(now, bot.heartbeat))}
      ${fact('Progress', managed?.startedAt ? timeAgo(now, Date.parse(managed.startedAt)) + ' running' : '—')}
      ${fact('Effect', timeAgo(now, last ? Date.parse(last.at) : undefined))}
      ${fact('Client', bot.status, 'status-' + bot.status.toLowerCase())}
    </dl>
    <div class="location-line"><strong>${escape(bot.location ?? 'Location unavailable')}</strong><small data-card-xp hidden></small></div>
    <div class="skills" data-card-skills hidden></div>
    <div class="card-footer">
      <button type="button" data-detail="${name}">Details</button>
      <button type="button" data-inventory="${name}">Current inventory</button>
      <button type="button" data-diagnostics="${name}">Diagnostics</button>
      <button type="button" data-bank="${name}">Bank</button>
      ${planButton}${activityButton}${watch}
    </div>
    </article>`;
}

type Page = { nonce: string; data?: Snapshot; questCatalog: QuestColumn[]; fleetStyle: string; controls: string; refreshSeconds: number; displayTimeZone: string };

export function fleetPage({ nonce, data, questCatalog, fleetStyle, controls, refreshSeconds, displayTimeZone }: Page) {
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
    const groupOptions = Object.entries(groups).map(([id, label]) => `<option value="${id}">${label}</option>`).join('');
    const sections = Object.entries(groups).map(([id, label]) => {
        const members = roster.filter(({ category }) => category === id);
        if (!members.length) return '';
        return `<section class="group" data-group><div class="group-title">
          <h2 class="${id}">${label}</h2><span class="count">${members.length}</span>
          ${id === 'attention' ? '<small>Review activity and connection status</small>' : ''}
          </div><div class="grid">${members.map(({ bot, category, reason, managed }) => card(bot, category, reason, managed, now)).join('')}</div></section>`;
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
    <p>${counts.active} producing, ${counts.attention} need attention, ${counts.offline} offline</p>
    ${data ? `<small>Snapshot <time datetime="${data.checkedAt}">${clock.format(new Date(now))}</time></small>` : ''}
  </div></div>
  <div class="toolbar">
    <nav role="tablist" aria-label="Dashboard views">${tab('fleet', 'Fleet')}${tab('stats', 'Stats')}${tab('quests', 'Quests')}</nav>
    <input id="search" type="search" aria-label="Search accounts" placeholder="Search accounts" autocomplete="off">
    <select id="status-filter" aria-label="Filter by status"><option value="all">All views</option>${groupOptions}</select>
    <button type="button" id="new-bot">New bot</button>
    <button type="button" id="banks">Check banks</button>
    <button type="button" id="refresh">Refresh</button>
    <button type="button" id="auto" aria-pressed="true">Auto</button>
    <button type="button" id="dashboard-account">Sign in</button>
  </div>
</header>
<main>
  <div class="summary" aria-label="Fleet summary">
    ${metric('Producing', counts.active, 'Recent game activity', 'active')}
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
<dialog id="fleet-details" aria-labelledby="fleet-details-title"><div class="dialog-body">
  <div class="dialog-header"><h2 id="fleet-details-title"></h2><button type="button" data-close>Close</button></div>
  <p id="fleet-details-status" role="status"></p>
  <div id="fleet-details-content"></div>
</div></dialog>
<dialog id="inventory-dialog" aria-labelledby="inventory-title"><div class="dialog-body">
  <div class="dialog-header"><h2 id="inventory-title">Current inventory</h2><button type="button" data-close>Close</button></div>
  <p id="inventory-status" role="status"></p>
  <div id="inventory-items"></div>
  <button type="button" id="inventory-refresh">Refresh inventory</button>
</div></dialog>
<dialog id="banks-dialog" aria-labelledby="bank-title"><div class="dialog-body">
  <div class="dialog-header"><h2 id="bank-title">Bank snapshots</h2><button type="button" data-close>Close</button></div>
  <p>Balances are recorded when a bot opens its bank in-game.</p>
  <div id="bank-panel"></div>
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
<script nonce="${nonce}" type="application/json" id="fleet-roster">${JSON.stringify({ rows: rowList, skills: fleetSkills, questCatalog }).replaceAll('<', '\\u003c')}</script>
<script nonce="${nonce}" data-refresh="${refreshSeconds}" data-time-zone="${displayTimeZone}">${controls}</script>
</body></html>`;
}
