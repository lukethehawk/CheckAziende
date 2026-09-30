// Tracks the work still useful to the currently displayed company. A new
// lookup invalidates callbacks from an older popup state without cancelling
// the provider requests themselves.
export function createDataCompletionTracker(
  setVisible,
  { delay = 350, setTimer = setTimeout, clearTimer = clearTimeout } = {}
) {
  let generation = 0;
  let shown = false;
  let viewVisible = false;
  let timer = null;
  const pending = new Set();

  function hide() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (shown) {
      shown = false;
      setVisible(false);
    }
  }

  function schedule() {
    if (!viewVisible || !pending.size || shown || timer !== null) return;
    const current = generation;
    timer = setTimer(() => {
      timer = null;
      if (current !== generation || !viewVisible || !pending.size) return;
      shown = true;
      setVisible(true);
    }, delay);
  }

  return {
    reset() {
      generation += 1;
      pending.clear();
      viewVisible = false;
      hide();
      return generation;
    },
    display(current) {
      if (current !== generation) return;
      viewVisible = true;
      schedule();
    },
    hide() {
      viewVisible = false;
      hide();
    },
    track(promise, current) {
      if (!promise || current !== generation || pending.has(promise)) return;
      pending.add(promise);
      schedule();
      const finish = () => {
        if (current !== generation) return;
        pending.delete(promise);
        if (!pending.size) hide();
      };
      Promise.resolve(promise).then(finish, finish);
    }
  };
}

// Track the complete consumer operation, not just the provider Promise:
// nested refresh work must be registered before the parent settles.
export function watchProviderUpdates(result, generation, isCurrent, applyPatch, track) {
  if (!result || !isCurrent()) return;

  for (const { promise } of result.pendingUpdates || []) {
    if (!promise) continue;
    const consumed = Promise.resolve(promise).then((patch) => {
      if (!patch || !isCurrent()) return;
      applyPatch(patch);
      watchProviderUpdates(patch, generation, isCurrent, applyPatch, track);
    });
    track(consumed, generation);
  }
}
