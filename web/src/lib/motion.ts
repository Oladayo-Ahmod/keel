import { animate, stagger } from "animejs";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Cards slide up one after another. With reduced motion they just appear. */
export function enterStaggered(targets: Element[] | NodeListOf<Element>, step = 70) {
  if (!targets.length) return;
  if (prefersReducedMotion()) {
    Array.from(targets).forEach((el) => ((el as HTMLElement).style.opacity = "1"));
    return;
  }
  animate(targets, {
    opacity: [0, 1],
    translateY: [18, 0],
    duration: 520,
    delay: stagger(step),
    ease: "outExpo",
  });
}

/** Tweens a number into an element. `format` turns the in-between value into text. */
export function countTo(
  el: HTMLElement,
  from: number,
  to: number,
  format: (n: number) => string,
  duration = 800,
) {
  if (prefersReducedMotion() || from === to) {
    el.textContent = format(to);
    return;
  }
  const state = { v: from };
  animate(state, {
    v: to,
    duration,
    ease: "outExpo",
    onUpdate: () => {
      el.textContent = format(state.v);
    },
    onComplete: () => {
      el.textContent = format(to);
    },
  });
}

/** Moves an SVG arc to a fraction of its length. */
export function sweepArc(el: SVGPathElement, length: number, fromFraction: number, toFraction: number) {
  const offset = (f: number) => length * (1 - f);
  el.style.strokeDasharray = `${length}`;
  if (prefersReducedMotion()) {
    el.style.strokeDashoffset = `${offset(toFraction)}`;
    return;
  }
  animate(el, {
    strokeDashoffset: [offset(fromFraction), offset(toFraction)],
    duration: 1100,
    ease: "outExpo",
  });
}

/** Small press feedback for buttons. */
export function pressPulse(el: HTMLElement) {
  if (prefersReducedMotion()) return;
  animate(el, { scale: [1, 0.96, 1], duration: 260, ease: "outQuad" });
}

/** A card leaves after its position was handed to someone else. */
export function flyAway(el: HTMLElement, done: () => void) {
  if (prefersReducedMotion()) {
    done();
    return;
  }
  animate(el, {
    translateX: [0, 64],
    translateY: [0, -12],
    rotate: [0, 2],
    opacity: [1, 0],
    duration: 620,
    ease: "inExpo",
    onComplete: done,
  });
}

/** A block fades up when it first appears. With reduced motion it is simply there. */
export function revealIn(el: Element | null) {
  if (!el) return;
  if (prefersReducedMotion()) {
    (el as HTMLElement).style.opacity = "1";
    return;
  }
  animate(el, { opacity: [0, 1], translateY: [8, 0], duration: 380, ease: "outQuad" });
}
