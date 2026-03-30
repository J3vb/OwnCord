import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { showContextMenu } from '../../src/lib/context-menu';

describe('showContextMenu', () => {
  let ac: AbortController;

  beforeEach(() => {
    ac = new AbortController();
    // Clean up any leftover menus
    document.querySelectorAll('.context-menu').forEach((el) => el.remove());
  });

  afterEach(() => {
    ac.abort();
    document.querySelectorAll('.context-menu').forEach((el) => el.remove());
  });

  it('renders menu at correct position', () => {
    showContextMenu({
      x: 100,
      y: 200,
      items: [{ label: 'Test', onClick: vi.fn() }],
      signal: ac.signal,
    });

    const menu = document.querySelector('.context-menu') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.style.left).toBe('100px');
    expect(menu.style.top).toBe('200px');
  });

  it('renders all items', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        { label: 'Edit', onClick: vi.fn() },
        { label: 'Delete', onClick: vi.fn(), danger: true },
      ],
      signal: ac.signal,
    });

    const items = document.querySelectorAll('.context-menu-item');
    expect(items.length).toBe(2);
    expect(items[0]!.textContent).toBe('Edit');
    expect(items[1]!.textContent).toBe('Delete');
  });

  it('fires onClick when item clicked', () => {
    const onClick = vi.fn();
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: 'Action', onClick }],
      signal: ac.signal,
    });

    const item = document.querySelector('.context-menu-item') as HTMLElement;
    item.click();

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('removes menu after item click', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: 'Action', onClick: vi.fn() }],
      signal: ac.signal,
    });

    const item = document.querySelector('.context-menu-item') as HTMLElement;
    item.click();

    expect(document.querySelector('.context-menu')).toBeNull();
  });

  it('applies danger class to danger items', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: 'Delete', onClick: vi.fn(), danger: true }],
      signal: ac.signal,
    });

    const item = document.querySelector('.context-menu-item') as HTMLElement;
    expect(item.classList.contains('danger')).toBe(true);
  });

  it('applies testId to items', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: 'Edit', onClick: vi.fn(), testId: 'ctx-edit' }],
      signal: ac.signal,
    });

    const item = document.querySelector('[data-testid="ctx-edit"]');
    expect(item).not.toBeNull();
  });

  it('removes menu on AbortSignal abort', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: 'Test', onClick: vi.fn() }],
      signal: ac.signal,
    });

    expect(document.querySelector('.context-menu')).not.toBeNull();

    ac.abort();

    expect(document.querySelector('.context-menu')).toBeNull();
  });

  it('removes existing menu with same className before showing new one', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: 'First', onClick: vi.fn() }],
      signal: ac.signal,
      className: 'my-menu',
    });

    showContextMenu({
      x: 50,
      y: 50,
      items: [{ label: 'Second', onClick: vi.fn() }],
      signal: ac.signal,
      className: 'my-menu',
    });

    const menus = document.querySelectorAll('.my-menu');
    expect(menus.length).toBe(1);
    expect(menus[0]!.querySelector('.context-menu-item')!.textContent).toBe('Second');
  });

  it('uses default className "context-menu" when none specified', () => {
    showContextMenu({
      x: 10,
      y: 20,
      items: [{ label: 'Default', onClick: vi.fn() }],
      signal: ac.signal,
    });

    const menu = document.querySelector('.context-menu') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.classList.contains('context-menu')).toBe(true);
  });

  it('adds separator before danger item when preceded by non-danger item', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        { label: 'Edit', onClick: vi.fn() },
        { label: 'Delete', onClick: vi.fn(), danger: true },
      ],
      signal: ac.signal,
    });

    const menu = document.querySelector('.context-menu') as HTMLElement;
    const sep = menu.querySelector('.context-menu-sep');
    expect(sep).not.toBeNull();
  });

  it('does not add separator when danger item is first', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        { label: 'Delete', onClick: vi.fn(), danger: true },
      ],
      signal: ac.signal,
    });

    const menu = document.querySelector('.context-menu') as HTMLElement;
    const sep = menu.querySelector('.context-menu-sep');
    expect(sep).toBeNull();
  });

  it('does not add separator between consecutive danger items', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        { label: 'Delete', onClick: vi.fn(), danger: true },
        { label: 'Ban', onClick: vi.fn(), danger: true },
      ],
      signal: ac.signal,
    });

    const menu = document.querySelector('.context-menu') as HTMLElement;
    const seps = menu.querySelectorAll('.context-menu-sep');
    expect(seps.length).toBe(0);
  });

  it('handles multiple non-danger items without separator', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        { label: 'Copy', onClick: vi.fn() },
        { label: 'Edit', onClick: vi.fn() },
        { label: 'Reply', onClick: vi.fn() },
      ],
      signal: ac.signal,
    });

    const menu = document.querySelector('.context-menu') as HTMLElement;
    const seps = menu.querySelectorAll('.context-menu-sep');
    expect(seps.length).toBe(0);
  });

  it('closes menu on click outside (mousedown)', async () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: 'Test', onClick: vi.fn() }],
      signal: ac.signal,
    });

    expect(document.querySelector('.context-menu')).not.toBeNull();

    // Trigger the deferred mousedown listener (needs setTimeout to fire first)
    await vi.waitFor(() => {
      // Simulate a click outside the menu
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(document.querySelector('.context-menu')).toBeNull();
    });
  });

  it('does not close menu on mousedown inside the menu', async () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: 'Test', onClick: vi.fn() }],
      signal: ac.signal,
    });

    const menu = document.querySelector('.context-menu') as HTMLElement;
    expect(menu).not.toBeNull();

    // Wait for the deferred listener to register
    await new Promise((r) => setTimeout(r, 10));

    // Mousedown inside the menu should NOT close it
    const item = menu.querySelector('.context-menu-item') as HTMLElement;
    const event = new MouseEvent('mousedown', { bubbles: true });
    Object.defineProperty(event, 'target', { value: item });
    document.dispatchEvent(event);

    expect(document.querySelector('.context-menu')).not.toBeNull();
  });

  it('handles empty items list', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [],
      signal: ac.signal,
    });

    const menu = document.querySelector('.context-menu') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.querySelectorAll('.context-menu-item').length).toBe(0);
  });

  it('clicking one item does not affect other items', () => {
    const onClick1 = vi.fn();
    const onClick2 = vi.fn();
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        { label: 'Action1', onClick: onClick1 },
        { label: 'Action2', onClick: onClick2 },
      ],
      signal: ac.signal,
    });

    const items = document.querySelectorAll('.context-menu-item');
    (items[0] as HTMLElement).click();

    expect(onClick1).toHaveBeenCalledTimes(1);
    expect(onClick2).not.toHaveBeenCalled();
  });

  it('handles non-danger item followed by danger item with separator', () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        { label: 'Copy', onClick: vi.fn() },
        { label: 'Edit', onClick: vi.fn() },
        { label: 'Delete', onClick: vi.fn(), danger: true },
      ],
      signal: ac.signal,
    });

    const menu = document.querySelector('.context-menu') as HTMLElement;
    const children = Array.from(menu.children);
    // Should have: Copy, Edit, separator, Delete
    expect(children.length).toBe(4);
    expect(children[2]!.classList.contains('context-menu-sep')).toBe(true);
  });

  it('menu is appended to document.body', () => {
    showContextMenu({
      x: 100,
      y: 200,
      items: [{ label: 'Appended', onClick: vi.fn() }],
      signal: ac.signal,
    });

    const menu = document.body.querySelector('.context-menu');
    expect(menu).not.toBeNull();
  });
});
