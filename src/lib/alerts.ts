/**
 * Simple alert bus. When something in Alpha needs the user's attention
 * (a reminder fires, a background scan flags news, etc.) call
 * `alertBus.pulse()`. The KITT scanner subscribes and flips to its
 * fast/aggressive alert animation for a few seconds.
 */
type Fn = (on: boolean) => void;

const listeners = new Set<Fn>();

export const alertBus = {
  sub(fn: Fn) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  pulse() {
    listeners.forEach((fn) => fn(true));
    // The scanner auto-clears itself after ~6s; also emit an explicit off.
    setTimeout(() => listeners.forEach((fn) => fn(false)), 6000);
  },
};
