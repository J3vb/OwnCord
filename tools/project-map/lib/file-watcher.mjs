/**
 * File watcher + SSE auto-refresh.
 * Watches key directories and notifies connected SSE clients on changes.
 */
import { watch } from 'node:fs';
import { resolve } from 'node:path';

export function createFileWatcher(root, onChangeCallback) {
  const watchDirs = [
    resolve(root, 'Server'),
    resolve(root, 'Client/tauri-client/src'),
    resolve(root, 'Client/tauri-client/src-tauri/src'),
    resolve(root, 'docs/brain'),
  ];

  // Debounce: only fire callback once per 2 seconds
  let debounceTimer = null;
  let destroyed = false;
  const debounceMs = 2000;

  function handleChange(eventType, filename) {
    if (destroyed) return;

    // Ignore non-source files
    if (filename && (
      filename.includes('node_modules') ||
      filename.includes('.git') ||
      filename.includes('dist') ||
      filename.includes('target') ||
      filename.endsWith('.swp') ||
      filename.endsWith('~')
    )) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (destroyed) return;
      try {
        onChangeCallback({ eventType, filename, timestamp: new Date().toISOString() });
      } catch (err) {
        console.error('[Watch] callback error:', err.message);
      }
    }, debounceMs);
  }

  const watchers = [];
  for (const dir of watchDirs) {
    try {
      const w = watch(dir, { recursive: true }, handleChange);
      watchers.push(w);
    } catch {
      // Directory might not exist — skip silently
    }
  }

  return {
    close() {
      destroyed = true;
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      for (const w of watchers) {
        try { w.close(); } catch { /* ignore */ }
      }
    },
  };
}

/**
 * SSE (Server-Sent Events) manager.
 * Maintains a list of connected clients and broadcasts events to all.
 */
export function createSSEManager() {
  const clients = new Set();

  const heartbeatInterval = setInterval(() => {
    for (const client of clients) {
      try { client.write(': ping\n\n'); } catch { clients.delete(client); }
    }
  }, 30000);

  function handleConnection(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial connected event
    res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

    clients.add(res);

    req.on('close', () => {
      clients.delete(res);
    });
  }

  function broadcast(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      try { client.write(data); } catch { clients.delete(client); }
    }
  }

  function close() {
    clearInterval(heartbeatInterval);
    for (const client of clients) {
      try { client.end(); } catch { /* ignore */ }
    }
    clients.clear();
  }

  // Safety net: clean up on process exit to prevent leaked intervals
  process.on('exit', () => { clearInterval(heartbeatInterval); });

  return { handleConnection, broadcast, close, get clientCount() { return clients.size; } };
}
