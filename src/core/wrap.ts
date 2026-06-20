// Small shared numeric helper for the cyclic-state cellular automata.

/**
 * Fold an integer into the state ring [0, states), handling negatives. Used by
 * the multi-state systems (Generations, Wireworld, Cyclic) to keep a painted or
 * stamped value a valid state index.
 */
export function wrapState(v: number, states: number): number {
  let s = v % states;
  if (s < 0) s += states;
  return s;
}
