export const CATEGORIES = ['Feature', 'Bug Fix', 'Meeting', 'Review', 'Research', 'Other'];

export const STATUSES = [
  { value: 'done',        label: 'Done' },
  { value: 'in-progress', label: 'In Progress' },
  { value: 'next-week',   label: 'Next Week' },
  { value: 'blocker',     label: 'Blocker' },
  { value: 'achievement', label: 'Achievement' }
];

class WorklogStore {
  entries = $state([]);
  loading = $state(false);
  error   = $state(null);

  async loadWeek(weekMonday) {
    this.loading = true;
    this.error = null;
    try {
      const res = await fetch(`/api/entries?week=${weekMonday}`);
      if (!res.ok) throw new Error('Failed to load entries');
      const { entries } = await res.json();
      this.entries = entries;
    } catch (e) {
      this.error = e.message;
    } finally {
      this.loading = false;
    }
  }

  async add(entry) {
    this.entries.push(entry);
    try {
      const res = await fetch('/api/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry)
      });
      if (!res.ok) throw new Error('Failed to save entry');
    } catch (e) {
      this.entries = this.entries.filter(x => x.id !== entry.id);
      this.error = e.message;
    }
  }

  async update(id, changes) {
    const prev = this.entries.find(e => e.id === id);
    this.entries = this.entries.map(e => e.id === id ? { ...e, ...changes } : e);
    try {
      const res = await fetch(`/api/entries/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes)
      });
      if (!res.ok) throw new Error('Failed to update entry');
    } catch (e) {
      if (prev) this.entries = this.entries.map(e => e.id === id ? prev : e);
      this.error = e.message;
    }
  }

  async delete(id) {
    const prev = this.entries.find(e => e.id === id);
    this.entries = this.entries.filter(e => e.id !== id);
    try {
      const res = await fetch(`/api/entries/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete entry');
    } catch (e) {
      if (prev) this.entries.push(prev);
      this.error = e.message;
    }
  }
}

export const store = new WorklogStore();
