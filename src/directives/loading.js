/* v-loading 指令（项目通用）：绑定值为真时给宿主盖白色遮罩 + GitHub 风格转圈圈。
 * 用法：<div v-loading="loading">…</div>
 * 宿主会自动附加 __vl__ 类（卸载时移除），可全局按 .__vl__ 定位。
 * 依赖：宿主有定位（static 时指令自动补 relative）；遮罩样式经 <style> 全局注入一次 */
let styleInjected = false;

function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const s = document.createElement('style');
  s.textContent = `
.v-loading-mask {
  position: absolute;
  inset: 0;
  z-index: 999;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: rgba(255, 255, 255, 1);
}
.v-loading-ring {
  box-sizing: border-box;
  width: 36px;
  height: 36px;
  border: 4px solid rgba(0, 0, 0, 0.12);
  border-top-color: rgba(0, 0, 0, 0.6);
  border-radius: 50%;
  animation: v-loading-spin 0.6s infinite linear;
}
@keyframes v-loading-spin {
  to { transform: rotate(360deg); }
}
`;
  document.head.appendChild(s);
}

function createMask() {
  const mask = document.createElement('div');
  mask.className = 'v-loading-mask';
  const ring = document.createElement('span');
  ring.className = 'v-loading-ring';
  mask.appendChild(ring);
  return mask;
}

function show(el) {
  if (el._loadingMask) return;
  injectStyle();
  if (getComputedStyle(el).position === 'static') {
    el.style.position = 'relative';
    el._loadingPosPatched = true;
  }
  el.appendChild(createMask());
  el._loadingMask = el.lastElementChild;
}

function hide(el) {
  el._loadingMask?.remove();
  el._loadingMask = null;
  if (el._loadingPosPatched) {
    el.style.position = '';
    el._loadingPosPatched = false;
  }
}

export const vLoading = {
  mounted(el, binding) {
    el.classList.add('__vl__'); // 标记使用 v-loading 的元素，便于样式/测试定位
    if (binding.value) show(el);
  },
  updated(el, binding) {
    if (binding.value === binding.oldValue) return;
    binding.value ? show(el) : hide(el);
  },
  unmounted(el) {
    el.classList.remove('__vl__');
    hide(el);
  },
};
