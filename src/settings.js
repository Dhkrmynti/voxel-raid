// Player preferences (controls, sound, graphics), kept in this browser only.
const KEY = 'voxelraid.settings.v1';
export const QUALITY_MODES = ['auto', 'high', 'low'];

// [min, max] for every numeric setting; values outside are clamped when loading.
export const RANGES = {
  sensitivity: [0.2, 3],
  touchSensitivity: [0.3, 3],
  fov: [60, 100],
  sfxVolume: [0, 1],
  musicVolume: [0, 1],
};

export const DEFAULT_SETTINGS = Object.freeze({
  sfx: true,
  music: true,
  sfxVolume: 0.8,
  musicVolume: 0.6,
  quality: 'auto',
  sensitivity: 1,
  touchSensitivity: 1,
  invertY: false,
  fov: 75,
  flashes: true,
});

export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    // unreadable storage → defaults
  }
  // Older saves had a glow on/off switch instead of a quality mode.
  if (!saved.quality && saved.glow === false) saved.quality = 'low';
  const s = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const v = saved[key];
    if (RANGES[key]) {
      if (typeof v === 'number' && Number.isFinite(v)) s[key] = Math.min(RANGES[key][1], Math.max(RANGES[key][0], v));
    } else if (key === 'quality') {
      if (QUALITY_MODES.includes(v)) s.quality = v;
    } else if (typeof v === 'boolean') {
      s[key] = v;
    }
  }
  return s;
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable — settings last for this session only
  }
}
