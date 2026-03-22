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
});
