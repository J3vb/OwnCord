import { describe, it, expect, vi } from 'vitest';
import { reconcileList } from '../../src/lib/reconcile';

interface Item {
  id: string;
  label: string;
}

function makeContainer(): HTMLDivElement {
  return document.createElement('div');
}

function makeItem(id: string, label: string): Item {
  return { id, label };
}

function createEl(item: Item): HTMLDivElement {
  const el = document.createElement('div');
  el.textContent = item.label;
  el.setAttribute('data-reconcile-key', item.id);
  return el;
}

function updateEl(el: Element, item: Item): void {
  el.textContent = item.label;
}

function getKeys(container: Element): string[] {
  return Array.from(container.children).map(
    (c) => c.getAttribute('data-reconcile-key') ?? '',
  );
}

describe('reconcileList', () => {
  it('inserts new items into empty container', () => {
    const container = makeContainer();
    const items = [makeItem('a', 'A'), makeItem('b', 'B')];

    reconcileList({
      container,
      items,
      key: (i) => i.id,
      create: createEl,
      update: updateEl,
    });

    expect(container.children.length).toBe(2);
    expect(getKeys(container)).toEqual(['a', 'b']);
    expect(container.children[0]!.textContent).toBe('A');
    expect(container.children[1]!.textContent).toBe('B');
  });

  it('removes deleted items', () => {
    const container = makeContainer();
    const items = [makeItem('a', 'A'), makeItem('b', 'B'), makeItem('c', 'C')];

    reconcileList({
      container,
      items,
      key: (i) => i.id,
      create: createEl,
      update: updateEl,
    });
    expect(container.children.length).toBe(3);

    // Remove 'b'
    reconcileList({
      container,
      items: [makeItem('a', 'A'), makeItem('c', 'C')],
      key: (i) => i.id,
      create: createEl,
      update: updateEl,
    });

    expect(container.children.length).toBe(2);
    expect(getKeys(container)).toEqual(['a', 'c']);
  });

  it('reorders moved items', () => {
    const container = makeContainer();
    const items = [makeItem('a', 'A'), makeItem('b', 'B'), makeItem('c', 'C')];

    reconcileList({
      container,
      items,
      key: (i) => i.id,
      create: createEl,
      update: updateEl,
    });

    // Reverse order
    reconcileList({
      container,
      items: [makeItem('c', 'C'), makeItem('b', 'B'), makeItem('a', 'A')],
      key: (i) => i.id,
      create: createEl,
      update: updateEl,
    });

    expect(getKeys(container)).toEqual(['c', 'b', 'a']);
  });

  it('updates changed items in-place (preserves DOM reference)', () => {
    const container = makeContainer();
    const items = [makeItem('a', 'A'), makeItem('b', 'B')];

    reconcileList({
      container,
      items,
      key: (i) => i.id,
      create: createEl,
      update: updateEl,
    });

    const origA = container.children[0]!;
    const origB = container.children[1]!;

    // Update label for 'a'
    reconcileList({
      container,
      items: [makeItem('a', 'A-updated'), makeItem('b', 'B')],
      key: (i) => i.id,
      create: createEl,
      update: updateEl,
    });

    // SAME DOM elements — not rebuilt
    expect(container.children[0]).toBe(origA);
    expect(container.children[1]).toBe(origB);
    expect(origA.textContent).toBe('A-updated');
  });

  it('handles empty → items', () => {
    const container = makeContainer();

    reconcileList({
      container,
      items: [],
      key: (i: Item) => i.id,
      create: createEl,
      update: updateEl,
    });
    expect(container.children.length).toBe(0);

    reconcileList({
      container,
      items: [makeItem('x', 'X')],
      key: (i) => i.id,
      create: createEl,
      update: updateEl,
    });
    expect(container.children.length).toBe(1);
    expect(getKeys(container)).toEqual(['x']);
  });

  it('handles items → empty', () => {
    const container = makeContainer();

    reconcileList({
      container,
      items: [makeItem('a', 'A'), makeItem('b', 'B')],
      key: (i) => i.id,
      create: createEl,
      update: updateEl,
    });
    expect(container.children.length).toBe(2);

    reconcileList({
      container,
      items: [],
      key: (i: Item) => i.id,
      create: createEl,
      update: updateEl,
    });
    expect(container.children.length).toBe(0);
  });

  it('no-op when identical items', () => {
    const container = makeContainer();
    const items = [makeItem('a', 'A'), makeItem('b', 'B')];
    const createSpy = vi.fn(createEl);

    reconcileList({
      container,
      items,
      key: (i) => i.id,
      create: createSpy,
      update: updateEl,
    });

    const origA = container.children[0]!;
    const origB = container.children[1]!;
    createSpy.mockClear();

    // Same items again
    reconcileList({
      container,
      items: [makeItem('a', 'A'), makeItem('b', 'B')],
      key: (i) => i.id,
      create: createSpy,
      update: updateEl,
    });

    // No new elements created
    expect(createSpy).not.toHaveBeenCalled();
    // Same DOM references
    expect(container.children[0]).toBe(origA);
    expect(container.children[1]).toBe(origB);
  });

  it('handles simultaneous add, remove, and reorder', () => {
    const container = makeContainer();

    reconcileList({
      container,
      items: [makeItem('a', 'A'), makeItem('b', 'B'), makeItem('c', 'C')],
      key: (i) => i.id,
      create: createEl,
      update: updateEl,
    });

    const origC = container.children[2]!;

    // Remove 'a', add 'd', reorder: c, d, b
    reconcileList({
      container,
      items: [makeItem('c', 'C'), makeItem('d', 'D'), makeItem('b', 'B')],
      key: (i) => i.id,
      create: createEl,
      update: updateEl,
    });

    expect(getKeys(container)).toEqual(['c', 'd', 'b']);
    expect(container.children.length).toBe(3);
    // 'c' element preserved
    expect(container.children[0]).toBe(origC);
  });
});
