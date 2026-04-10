export const _ = (selector) => document.querySelector(selector);
export const _all = (selector) => document.querySelectorAll(selector);
export const show = (selector) => _(selector)?.classList.remove('hidden');
export const hide = (selector) => _(selector)?.classList.add('hidden');

export function resizeGivenCanvas(canvas, pad) {
    if (!canvas || !canvas.parentElement.offsetParent) return;
    // CSS 크기와 canvas 내부 해상도를 일치시켜 마우스 오차 제거
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    if (pad) pad.clear();
}