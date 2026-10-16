// Twelve themes. Each sets the app colours and the terminal's 16 ANSI colours.
import { state, emit } from './ui.js';

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

// ui: background, sidebar, panel, raised panel, lines, text, muted text, accent
const theme = (name, dark, [bg, side, panel, panel2, line, text, dim, accent], colors) => ({
  name, dark, ui: { bg, side, panel, panel2, line, text, dim, accent },
  term: { background: bg, foreground: text, ...Object.fromEntries(ANSI.map((key, i) => [key, colors[i]])) },
});

export const THEMES = {
  midnight: theme('Midnight', true, ['#0b0c10', '#08090c', '#12141a', '#1a1d26', '#252a36', '#e8eaf0', '#8b91a3', '#ff3ea5'],
    ['#1c1f27', '#ff5c7a', '#4ade80', '#fbbf24', '#60a5fa', '#f472b6', '#22d3ee', '#d4d7e0', '#5b6172', '#ff8095', '#86efac', '#fcd34d', '#93c5fd', '#f9a8d4', '#67e8f9', '#ffffff']),
  tokyo: theme('Tokyo Night', true, ['#1a1b26', '#16161e', '#1f2030', '#24283b', '#2f3549', '#c0caf5', '#7a82a8', '#7aa2f7'],
    ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5']),
  catppuccin: theme('Catppuccin', true, ['#1e1e2e', '#181825', '#232334', '#2a2b3c', '#363a4f', '#cdd6f4', '#9399b2', '#cba6f7'],
    ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de', '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8']),
  dracula: theme('Dracula', true, ['#282a36', '#21222c', '#2d2f3d', '#343746', '#44475a', '#f8f8f2', '#a0a4c0', '#ff79c6'],
    ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']),
  rosepine: theme('Rosé Pine', true, ['#191724', '#14121f', '#1f1d2e', '#26233a', '#2f2b45', '#e0def4', '#908caa', '#ebbcba'],
    ['#26233a', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4', '#6e6a86', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4']),
  nord: theme('Nord', true, ['#2e3440', '#292e39', '#323846', '#3b4252', '#434c5e', '#e5e9f0', '#9aa3b5', '#88c0d0'],
    ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']),
  gruvbox: theme('Gruvbox', true, ['#282828', '#1d2021', '#2e2c2b', '#32302f', '#45403d', '#ebdbb2', '#a89984', '#fe8019'],
    ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']),
  onedark: theme('One Dark', true, ['#282c34', '#21252b', '#2c313a', '#323842', '#3e4451', '#abb2bf', '#7f8796', '#61afef'],
    ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf', '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']),
  monokai: theme('Monokai', true, ['#272822', '#1f201b', '#2d2e27', '#34352d', '#49483e', '#f8f8f2', '#a59f85', '#a6e22e'],
    ['#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2', '#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5']),
  solarized: theme('Solarized Dark', true, ['#002b36', '#00252e', '#073642', '#0a3d4a', '#174652', '#93a1a1', '#6c8288', '#268bd2'],
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']),
  paper: theme('Solarized Light', false, ['#fdf6e3', '#f5eedb', '#eee8d5', '#e8e1cc', '#ddd6c1', '#586e75', '#8a9a9c', '#d33682'],
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#93a1a1', '#586e75', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#002b36']),
  daylight: theme('Daylight', false, ['#ffffff', '#f6f7f9', '#f6f7f9', '#eef1f4', '#dde1e6', '#1f2328', '#656d76', '#e0218a'],
    ['#24292f', '#cf222e', '#116329', '#7d4e00', '#0969da', '#8250df', '#1b7c83', '#6e7781', '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f']),
};

const ink = hex => { // black or white text, whichever reads better on this colour
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? '#111' : '#fff';
};

export function applyTheme() {
  const t = THEMES[state.settings.theme] || THEMES.midnight;
  const accent = state.settings.accent || t.ui.accent;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(t.ui)) root.style.setProperty(`--${key}`, value);
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-ink', ink(accent));
  root.style.setProperty('--ok', t.term.green);
  root.style.setProperty('--warn', t.term.yellow);
  root.style.setProperty('--bad', t.term.red);
  root.style.setProperty('--info', t.term.blue);
  root.style.setProperty('--term-bg', t.term.background);
  root.dataset.mode = t.dark ? 'dark' : 'light';
  state.theme = t;
  state.termTheme = { ...t.term, cursor: accent, cursorAccent: t.term.background, selectionBackground: `${accent}55` };
  emit('theme');
}
