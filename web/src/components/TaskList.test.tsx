import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@tally/shared';
import { TaskList } from './TaskList';

/**
 * What a drag is made of, minus the geometry.
 *
 * jsdom has no layout — every row measures zero — so where a dragged row lands
 * is `lib/reorder.test.ts`'s business and the browser's. What is testable here
 * is the part that decides whether a gesture becomes a drag at all, which is
 * exactly the part that makes a list unscrollable when it is wrong.
 */

const task = (id: string, title: string): Task => ({
  id,
  listId: 'l1',
  title,
  notes: null,
  position: 0,
  completion: null,
});

const TASKS = [
  task('t1', 'Feed the cat'),
  task('t2', 'Empty the dishwasher'),
  task('t3', 'Water the plants'),
];

function mount(over: Partial<Parameters<typeof TaskList>[0]> = {}) {
  const onMove = vi.fn();
  render(
    <TaskList
      tasks={TASKS}
      meId="me"
      timezone="Europe/London"
      onToggle={() => undefined}
      onEdit={() => undefined}
      onMove={onMove}
      {...over}
    />,
  );
  return onMove;
}

const handles = () => screen.queryAllByRole('button', { name: /^Reorder/ });
const grip = () => handles()[0] as HTMLElement;
const lifted = (element: HTMLElement) => element.getAttribute('aria-pressed') === 'true';
const announced = () => screen.getByRole('status').textContent;

/** A finger, as the browser describes one. */
const finger = (clientY: number) => ({
  pointerId: 1,
  pointerType: 'touch',
  clientX: 340,
  clientY,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('who gets a handle', () => {
  it('gives a viewer none, so reordering is not even suggested', () => {
    mount({ onMove: undefined, onEdit: undefined });
    expect(handles()).toHaveLength(0);
  });

  it('gives a list of one none either, there being nowhere to put the row', () => {
    mount({ tasks: [task('t1', 'Feed the cat')] });
    expect(handles()).toHaveLength(0);
  });

  it('names each handle with the place in the list a move would change', () => {
    mount();
    expect(handles().map((handle) => handle.getAttribute('aria-label'))).toEqual([
      'Reorder Feed the cat, 1 of 3',
      'Reorder Empty the dishwasher, 2 of 3',
      'Reorder Water the plants, 3 of 3',
    ]);
  });

  it('tells whoever lands on one how to use it without a pointer', () => {
    mount();
    const hint = document.getElementById(grip().getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toMatch(/arrow keys/i);
  });
});

describe('a finger on the handle', () => {
  it('does not pick anything up while it is moving, because that is a scroll', () => {
    // The failure this whole design is arranged around: a list you cannot
    // scroll because every touch near a handle starts a drag.
    vi.useFakeTimers();
    mount();

    fireEvent.pointerDown(grip(), finger(200));
    fireEvent.pointerMove(grip(), finger(160));
    act(() => vi.advanceTimersByTime(2000));

    expect(lifted(grip())).toBe(false);
    expect(announced()).toBe('');
  });

  it('picks the row up once the finger has stayed put', () => {
    vi.useFakeTimers();
    mount();

    fireEvent.pointerDown(grip(), finger(200));
    expect(lifted(grip())).toBe(false);

    act(() => vi.advanceTimersByTime(400));

    expect(lifted(grip())).toBe(true);
    expect(announced()).toContain('Feed the cat lifted, 1 of 3');
  });

  it('gives up the moment the browser claims the gesture for itself', () => {
    vi.useFakeTimers();
    mount();

    fireEvent.pointerDown(grip(), finger(200));
    fireEvent.pointerCancel(grip(), finger(200));
    act(() => vi.advanceTimersByTime(2000));

    expect(lifted(grip())).toBe(false);
  });

  it('never takes scrolling away from the handle in the first place', () => {
    // `touch-action: none` is the usual way this gets built, and it is why so
    // many lists cannot be scrolled anywhere near their handles.
    mount();
    expect(grip().className).not.toContain('touch-none');
    expect(grip().style.getPropertyValue('touch-action')).toBe('');
  });
});

describe('a mouse on the handle', () => {
  it('picks the row up straight away, having no scroll to be confused with', () => {
    mount();
    fireEvent.pointerDown(grip(), { pointerId: 5, pointerType: 'mouse', button: 0, clientY: 200 });
    expect(lifted(grip())).toBe(true);
  });

  it('moves nothing when it is really just a click', () => {
    const onMove = mount();
    fireEvent.pointerDown(grip(), { pointerId: 5, pointerType: 'mouse', button: 0, clientY: 200 });
    fireEvent.pointerUp(window, { pointerId: 5, pointerType: 'mouse' });

    expect(onMove).not.toHaveBeenCalled();
    expect(lifted(grip())).toBe(false);
  });

  it('ignores the button that opens a context menu', () => {
    mount();
    fireEvent.pointerDown(grip(), { pointerId: 5, pointerType: 'mouse', button: 2, clientY: 200 });
    expect(lifted(grip())).toBe(false);
  });
});

describe('the keyboard alternative', () => {
  it('lifts, moves and drops, saying where the row is at each step', () => {
    const onMove = mount();

    fireEvent.keyDown(grip(), { key: 'Enter' });
    expect(lifted(grip())).toBe(true);
    expect(announced()).toContain('Feed the cat lifted, 1 of 3');

    fireEvent.keyDown(grip(), { key: 'ArrowDown' });
    expect(announced()).toBe('Feed the cat, 2 of 3');
    expect(onMove).not.toHaveBeenCalled();

    fireEvent.keyDown(grip(), { key: 'Enter' });
    expect(onMove).toHaveBeenCalledWith('t1', 1);
    expect(announced()).toBe('Feed the cat dropped, 2 of 3.');
  });

  it('goes to the far end of the list in one press', () => {
    const onMove = mount();
    fireEvent.keyDown(grip(), { key: ' ' });
    fireEvent.keyDown(grip(), { key: 'End' });
    fireEvent.keyDown(grip(), { key: ' ' });
    expect(onMove).toHaveBeenCalledWith('t1', 2);
  });

  it('puts the row back on Escape, and says where back is', () => {
    const onMove = mount();

    fireEvent.keyDown(grip(), { key: 'Enter' });
    fireEvent.keyDown(grip(), { key: 'ArrowDown' });
    fireEvent.keyDown(grip(), { key: 'Escape' });

    expect(onMove).not.toHaveBeenCalled();
    expect(lifted(grip())).toBe(false);
    expect(announced()).toBe('Feed the cat put back, 1 of 3.');
  });

  it('does not wander off the ends of the list', () => {
    const onMove = mount();
    fireEvent.keyDown(grip(), { key: 'Enter' });
    fireEvent.keyDown(grip(), { key: 'ArrowUp' });
    fireEvent.keyDown(grip(), { key: 'Enter' });

    expect(onMove).not.toHaveBeenCalled();
    expect(announced()).toBe('Feed the cat dropped, 1 of 3.');
  });

  it('keeps the move when focus leaves rather than throwing it away', () => {
    // Somebody tabs onward mid-lift. The row is where they put it; losing it
    // silently would be the surprising half of the two options.
    const onMove = mount();
    fireEvent.keyDown(grip(), { key: 'Enter' });
    fireEvent.keyDown(grip(), { key: 'ArrowDown' });
    fireEvent.blur(grip());

    expect(onMove).toHaveBeenCalledWith('t1', 1);
  });
});
