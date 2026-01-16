export const _ = (selector) => document.querySelector(selector);
export const _all = (selector) => document.querySelectorAll(selector);
export const show = (selector) => _(selector)?.classList.remove('hidden');
export const hide = (selector) => _(selector)?.classList.add('hidden');

export function resizeGivenCanvas(canvas, pad) {
    if (!canvas || !canvas.parentElement.offsetParent) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext("2d").scale(ratio, ratio);
    if (pad) pad.clear();
}