// Player preferences (sound, music, graphics quality), kept in this browser only.
const KEY = 'voxelraid.settings.v1';
const DEFAULTS = { sfx: true, music: true, quality: 'auto' };
export const QUALITY_MODES = ['auto', 'high', 'low'];

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    // Older saves had a glow on/off switch instead of a quality mode.
    if (!saved.quality && saved.glow === false) saved.quality = 'low';
    delete saved.glow;
    return { ...DEFAULTS, ...saved, quality: QUALITY_MODES.includes(saved.quality) ? saved.quality : DEFAULTS.quality };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable — settings last for this session only
  }
}
