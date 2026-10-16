// The custom cursor: a dot on the pointer and a ring that glides after it, growing over anything clickable.
// Over text (terminals, the editor, inputs, the screenshot canvas) it steps aside so the normal cursor works.
import { state, on } from './ui.js';

const CLICKABLE = 'button, a, select, label.toggle, .card, .wt, .thumb, .theme-card, .tab, .tree-row, .file-row, .block-row, .menu-item, .run-item, .nav-item, [draggable="true"]';
const TEXT = 'input, textarea, [contenteditable], .xterm, .monaco-editor, iframe, canvas';
const EASE = 0.2; // how quickly the ring catches up, per frame

const dot = Object.assign(document.createElement('div'), { className: 'cursor-dot' });
const ring = Object.assign(document.createElement('div'), { className: 'cursor-ring' });
document.body.append(dot, ring);
let x = -100;
let y = -100;
let rx = -100;
let ry = -100;

const motionOk = () => !matchMedia('(prefers-reduced-motion: reduce)').matches && matchMedia('(pointer: fine)').matches;
const apply = () => document.documentElement.classList.toggle('fancy-cursor', state.settings.fancyCursor !== false && motionOk());
on('settings', apply);
apply();

function track(clientX, clientY, target) {
  if (rx < 0) { rx = clientX; ry = clientY; }
  x = clientX;
  y = clientY;
  dot.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  const el = target instanceof Element ? target : null;
  const away = Boolean(el?.closest(TEXT));
  const hover = !away && Boolean(el?.closest(CLICKABLE));
  for (const node of [dot, ring]) {
    node.classList.toggle('away', away);
    node.classList.toggle('hover', hover);
  }
}

addEventListener('pointermove', e => track(e.clientX, e.clientY, e.target), { passive: true });
document.addEventListener('dragover', e => track(e.clientX, e.clientY, e.target)); // pointer events pause while dragging
addEventListener('pointerdown', () => ring.classList.add('press'));
addEventListener('pointerup', () => ring.classList.remove('press'));
document.addEventListener('dragstart', () => ring.classList.add('drag'));
document.addEventListener('dragend', () => ring.classList.remove('drag'));
document.documentElement.addEventListener('mouseleave', () => { dot.classList.add('away'); ring.classList.add('away'); });

(function frame() {
  rx += (x - rx) * EASE;
  ry += (y - ry) * EASE;
  ring.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
  requestAnimationFrame(frame);
})();
