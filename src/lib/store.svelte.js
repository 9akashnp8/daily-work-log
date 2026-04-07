export const CATEGORIES = ['Feature', 'Bug Fix', 'Meeting', 'Review', 'Research', 'Other'];

export const STATUSES = [
  { value: 'done',        label: 'Done' },
  { value: 'in-progress', label: 'In Progress' },
  { value: 'next-week',   label: 'Next Week' },
  { value: 'blocker',     label: 'Blocker' },
  { value: 'achievement', label: 'Achievement' }
];

const STORAGE_KEY = 'worklog_entries';

class WorklogStore {
  entries = $state([]);

  constructor() {
    if (typeof localStorage !== 'undefined') {
      try {
        this.entries = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      } catch {
        this.entries = [];
      }
    }
  }

  add(entry) {
    this.entries.push(entry);
    this.#save();
  }

  update(id, changes) {
    this.entries = this.entries.map(e => e.id === id ? { ...e, ...changes } : e);
    this.#save();
  }

  delete(id) {
    this.entries = this.entries.filter(e => e.id !== id);
    this.#save();
  }

  #save() {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.entries));
    }
  }
}

export const store = new WorklogStore();
