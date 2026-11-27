const skillGlyphs: Record<string, string> = {
    Attack: '<path fill="#b9d0de" d="M14.5 1.5 14 6.1 6.9 12.4l-3.3-3.3 6.3-7.1z"/><path stroke="#6e8d9c" d="M13 3 5.5 10.5"/><path stroke="#eab96a" stroke-width="1.7" d="m3.3 8.8 4 4M5.1 11 2 14.1"/>',
    Strength: '<path fill="#df9f63" stroke="#a96843" stroke-linejoin="round" d="M5 14.1v-2.6L2.8 9.2l.4-2.4 1.8-.2V4.3l1.8-.8 1.3 1 1.3-1.2 1.4.6 1.3-.8 1.3 1.2v5l-2.5 2.2v2.6z"/><path fill="none" stroke="#7f4d37" stroke-linecap="round" d="M5 7.3h6.7M7.6 4.7v2.4m2.6-2.5v2.5M5.1 9.2l2 .8"/>',
    Defence: '<path fill="#a7b6c0" stroke="#728590" stroke-linejoin="round" d="m8 1.4 5.4 2v4.3c0 3.1-2.1 5.6-5.4 7-3.3-1.4-5.4-3.9-5.4-7V3.4z"/><path fill="#495d6a" d="m8 3 3.9 1.5v3.1c0 2.1-1.4 4.1-3.9 5.4z"/><path stroke="#dde7ea" d="M4.1 4.5v3"/>',
    Hitpoints: '<path fill="#ef8063" stroke="#a9473b" stroke-linejoin="round" d="M8 14 2.2 8.5C-1 5.1 3.7 1 6.5 4L8 5.4 9.5 4c2.8-3 7.5 1.1 4.3 4.5z"/><path fill="none" stroke="#ffb2a0" stroke-linecap="round" d="M3.2 6.4c0-.9.8-1.8 1.9-1.8"/>',
    Ranged: '<path fill="none" stroke="#c89764" stroke-linecap="round" stroke-width="1.7" d="M5 2a6 6 0 0 1 5 12"/><path fill="none" stroke="#d8c6a3" stroke-linejoin="round" d="m5 2 1.9 6 3.1 6"/><path fill="#bcd287" d="m1.7 9.4 9.3-4-.5-1.5 4-.1-2.9 3-.4-1-9 4.6z"/>',
    Prayer: '<path fill="#e9d683" stroke="#bda45a" stroke-linejoin="round" d="M8 1.2 9.8 6l4.9 2-4.9 1.8L8 14.8 6.2 9.8 1.3 8l4.9-2z"/><path stroke="#fff3bc" stroke-linecap="round" d="M8 5v6M5 8h6"/>',
    Magic: '<path fill="#8ba6f4" stroke="#505eaa" stroke-linejoin="round" d="M4.4 10.3 6.8 2l4.6 3.1-2.1.4 2.2 4.8 2.3 1.8v1.4c-3.8 1-7.6.9-11.6 0v-1.4z"/><path stroke="#e5c37a" stroke-width="1.2" d="M4.8 9.3c1.9.6 4 .6 6.2 0"/><path stroke="#c3ceff" stroke-linecap="round" d="m6.3 6.7.7-2.1"/>',
    Mining: '<path stroke="#c99462" stroke-width="2" stroke-linecap="round" d="M3 14 11 4"/><path fill="#a8c2cf" stroke="#658394" stroke-linejoin="round" d="M4 2c4.6-1.1 8.7.9 10.3 5.8L12 6.2 8.5 4.6 5.2 4z"/>',
    Smithing: '<path fill="#aebcc5" stroke="#647782" stroke-linejoin="round" d="M1.5 4H14l-1 3H9.7v2l2.2 1.6v2H4v-2L6.3 9V7H3z"/><path stroke="#dae4e8" d="M3.3 5.3h9.3"/>',
    Fishing: '<path fill="#7fc1cf" stroke="#477b8e" stroke-linejoin="round" d="M2 8c2.9-3.3 6-4.2 9-1.5l3.2-2v7l-3.2-2c-3 2.7-6.1 1.8-9-1.5z"/><circle cx="5.2" cy="7.7" r=".8" fill="#17343d"/>',
    Cooking: '<path fill="#ad8b73" stroke="#725547" stroke-linejoin="round" d="M3 7h10l-1.2 6H4.2z"/><path fill="none" stroke="#d9bda3" stroke-linecap="round" d="M2 7h12M3.5 9.4h9M6 4.8c-1-.8.9-1.6 0-2.5m4 2.5c-1-.8.9-1.6 0-2.5"/>',
    Firemaking: '<path fill="#f59255" stroke="#bc5342" stroke-linejoin="round" d="M8 1.5c.1 3.7 4.9 4.7 4.9 8.8a4.9 4.9 0 0 1-9.8 0c0-1.6 1.1-3.4 2.1-4.4.1 1.5.7 2.1 1.3 2.4.7-1.7.1-4.5 1.5-6.8z"/><path fill="#ffcf75" d="M8.4 8.2c.1 1.6 2.2 1.8 2.2 3.5a2.4 2.4 0 0 1-4.8 0c0-1.2 1.6-2.4 2.6-3.5z"/>',
    Woodcutting: '<path stroke="#ad7a4e" stroke-width="2" stroke-linecap="round" d="M8 11.2v3.4"/><path fill="#9bb87a" stroke="#5a784a" stroke-linejoin="round" d="m8 1.2 4.2 5H10l3.4 4.8H2.6L6 6.2H3.8z"/>',
    Agility: '<path fill="#a9c5e9" stroke="#617fae" stroke-linejoin="round" d="M8.9 2.2h3.4l-.6 5.7 2.1 1.9v2.8H4.6L2.2 11l1.3-2.4 3 1 2-2.9z"/><path stroke="#e1ebfa" stroke-linecap="round" d="M8.5 5.4h2m-2.4 2h2M3 11.6h9.7"/>',
    Herblore: '<path fill="#82bd88" stroke="#4e8061" stroke-linejoin="round" d="M6 2.5h4v4l3 3.3v3.3H3V9.8l3-3.3z"/><path stroke="#cee7b2" stroke-linecap="round" d="M5.3 2.5h5.4M5 10.4h6M8 5.4v1.4"/><circle cx="8.3" cy="11.7" r=".7" fill="#d8d99a"/>',
    Thieving: '<path fill="#a59ac1" stroke="#6c5c8a" stroke-linejoin="round" d="M1.7 5.3c2.1-.6 4.4 0 6.3 1 1.9-1 4.2-1.6 6.3-1l-.8 3.9c-.5 2.1-3.5 2.6-5.5.5-2 2.1-5 1.6-5.5-.5z"/><path stroke="#302741" stroke-width="1.4" stroke-linecap="round" d="m4.2 7.7 1.6.3m4.4 0 1.6-.3"/>',
    Crafting: '<path fill="#c9946e" stroke="#87593d" stroke-linejoin="round" d="m4.5 2.2 3.2 1.5 3.8-1.4-.3 3.4 2.7 2.6-2.7 2.2-.2 3.3-3.3-1.3-3.4 1.1-.2-3.1-2-2.2 2.2-2.6z"/><path stroke="#f3d1ad" stroke-dasharray="1 1" d="M6.4 5.5h3.4v5.2H6.4z"/>',
    Fletching: '<path stroke="#c89663" stroke-width="1.6" stroke-linecap="round" d="m3.5 12.4 9-9"/><path fill="#b8d0de" d="m9.5 2.7 4.5-.7-.7 4.5-1.3-1.3z"/><path fill="#9ac28b" d="M2 9.1 5.7 8l2.1 2.1-1.1 3.7-1.6-1.6-2.8 1.5.9-2.8z"/>',
    Runecraft: '<path fill="#b9a5d0" stroke="#756289" stroke-linejoin="round" d="m4.6 2.5 6.2-.7 2.7 3.6-1 6.1-4.4 2.4-4.9-1.8-1-5.5z"/><path fill="none" stroke="#f0e1fb" stroke-linecap="round" stroke-linejoin="round" d="M6.1 10.9V5.3h3.6v2.4H6.1l3.8 3.2"/>',
};

const actionGlyphs = {
    details: '<circle cx="10" cy="10" r="7"/><path d="M10 9v4.5m0-7v.2"/>',
    inventory: '<path fill="#a97544" stroke="#dda878" stroke-width="1.2" d="M7.1 8 5.5 3.1c1.8 1 3.2.8 4.5.1 1.4.7 2.8.9 4.5-.1L12.9 8c2.7 1.6 4.4 4.1 4.3 6.7-.2 2.4-3.2 3.3-7.2 3.3s-7-.9-7.2-3.3C2.7 12.1 4.4 9.6 7.1 8Z"/><path stroke="#ebcb96" stroke-width="1.3" d="M7.1 8h5.8l1 2.3"/><path stroke="#ce9666" stroke-width="1.2" d="M7.2 11.1c-1.1.8-1.7 2-1.6 3.2"/>',
    skills: '<path d="M3 16.5h14"/><path fill="#84aa8c" stroke="none" d="M4 11h2.8v4H4z"/><path fill="#91badd" stroke="none" d="M8.6 7.5h2.8V15H8.6z"/><path fill="#e1b56b" stroke="none" d="M13.2 3.5H16V15h-2.8z"/>',
    diagnostics: '<rect x="2.5" y="4" width="15" height="10.5" rx="2"/><path d="M7 17h6m-3-2.5V17m-5-7h2l1.4-2.8 2.1 5 1.4-2.2H15"/>',
    audit: '<path d="M8.2 17H4.6a1.4 1.4 0 0 1-1.4-1.4V4.4A1.4 1.4 0 0 1 4.6 3h8.2a1.4 1.4 0 0 1 1.4 1.4v3.2M6 6.5h5.4M6 9.6h3.6"/><circle cx="14.2" cy="14.2" r="4.2"/><path d="M14.2 11.8v2.6l1.6.8"/>',
    bank: '<circle cx="10" cy="10" r="7.1" stroke="#b58c4c"/><path stroke="#edc779" d="M10 4.7v10.6m2.4-8.4H8.9a1.55 1.55 0 0 0 0 3.1h2.2a1.55 1.55 0 0 1 0 3.1H7.6"/>',
    plan: '<circle cx="4.5" cy="15.5" r="1.8"/><path d="M6.3 15.5h6a2.2 2.2 0 0 0 0-4.4H9.5a2.2 2.2 0 0 1 0-4.4h1.6M12 9V2.8h5.6l-1.4 2 1.4 2H12"/>',
    pause: '<path d="M7 5v10m6-10v10" stroke-width="2.6"/>',
    stop: '<rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
    watch: '<path d="M2 10c2.2-3.4 5-5.1 8-5.1s5.8 1.7 8 5.1c-2.2 3.4-5 5.1-8 5.1S4.2 13.4 2 10Z"/><circle cx="10" cy="10" r="2.3"/>',
};

export type FleetActionIcon = keyof typeof actionGlyphs;

const actionColors: Record<FleetActionIcon, string> = {
    details: '#aabfe3',
    inventory: '#dda878',
    skills: '#dfbc84',
    diagnostics: '#a1cd96',
    audit: '#c8afe0',
    bank: '#edc779',
    plan: '#8fbfe2',
    pause: '#ebb38c',
    stop: '#ed9284',
    watch: '#f2d573',
};

export function fleetSkillIcon(name: string) {
    const glyph = skillGlyphs[name];
    return glyph ? `<svg class="skill-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">${glyph}</svg>` : '';
}

export function fleetActionIcon(icon: FleetActionIcon) {
    return `<svg viewBox="0 0 20 20" width="17" height="17" color="${actionColors[icon]}" fill="none" stroke="currentColor" stroke-width="1.5"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${actionGlyphs[icon]}</svg>`;
}
