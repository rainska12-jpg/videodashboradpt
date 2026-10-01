(function (root) {
  const copy = (value) => value === undefined ? undefined : structuredClone(value);
  const object = (value) => value && typeof value === "object" && !Array.isArray(value);
  const keyed = (value) => Array.isArray(value) && value.every((item) => object(item) && typeof item.id === "string") && new Set(value.map((item) => item.id)).size === value.length;

  function equal(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => equal(item, b[index]));
    if (!object(a) || !object(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key]));
  }

  // Three-way merge: only fields changed since this client's last read are applied.
  function merge(base, local, remote, preference = "") {
    const conflicts = [];
    function visit(b, l, r, path) {
      if (equal(l, b)) return copy(r);
      if (equal(r, b) || equal(l, r)) return copy(l);
      if (object(b) && object(l) && object(r)) {
        const result = {};
        for (const key of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
          const value = visit(b[key], l[key], r[key], [...path, key]);
          if (value !== undefined) result[key] = value;
        }
        return result;
      }
      if (keyed(b) && keyed(l) && keyed(r)) {
        const maps = [b, l, r].map((items) => new Map(items.map((item) => [item.id, item])));
        return [...new Set([...l.map((item) => item.id), ...r.map((item) => item.id)])]
          .map((id) => visit(maps[0].get(id), maps[1].get(id), maps[2].get(id), [...path, id]))
          .filter((item) => item !== undefined);
      }
      if (path.length === 1 && path[0] === "currentUser") return copy(l);
      conflicts.push({ path, local: copy(l), remote: copy(r) });
      return copy(preference === "remote" ? r : l);
    }
    return { value: visit(base, local, remote, []), conflicts };
  }

  async function commit({ base, local, read, write, resolve, attempts = 4 }) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const latest = await read();
      let merged = merge(base, local, latest.value);
      if (merged.conflicts.length) {
        const preference = await resolve(merged.conflicts);
        if (!preference) throw new Error("CONFLICT");
        merged = merge(base, local, latest.value, preference);
      }
      if (await write(merged.value, latest.version)) return merged.value;
    }
    throw new Error("BUSY");
  }

  // Keep only changed entities, with their old values for conflict detection.
  function createRecovery(base, local) {
    const changes = [];
    for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
      if (equal(base[key], local[key])) continue;
      if (keyed(base[key]) && keyed(local[key])) {
        const before = new Map(base[key].map((item) => [item.id, item]));
        const after = new Map(local[key].map((item) => [item.id, item]));
        for (const id of new Set([...before.keys(), ...after.keys()])) {
          if (!equal(before.get(id), after.get(id))) {
            changes.push({ path: [key, id], base: copy(before.get(id)), local: copy(after.get(id)) });
          }
        }
      } else changes.push({ path: [key], base: copy(base[key]), local: copy(local[key]) });
    }
    return { version: 2, changes };
  }

  function restoreRecovery(latest, recovery) {
    // Read full snapshots left by the previous release without discarding them.
    if (recovery.version !== 2) return { base: copy(recovery.base), local: copy(recovery.local) };
    const result = { base: copy(latest), local: copy(latest) };
    for (const change of recovery.changes) {
      const [key, id] = change.path;
      if ([key, id].some((part) => ["__proto__", "constructor", "prototype"].includes(part))) throw new Error("INVALID_RECOVERY");
      for (const side of ["base", "local"]) {
        const value = copy(change[side]);
        if (change.path.length === 1) {
          if (value === undefined) delete result[side][key];
          else result[side][key] = value;
        } else {
          const items = result[side][key] || [];
          const index = items.findIndex((item) => item.id === id);
          if (value === undefined) { if (index >= 0) items.splice(index, 1); }
          else if (index >= 0) items[index] = value;
          else items.push(value);
          result[side][key] = items;
        }
      }
    }
    return result;
  }
  const api = { equal, merge, commit, createRecovery, restoreRecovery };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DashboardSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
