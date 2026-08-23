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

  syncing     = $state(false);
  syncPreview = $state(null);
  syncError   = $state(null);
  syncEnabled = $state(false);

  async checkSyncEnabled() {
    try {
      const res = await fetch('/api/sync/jira');
      if (!res.ok) return;
      const { configured } = await res.json();
      this.syncEnabled = configured;
    } catch {
      this.syncEnabled = false;
    }
  }

  async previewSync(week) {
    this.syncing = true;
    this.syncError = null;
    try {
      const res = await fetch('/api/sync/jira', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ week, mode: 'preview' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to preview Jira sync');
      this.syncPreview = data;
    } catch (e) {
      this.syncError = e.message;
    } finally {
      this.syncing = false;
    }
  }

  async applySync(week) {
    this.syncing = true;
    this.syncError = null;
    try {
      const res = await fetch('/api/sync/jira', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ week, mode: 'apply' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to apply Jira sync');
      this.entries = data.entries;
      this.syncPreview = null;
    } catch (e) {
      this.syncError = e.message;
    } finally {
      this.syncing = false;
    }
  }

  cancelSync() {
    this.syncPreview = null;
    this.syncError = null;
  }

  /**
   * Fresh entries computed straight from Jira, WITHOUT touching the database.
   * `mode: 'preview'` already does exactly this work server-side — it runs the
   * full discovery-JQL → changelog → comments → mapping pipeline and returns
   * the resulting rows, writing nothing. Reusing it lets the draft be rebuilt
   * from live Jira while leaving the "preview, then Apply" safety model of the
   * Sync button completely untouched. Throws so the caller can fall back to
   * the last synced data.
   */
  async fetchJiraEntries(week) {
    const res = await fetch('/api/sync/jira', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week, mode: 'preview' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Failed to fetch from Jira');
    return data;
  }

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

}

export const store = new WorklogStore();
