// Deterministic policy reductions require an explicit policy decision, even
// when an AI reviewer calls the change acceptable. Ordinary test rewrites go
// through independent semantic review rather than a brittle assertion count.
export function reductions(files) {
  const problems = [];
  for (const f of files) {
    if (
      !/(?:coverage-floor\.json|quarantine\.json|osv-scanner\.toml|deny\.toml|audit\.toml)$/.test(
        f.filename,
      )
    )
      continue;
    if (f.before === null) {
      problems.push(`${f.filename}: new exception or coverage policy`);
      continue;
    }
    if (f.after === null) {
      problems.push(`${f.filename}: removed policy`);
      continue;
    }
    if (/coverage-floor\.json$/.test(f.filename)) {
      try {
        const before = JSON.parse(f.before),
          after = JSON.parse(f.after);
        const values = { aggregate: before.aggregate, ...before.packages };
        const current = { aggregate: after.aggregate, ...after.packages };
        for (const [key, value] of Object.entries(values))
          if (typeof current[key] !== "number" || current[key] < value)
            problems.push(`${f.filename}: reduced or removed ${key} floor`);
        if ((after.exclude ?? []).some((p) => !(before.exclude ?? []).includes(p)))
          problems.push(`${f.filename}: added coverage exclusion`);
      } catch {
        problems.push(`${f.filename}: unreadable policy`);
      }
    } else if (/quarantine\.json$/.test(f.filename)) {
      try {
        const old = JSON.parse(f.before).quarantine ?? [],
          next = JSON.parse(f.after).quarantine ?? [];
        for (const item of next) {
          const prior = old.find((p) => p.file === item.file && p.title === item.title);
          if (!prior || item.expires > prior.expires)
            problems.push(`${f.filename}: added or extended quarantine`);
        }
      } catch {
        problems.push(`${f.filename}: unreadable quarantine`);
      }
    } else if (f.before !== f.after) {
      // TOML suppressions are security decisions. No ad-hoc parser is trusted
      // to distinguish a reformatted ignore list from an equivalent rewrite.
      problems.push(`${f.filename}: scanner policy changed; separate risk acceptance required`);
    }
  }
  return problems;
}
