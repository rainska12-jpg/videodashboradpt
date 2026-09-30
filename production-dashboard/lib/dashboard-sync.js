(function (root) {
  const copy = (value) => value === undefined ? undefined : structuredClone(value);
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const object = (value) => value && typeof value === "object" && !Array.isArray(value);
  const keyed = (value) => Array.isArray(value) && value.every((item) => object(item) && typeof item.id === "string") && new Set(value.map((item) => item.id)).size === value.length;

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
  const api = { merge, commit };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DashboardSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
