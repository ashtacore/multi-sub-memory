import { readFileSync } from 'node:fs';
import { writeTextAtomically } from '../config.mjs';
import { inWriteTransaction } from '../memory-service.mjs';

function readState(file) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (state && typeof state === 'object' && !Array.isArray(state)) {
      return new Map(Object.entries(state));
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return new Map();
}

function projectState(state, projectKey) {
  const project = state.get(projectKey);
  return {
    lastCheckout: typeof project?.lastCheckout === 'string' ? project.lastCheckout : undefined,
    checkouts: Array.isArray(project?.checkouts)
      ? project.checkouts.filter((root) => typeof root === 'string' && root)
      : [],
  };
}

export function createCheckoutState(db) {
  // Use the actual open database, including an injected connection or SQLite URI.
  const { file } = db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get();
  const sidecar = file ? file + '.dreamer-checkouts.json' : null;
  const session = new Map();
  const load = () => sidecar ? readState(sidecar) : session;

  return {
    get(projectKey) {
      try {
        return projectState(load(), projectKey);
      } catch {
        // The registry and configured paths remain available if the sidecar is unreadable.
        return { checkouts: [] };
      }
    },
    record(projectKey, checkout, verifiedCheckouts) {
      // Serialize read/merge/write across dashboards sharing the database.
      inWriteTransaction(db, () => {
        const state = load();
        const previous = projectState(state, projectKey);
        const registered = db.prepare('SELECT project_root FROM projects WHERE project_key = ?').get(projectKey);
        const checkouts = new Set([...verifiedCheckouts, ...previous.checkouts]);
        if (registered?.project_root) checkouts.add(registered.project_root);
        state.set(projectKey, { lastCheckout: checkout, checkouts: [...checkouts] });
        if (sidecar) writeTextAtomically(sidecar, JSON.stringify(Object.fromEntries(state)) + '\n');
      });
    },
  };
}
