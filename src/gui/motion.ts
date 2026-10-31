/**
 * Script animations shared by the GUI modules. Script animations, unlike CSS ones, do not restart when `render`
 * re-inserts an element, so only the event that changed an element animates it.
 */

/** Honors the user's reduced-motion setting; every helper here skips its animation when it is set. */
export const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const POP = [{ opacity: 0, transform: 'scale(.92)' }, {}];

/** Pops `el` in once. */
export const appear = (el: Element) => { if (!still()) el.animate(POP, { duration: 160, easing: 'ease-out' }); };

// Elements fading out: still visible (`hidden` is set when the fade ends), but logically hidden
const leaving = new WeakMap<HTMLElement, Animation>();

/**
 * Shows or hides `el` (toggles when `on` is omitted). Popping in happens only on a hidden-to-shown change, since
 * input events call this per keystroke; hiding fades out first. Reversing mid-fade cancels the fade.
 */
export function show(el: HTMLElement, on = el.hidden || leaving.has(el)) {
  const out = leaving.get(el);
  if (on) {
    if (out) { out.cancel(); leaving.delete(el); appear(el); }
    else if (el.hidden) { el.hidden = false; appear(el); }
    return;
  }
  if (el.hidden || out) return;
  if (still()) { el.hidden = true; return; }
  const a = el.animate([{}, POP[0]], { duration: 120, easing: 'ease-in', fill: 'forwards' });
  leaving.set(el, a);
  // `cancel` (a reversal) never fires `finish`, so this runs only for a fade that completed
  a.onfinish = () => { leaving.delete(el); el.hidden = true; a.cancel(); };
}
