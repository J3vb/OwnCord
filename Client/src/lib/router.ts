// Router — simple page router for desktop SPA (no URL routing).
// Tracks current page and notifies listeners. Does NOT manipulate the DOM.

export type PageId = "connect" | "main";

export type NavigateListener = (page: PageId) => void;

export interface Router {
  /** Navigate to a page. Notifies all listeners if the page changed. */
  navigate(page: PageId): void;

  /** Returns the currently active page. */
  getCurrentPage(): PageId;

  /**
   * Register a listener that fires when the page changes.
   * Returns an unsubscribe function.
   */
  onNavigate(listener: NavigateListener): () => void;
}

/**
 * Create a new router instance.
 * @param initialPage - The page to start on (defaults to "connect").
 */
export function createRouter(initialPage: PageId = "connect"): Router {
  let currentPage: PageId = initialPage;
  const listeners: Set<NavigateListener> = new Set();

  function navigate(page: PageId): void {
    if (page === currentPage) {
      return;
    }
    currentPage = page;
    for (const listener of listeners) {
      listener(page);
    }
  }

  function getCurrentPage(): PageId {
    return currentPage;
  }

  function onNavigate(listener: NavigateListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { navigate, getCurrentPage, onNavigate };
}
