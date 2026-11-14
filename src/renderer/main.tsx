import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Talks to the local Manga Tracker server this page was loaded from.
const listeners = new Set<(s: unknown) => void>();
let events: EventSource | undefined;
window.api = {
  async call(name, ...args) {
    if (name === 'openExternal') {
      if (/^https?:\/\//i.test(String(args[0]))) window.open(String(args[0]), '_blank', 'noopener');
      return;
    }
    const res = await fetch('/api/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args }),
    });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error);
    if (name === 'exportCsv') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([out.result], { type: 'text/csv' }));
      a.download = 'manga-library.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      return;
    }
    return out.result;
  },
  onState(cb) {
    listeners.add(cb as (s: unknown) => void);
    if (!events) {
      events = new EventSource('/api/events');
      events.onmessage = (e) => listeners.forEach((l) => l(JSON.parse(e.data)));
    }
  },
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
