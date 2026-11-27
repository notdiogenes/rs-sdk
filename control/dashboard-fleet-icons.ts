const skillGlyphs: Record<string, string> = {
    Attack: '<path fill="#b9d0de" d="M14.5 1.5 14 6.1 6.9 12.4l-3.3-3.3 6.3-7.1z"/><path stroke="#6e8d9c" d="M13 3 5.5 10.5"/><path stroke="#eab96a" stroke-width="1.7" d="m3.3 8.8 4 4M5.1 11 2 14.1"/>',
    Strength: '<path fill="#df9f63" stroke="#a96843" stroke-linejoin="round" d="M5 14.1v-2.6L2.8 9.2l.4-2.4 1.8-.2V4.3l1.8-.8 1.3 1 1.3-1.2 1.4.6 1.3-.8 1.3 1.2v5l-2.5 2.2v2.6z"/><path fill="none" stroke="#7f4d37" stroke-linecap="round" d="M5 7.3h6.7M7.6 4.7v2.4m2.6-2.5v2.5M5.1 9.2l2 .8"/>',
    Defence: '<path fill="#a7b6c0" stroke="#728590" stroke-linejoin="round" d="m8 1.4 5.4 2v4.3c0 3.1-2.1 5.6-5.4 7-3.3-1.4-5.4-3.9-5.4-7V3.4z"/><path fill="#495d6a" d="m8 3 3.9 1.5v3.1c0 2.1-1.4 4.1-3.9 5.4z"/><path stroke="#dde7ea" d="M4.1 4.5v3"/>',
    Hitpoints: '<path fill="#ef8063" stroke="#a9473b" stroke-linejoin="round" d="M8 14 2.2 8.5C-1 5.1 3.7 1 6.5 4L8 5.4 9.5 4c2.8-3 7.5 1.1 4.3 4.5z"/><path fill="none" stroke="#ffb2a0" stroke-linecap="round" d="M3.2 6.4c0-.9.8-1.8 1.9-1.8"/>',
    Ranged: '<path fill="none" stroke="#c89764" stroke-linecap="round" stroke-width="1.7" d="M5 2a6 6 0 0 1 5 12"/><path fill="none" stroke="#d8c6a3" stroke-linejoin="round" d="m5 2 1.9 6 3.1 6"/><path fill="#bcd287" d="m1.7 9.4 9.3-4-.5-1.5 4-.1-2.9 3-.4-1-9 4.6z"/>',
    Prayer: '<path fill="#e9d683" stroke="#bda45a" stroke-linejoin="round" d="M8 1.2 9.8 6l4.9 2-4.9 1.8L8 14.8 6.2 9.8 1.3 8l4.9-2z"/><path stroke="#fff3bc" stroke-linecap="round" d="M8 5v6M5 8h6"/>',
    Magic: '<path fill="#8ba6f4" stroke="#505eaa" stroke-linejoin="round" d="M4.4 10.3 6.8 2l4.6 3.1-2.1.4 2.2 4.8 2.3 1.8v1.4c-3.8 1-7.6.9-11.6 0v-1.4z"/><path stroke="#e5c37a" stroke-width="1.2" d="M4.8 9.3c1.9.6 4 .6 6.2 0"/><path stroke="#c3ceff" stroke-linecap="round" d="m6.3 6.7.7-2.1"/>',
};

const actionGlyphs = {
    details: '<circle cx="10" cy="10" r="7"/><path d="M10 9v4.5m0-7v.2"/>',
    inventory: '<path d="M7 5.5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.5M6 5.5h8a2 2 0 0 1 2 2V16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7.5a2 2 0 0 1 2-2Z"/><path d="M7 13h6v4M4 9h12"/>',
    diagnostics: '<rect x="2.5" y="4" width="15" height="10.5" rx="2"/><path d="M7 17h6m-3-2.5V17m-5-7h2l1.4-2.8 2.1 5 1.4-2.2H15"/>',
    audit: '<path d="M6 2.8h6l3.5 3.5v9.4a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V4.3A1.5 1.5 0 0 1 6 2.8Z"/><path d="M12 3v4h3.4m-8 3h5.1m-5.1 3h5.1"/>',
    bank: '<ellipse cx="10" cy="5.7" rx="5.5" ry="2.5"/><path d="M4.5 5.7v8.5c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V5.7M4.5 10c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5"/>',
    plan: '<rect x="4" y="4.8" width="12" height="12.7" rx="1.7"/><rect x="7" y="2.5" width="6" height="4" rx="1.3" fill="var(--card-action-bg)"/><path d="m6.8 11 1.3 1.3 2.3-2.4m1.6 1.5h1.5m-6.7 3.2h6.7"/>',
    pause: '<path d="M7 5v10m6-10v10" stroke-width="2.6"/>',
    stop: '<rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
    watch: '<path d="M2 10c2.2-3.4 5-5.1 8-5.1s5.8 1.7 8 5.1c-2.2 3.4-5 5.1-8 5.1S4.2 13.4 2 10Z"/><circle cx="10" cy="10" r="2.3"/>',
};

export type FleetActionIcon = keyof typeof actionGlyphs;

export function fleetSkillIcon(name: string) {
    const glyph = skillGlyphs[name];
    return glyph ? `<svg class="skill-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">${glyph}</svg>` : '';
}

export function fleetActionIcon(icon: FleetActionIcon) {
    return `<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${actionGlyphs[icon]}</svg>`;
}
