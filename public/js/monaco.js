// Loads the Monaco editor (VS Code's editor) once, and keeps its colours in step with the app theme.
import { state, on } from './ui.js';

let loading;
export function loadMonaco() {
  loading ||= new Promise((resolve, reject) => {
    window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
    window.require(['vs/editor/editor.main'], () => {
      paint();
      on('theme', paint);
      resolve(window.monaco);
    }, reject);
  });
  return loading;
}

function paint() {
  const t = state.theme;
  if (!t || !window.monaco) return;
  window.monaco.editor.defineTheme('desk', {
    base: t.dark ? 'vs-dark' : 'vs', inherit: true, rules: [],
    colors: {
      'editor.background': t.ui.bg, 'editorGutter.background': t.ui.bg, 'minimap.background': t.ui.bg,
      'editor.lineHighlightBackground': t.ui.panel, 'editorWidget.background': t.ui.panel, 'editor.selectionBackground': `${state.settings.accent || t.ui.accent}44`,
      'diffEditor.insertedLineBackground': `${t.term.green}1c`, 'diffEditor.insertedTextBackground': `${t.term.green}38`,
      'diffEditor.removedLineBackground': `${t.term.red}1c`, 'diffEditor.removedTextBackground': `${t.term.red}38`,
      'diffEditorGutter.insertedLineBackground': `${t.term.green}2a`, 'diffEditorGutter.removedLineBackground': `${t.term.red}2a`,
    },
  });
  window.monaco.editor.setTheme('desk');
}

export const editorOptions = () => ({
  theme: 'desk', automaticLayout: true, fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
  fontSize: Number(state.settings.fontSize) || 13, minimap: { enabled: true, scale: 1 }, smoothScrolling: true,
  scrollBeyondLastLine: false, padding: { top: 12 }, renderLineHighlight: 'all', cursorBlinking: 'smooth',
});
