/*
 * Animata Fluid Tabs — vanilla adaptation for SkateLens.
 * Copyright (c) Animata. MIT License: upstream/animata/LICENSE.md.
 * Upstream revision: 25c27e5a874c60a56dcc1609df3b2c4f5f8456f8.
 * Adapted from animata/tabs/fluid-tabs.tsx and animata/tabs/shared.ts.
 */

// Original Animata motion values, shared by the sliding surface and label.
export const INDICATOR_SPRING = Object.freeze({ stiffness: 380, damping: 34, mass: 0.75 });
export const LABEL_TRANSITION = Object.freeze({ duration: 0.28, ease: [0.32, 0.72, 0, 1] });

// Convert the upstream spring to browser-native keyframes, without a runtime package.
function springProgress(time) {
  const { stiffness, damping, mass } = INDICATOR_SPRING;
  const root = Math.sqrt(damping * damping - 4 * mass * stiffness);
  const a = (-damping + root) / (2 * mass);
  const b = (-damping - root) / (2 * mass);
  return 1 - (b * Math.exp(a * time) - a * Math.exp(b * time)) / (b - a);
}

const SPRING_DURATION = 480;
const SPRING_SAMPLES = 32;

function springFrames(from, to) {
  return Array.from({ length: SPRING_SAMPLES + 1 }, (_, index) => {
    const offset = index / SPRING_SAMPLES;
    const progress = index === SPRING_SAMPLES ? 1 : springProgress(offset * SPRING_DURATION / 1000);
    const lerp = (key) => from[key] + (to[key] - from[key]) * progress;
    return {
      offset,
      transform: `translate(${lerp('x')}px, ${lerp('y')}px)`,
      width: `${lerp('width')}px`,
      height: `${lerp('height')}px`,
    };
  });
}

/**
 * Enhances an existing tablist. Application code remains the owner of selection:
 * click handlers set aria-selected, and this component follows that state.
 * Returns a cleanup function. No network, dependencies, or generated stylesheets.
 */
export function enhanceFluidTabs(tablist) {
  if (!tablist || tablist.dataset.fluidReady !== undefined) return () => {};
  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'))
    .filter((tab) => tab.closest('[role="tablist"]') === tablist);
  if (!tabs.length) return () => {};

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const indicator = document.createElement('span');
  indicator.className = 'fluid-tab-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  tablist.prepend(indicator);
  tablist.classList.add('animata-fluid-tabs');

  const labels = tabs.map((tab) => {
    const label = document.createElement('span');
    label.className = 'fluid-tab-label';
    while (tab.firstChild) label.append(tab.firstChild);
    tab.append(label);
    return label;
  });
  const previousTabIndexes = tabs.map((tab) => tab.getAttribute('tabindex'));
  let selected = null;
  let animation = null;
  let lastFrame = null;
  let scheduled = 0;

  function bounds(element) {
    const box = element.getBoundingClientRect();
    const list = tablist.getBoundingClientRect();
    return {
      x: box.left - list.left - tablist.clientLeft + tablist.scrollLeft,
      y: box.top - list.top - tablist.clientTop + tablist.scrollTop,
      width: box.width,
      height: box.height,
    };
  }

  function sync(animate = true) {
    const active = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
    if (!active) return;
    const next = bounds(active);
    if (!next.width || !next.height) return;
    const changed = active !== selected;
    const from = animation && animation.playState === 'running' ? bounds(indicator) : lastFrame;
    animation?.cancel();
    animation = null;
    Object.assign(indicator.style, {
      transform: `translate(${next.x}px, ${next.y}px)`,
      width: `${next.width}px`,
      height: `${next.height}px`,
    });
    tabs.forEach((tab) => { tab.tabIndex = tab === active ? 0 : -1; });
    tablist.dataset.fluidReady = '';
    if (animate && changed && from && !reducedMotion.matches && typeof indicator.animate === 'function') {
      animation = indicator.animate(springFrames(from, next), {
        duration: SPRING_DURATION,
        easing: 'linear',
      });
    }
    selected = active;
    lastFrame = next;
  }

  // Ported from Animata's shared.ts: manual activation with wrapping arrow keys.
  function onKeyDown(event) {
    if (event.defaultPrevented) return;
    const enabledTabs = tabs.filter((tab) => !tab.disabled && tab.getAttribute('aria-disabled') !== 'true');
    const count = enabledTabs.length;
    const currentTab = event.target.closest('[role="tab"]');
    const currentIndex = enabledTabs.indexOf(currentTab);
    if (currentIndex === -1 || count < 1) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      currentTab.click();
      return;
    }
    if (count < 2) return;
    let next;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown': next = (currentIndex + 1) % count; break;
      case 'ArrowLeft':
      case 'ArrowUp': next = (currentIndex - 1 + count) % count; break;
      case 'Home': next = 0; break;
      case 'End': next = count - 1; break;
      default: return;
    }
    event.preventDefault();
    queueMicrotask(() => enabledTabs[next]?.focus());
  }

  function scheduleSync() {
    cancelAnimationFrame(scheduled);
    scheduled = requestAnimationFrame(() => sync());
  }
  const mutation = new MutationObserver(scheduleSync);
  mutation.observe(tablist, { subtree: true, attributes: true, attributeFilter: ['aria-selected'] });
  const resize = new ResizeObserver(() => sync(false));
  resize.observe(tablist);
  tabs.forEach((tab) => resize.observe(tab));
  tablist.addEventListener('keydown', onKeyDown);
  const onMotionChange = () => sync(false);
  reducedMotion.addEventListener('change', onMotionChange);
  sync(false);

  return () => {
    cancelAnimationFrame(scheduled);
    animation?.cancel();
    mutation.disconnect();
    resize.disconnect();
    tablist.removeEventListener('keydown', onKeyDown);
    reducedMotion.removeEventListener('change', onMotionChange);
    tabs.forEach((tab, index) => {
      const label = labels[index];
      while (label.firstChild) tab.insertBefore(label.firstChild, label);
      label.remove();
      if (previousTabIndexes[index] === null) tab.removeAttribute('tabindex');
      else tab.setAttribute('tabindex', previousTabIndexes[index]);
    });
    indicator.remove();
    delete tablist.dataset.fluidReady;
  };
}
