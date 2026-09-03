const THEMES = Object.freeze({
  'editorial-minimal': Object.freeze({
    id: 'editorial-minimal',
    label: 'Editorial minimal',
    description: 'Quiet publication hierarchy with ink, paper, and a restrained vermilion signal.',
    font: {
      display: 'Georgia, "Times New Roman", serif',
      body: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      mono: '"SFMono-Regular", Consolas, monospace',
    },
    color: {
      canvas: '#E9E3D8',
      canvasDetail: '#D5CDC0',
      surface: '#FFFDF8',
      surfaceAlt: '#F3EEE5',
      text: '#17201E',
      mutedText: '#4C5854',
      accent: '#B83D24',
      accentText: '#FFFFFF',
      line: '#CFC7B9',
      risk: '#9B3424',
      assumption: '#4A6159',
    },
    radius: { card: 4, item: 2, pill: 999 },
    border: { width: 1, style: 'solid' },
    shadow: '0 28px 70px rgba(46, 38, 28, 0.18)',
    motion: { reveal: 'page', entryY: 18, staggerFrames: 4, durationFrames: 18 },
    decision: { uppercase: false, optionFill: false, promptScale: 1.02 },
  }),
  'technical-system': Object.freeze({
    id: 'technical-system',
    label: 'Technical system',
    description: 'Dark instrument-panel structure with monospace labels and clear state signals.',
    font: {
      display: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      body: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      mono: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    },
    color: {
      canvas: '#06110E',
      canvasDetail: '#123027',
      surface: '#0D1A17',
      surfaceAlt: '#132520',
      text: '#EAFEF6',
      mutedText: '#A7C1B7',
      accent: '#76F2B2',
      accentText: '#06110E',
      line: '#2A4A40',
      risk: '#FF8A80',
      assumption: '#8FC7FF',
    },
    radius: { card: 18, item: 10, pill: 6 },
    border: { width: 1, style: 'solid' },
    shadow: '0 26px 90px rgba(0, 0, 0, 0.48)',
    motion: { reveal: 'scan', entryY: 0, staggerFrames: 3, durationFrames: 12 },
    decision: { uppercase: true, optionFill: true, promptScale: 1 },
  }),
  'warm-briefing': Object.freeze({
    id: 'warm-briefing',
    label: 'Warm briefing',
    description: 'Confident presentation shapes with plum depth, amber warmth, and generous rhythm.',
    font: {
      display: 'Avenir Next, Avenir, "Trebuchet MS", sans-serif',
      body: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      mono: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
    },
    color: {
      canvas: '#201A2F',
      canvasDetail: '#49365E',
      surface: '#2E2542',
      surfaceAlt: '#3A2E51',
      text: '#FFF8ED',
      mutedText: '#D8CCE5',
      accent: '#FFB65A',
      accentText: '#25192E',
      line: '#5E4B77',
      risk: '#FF9D87',
      assumption: '#A8DAD0',
    },
    radius: { card: 34, item: 20, pill: 999 },
    border: { width: 0, style: 'solid' },
    shadow: '0 32px 100px rgba(10, 6, 20, 0.40)',
    motion: { reveal: 'lift', entryY: 28, staggerFrames: 5, durationFrames: 22 },
    decision: { uppercase: false, optionFill: true, promptScale: 1.06 },
  }),
});

export const PLAN_THEME_IDS = Object.freeze(Object.keys(THEMES));
export const PLAN_THEMES = THEMES;

export function getPlanTheme(id) {
  const theme = THEMES[id];
  if (!theme) {
    throw new Error(`unknown plan theme "${id}"; choose one of: ${PLAN_THEME_IDS.join(', ')}`);
  }
  return theme;
}

function rgb(hex) {
  const value = String(hex).replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error(`contrastRatio needs a six-digit hex color, got "${hex}"`);
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
}

function luminance(hex) {
  return rgb(hex)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

export function contrastRatio(a, b) {
  const light = Math.max(luminance(a), luminance(b));
  const dark = Math.min(luminance(a), luminance(b));
  return (light + 0.05) / (dark + 0.05);
}
