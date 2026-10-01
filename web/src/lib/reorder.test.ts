import { describe, expect, it } from 'vitest';
import {
  anchorsAround,
  clampTop,
  dropIndex,
  edgeScrollDelta,
  keyboardTarget,
  moveWithin,
  orderBy,
  shiftsFor,
  type RowBox,
} from './reorder';

/** Row heights and the 8px `gap-2` between them, as the task column lays out. */
const GAP = 8;

/** A column of rows starting 100px down, so nothing passes by treating top as 0. */
function column(...heights: number[]): RowBox[] {
  let top = 100;
  return heights.map((height) => {
    const box = { top, height };
    top += height + GAP;
    return box;
  });
}

/** Four equal rows: 100, 168, 236, 304. */
const EVEN = column(60, 60, 60, 60);

const letters = ['a', 'b', 'c', 'd'];

describe('moveWithin', () => {
  it('moves a row down the list', () => {
    expect(moveWithin(letters, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves a row up the list', () => {
    expect(moveWithin(letters, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('takes the row out before putting it back, so the last slot is reachable', () => {
    // With the row still in place, index 3 of four would mean "before d" rather
    // than "after d", and nothing could ever be dragged to the bottom.
    expect(moveWithin(letters, 1, 3)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('leaves the list alone when the row lands where it started', () => {
    expect(moveWithin(letters, 2, 2)).toEqual(letters);
  });

  it('does not touch the array it was given', () => {
    const original = [...letters];
    moveWithin(original, 0, 3);
    expect(original).toEqual(letters);
  });
});

describe('orderBy', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('puts the items back into the order the ids name', () => {
    expect(orderBy(items, ['c', 'a', 'b']).map((item) => item.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps an item the ids have never heard of, at the end', () => {
    // A task added by somebody else between the drag and the failure that undoes
    // it. Dropping it would delete a real row from the screen.
    expect(orderBy([...items, { id: 'new' }], ['c', 'b', 'a']).map((item) => item.id)).toEqual([
      'c',
      'b',
      'a',
      'new',
    ]);
  });

  it('leaves two unknown items in the order they arrived in', () => {
    expect(orderBy([{ id: 'x' }, { id: 'y' }], []).map((item) => item.id)).toEqual(['x', 'y']);
  });
});

describe('anchorsAround', () => {
  it('names the tasks either side of the slot', () => {
    // Both, so the server can tell that this device's copy of the order is stale
    // rather than trusting a neighbour that has since moved.
    expect(anchorsAround(letters, 'b')).toEqual({ after: 'a', before: 'c' });
  });

  it('has nothing above the first slot', () => {
    expect(anchorsAround(letters, 'a')).toEqual({ after: null, before: 'b' });
  });

  it('has nothing below the last slot', () => {
    expect(anchorsAround(letters, 'd')).toEqual({ after: 'c', before: null });
  });

  it('refuses a list of one, which has no slot to describe', () => {
    expect(anchorsAround(['a'], 'a')).toBeNull();
  });

  it('refuses a task that is not in the list', () => {
    expect(anchorsAround(letters, 'z')).toBeNull();
  });
});

describe('dropIndex', () => {
  it('is where the row started when it has not moved', () => {
    expect(dropIndex(EVEN, 1, EVEN[1]!.top)).toBe(1);
  });

  it('waits for the dragged middle to reach the next row’s middle', () => {
    // A whole slot of travel before anything swaps: half of that and the row
    // would trade places with its neighbour on the smallest wobble.
    expect(dropIndex(EVEN, 1, EVEN[1]!.top + 67)).toBe(1);
    expect(dropIndex(EVEN, 1, EVEN[1]!.top + 69)).toBe(2);
  });

  it('takes the top slot once the row is clear of the first one', () => {
    expect(dropIndex(EVEN, 3, EVEN[0]!.top + 2)).toBe(1);
    expect(dropIndex(EVEN, 3, EVEN[0]!.top)).toBe(0);
  });

  it('never points past the end of the list', () => {
    expect(dropIndex(EVEN, 0, 5000)).toBe(3);
  });

  it('measures against each row’s own middle, not a uniform height', () => {
    // A done row carries an attribution line and is taller than the rest.
    const mixed = column(60, 120, 60);
    expect(dropIndex(mixed, 0, 160)).toBe(0);
    expect(dropIndex(mixed, 0, 200)).toBe(1);
  });

  it('leaves a row it cannot find where it is', () => {
    expect(dropIndex(EVEN, 9, 0)).toBe(9);
  });
});

describe('shiftsFor', () => {
  it('moves nothing when the row lands where it started', () => {
    expect(shiftsFor(EVEN, 1, 1)).toEqual([0, 0, 0, 0]);
  });

  it('lifts the rows the dragged row passes, by its height and the gap', () => {
    expect(shiftsFor(EVEN, 1, 2)).toEqual([0, 68, -68, 0]);
  });

  it('drops the rows a row moving up displaces', () => {
    expect(shiftsFor(EVEN, 3, 1)).toEqual([0, 68, 68, -136]);
  });

  it('carries the dragged row to its slot too, since a keyboard move has no finger', () => {
    const shifts = shiftsFor(EVEN, 0, 3);
    expect(EVEN[0]!.top + shifts[0]!).toBe(EVEN[3]!.top);
  });

  it('stacks rows of different heights without leaving a hole', () => {
    // Every row's new top is what is above it, so a tall done row moving out of
    // the middle closes the space it leaves exactly.
    const mixed = column(60, 120, 60);
    const shifts = shiftsFor(mixed, 1, 2);
    const tops = mixed.map((row, index) => row.top + shifts[index]!);
    expect(tops).toEqual([100, 236, 168]);
  });

  it('has nothing to say about an empty column', () => {
    expect(shiftsFor([], 0, 0)).toEqual([]);
  });
});

describe('clampTop', () => {
  it('leaves a row inside the column alone', () => {
    expect(clampTop(EVEN, 1, 200)).toBe(200);
  });

  it('will not let a row go above the first slot', () => {
    expect(clampTop(EVEN, 2, -400)).toBe(100);
  });

  it('will not let a row go below the last slot', () => {
    expect(clampTop(EVEN, 0, 5000)).toBe(304);
  });
});

describe('keyboardTarget', () => {
  it('steps one row at a time', () => {
    expect(keyboardTarget(2, 'ArrowUp', 5)).toBe(1);
    expect(keyboardTarget(2, 'ArrowDown', 5)).toBe(3);
  });

  it('goes to the top and the bottom in one press', () => {
    expect(keyboardTarget(2, 'Home', 5)).toBe(0);
    expect(keyboardTarget(2, 'End', 5)).toBe(4);
  });

  it('stays put at the ends rather than wrapping around', () => {
    expect(keyboardTarget(0, 'ArrowUp', 5)).toBeNull();
    expect(keyboardTarget(4, 'ArrowDown', 5)).toBeNull();
    expect(keyboardTarget(0, 'Home', 5)).toBeNull();
    expect(keyboardTarget(4, 'End', 5)).toBeNull();
  });

  it('ignores every other key, so typing elsewhere is never a move', () => {
    expect(keyboardTarget(2, 'ArrowLeft', 5)).toBeNull();
    expect(keyboardTarget(2, 'k', 5)).toBeNull();
  });
});

describe('edgeScrollDelta', () => {
  it('scrolls nothing while the finger is away from either edge', () => {
    expect(edgeScrollDelta(400, 100, 700)).toBe(0);
  });

  it('scrolls up near the top and down near the bottom', () => {
    expect(edgeScrollDelta(120, 100, 700)).toBeLessThan(0);
    expect(edgeScrollDelta(680, 100, 700)).toBeGreaterThan(0);
  });

  it('goes faster the closer to the edge the finger gets', () => {
    const near = edgeScrollDelta(105, 100, 700);
    const far = edgeScrollDelta(150, 100, 700);
    expect(Math.abs(near)).toBeGreaterThan(Math.abs(far));
  });

  it('does not run away when the finger leaves the column altogether', () => {
    expect(edgeScrollDelta(-2000, 100, 700)).toBe(edgeScrollDelta(100, 100, 700));
    expect(edgeScrollDelta(5000, 100, 700)).toBe(edgeScrollDelta(700, 100, 700));
  });
});
