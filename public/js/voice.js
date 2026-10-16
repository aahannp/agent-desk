// Voice input: talk, and the words go into whatever you last focused (a terminal or a text box).
// The Mac app uses on-device macOS speech; in Chrome it uses the browser's speech recognition.
// End with "send" to press Enter. It stops by itself after a short pause.
import { state, api, h, icon, on, toast, actions, command } from './ui.js';

const SEND = /[\s,.]*\b(send|submit|send it|press enter)[.!]?$/i;
const PAUSE_MS = 2200;
let listening = false;
let target = null;
let rec = null;
let heard = '';
let finalText = '';
let quiet = null;

// Remember the last place you were typing, before the voice button takes focus.
document.addEventListener('focusin', e => {
  const el = e.target;
  if (el.closest?.('.voice-pill, .voice-btn, .palette')) return;
  if (el.classList?.contains('xterm-helper-textarea')) target = { session: el.closest('.pane')?.dataset.id };
  else if (el.matches?.('textarea, input:not([type=checkbox]):not([type=color]):not([type=range]):not([type=file])')) target = { el };
});

actions.toggleVoice = () => (listening ? stop() : start());
command('Toggle voice input', () => actions.toggleVoice(), { icon: 'mic', sub: '⌘⇧M' });

async function start() {
  if (!target && actions.focusedSession()) target = { session: actions.focusedSession() };
  heard = '';
  finalText = '';
  try {
    if (state.info.voice) {
      await api('POST', '/api/voice/start', { lang: state.settings.voiceLang });
    } else if (window.SpeechRecognition || window.webkitSpeechRecognition) {
      browserRecognition();
    } else {
      throw new Error('Voice works in the Agent Desk Mac app and in Chrome. You can also use macOS Dictation: press the microphone key, or Fn twice, while a terminal is focused.');
    }
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  listening = true;
  render();
}

function stop() {
  if (!listening) return;
  clearTimeout(quiet);
  if (state.info.voice) api('POST', '/api/voice/stop').catch(() => {});
  else rec?.stop();
}

function browserRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  rec = new Recognition();
  rec.lang = state.settings.voiceLang || 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    hear(finalText + interim);
  };
  rec.onerror = e => e.error !== 'no-speech' && e.error !== 'aborted' && toast(`Voice: ${e.error}`, 'error');
  rec.onend = () => finish(finalText || heard);
  rec.start();
}

// Native helper events arrive over the server's event stream.
on('voice', event => {
  if (event.error) toast(`Voice: ${event.error}`, 'error');
  else if (event.final) finish(event.text);
  else if (event.stopped) finish(heard);
  else if (event.text !== undefined) hear(event.text);
});

function hear(text) {
  heard = text;
  render();
  clearTimeout(quiet);
  if (text.trim()) quiet = setTimeout(stop, PAUSE_MS);
}

function finish(text) {
  if (!listening) return;
  listening = false;
  clearTimeout(quiet);
  rec = null;
  render();
  deliver(text || '');
}

function deliver(raw) {
  let text = raw.trim();
  if (!text) return;
  const submit = SEND.test(text);
  if (submit) text = text.replace(SEND, '').trim();
  if (target?.session && actions.typeInto(target.session, submit ? text : `${text} `, submit)) return actions.focusSession(target.session);
  if (target?.el?.isConnected) {
    const el = target.el;
    el.focus();
    const startAt = el.selectionStart ?? el.value.length;
    const gap = startAt > 0 && !/\s$/.test(el.value.slice(0, startAt)) ? ' ' : '';
    el.setRangeText(gap + text, startAt, el.selectionEnd ?? startAt, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (submit) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return;
  }
  navigator.clipboard.writeText(text);
  toast('Nothing was focused, so what you said is on the clipboard.', 'info');
}

function render() {
  const btn = document.getElementById('voiceBtn');
  const pill = document.getElementById('voicePill');
  btn?.classList.toggle('live', listening);
  pill.hidden = !listening;
  if (!listening) return;
  const where = target?.session ? state.sessions.find(s => s.id === target.session)?.name : target?.el ? 'the text box' : 'the clipboard';
  pill.replaceChildren(
    h('span', { class: 'bars' }, h('i'), h('i'), h('i'), h('i'), h('i')),
    h('span', { class: `said${heard ? '' : ' placeholder'}` }, heard ? `\u200E${heard}\u200E` : `Listening… speaking into ${where || 'the focused pane'}. End with “send” to press Enter.`),
    h('button', { class: 'btn sm', onClick: stop }, icon('stop', 12), 'Done'));
}
