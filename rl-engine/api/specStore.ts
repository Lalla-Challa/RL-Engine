/**
 * SpecStore — sandboxed spec CRUD (Phase B).
 * Specs are files, not DB rows (persistence outside the kernel, §29).
 * Seeded specs are read-only and discovered at fixed paths; saved specs live
 * in `<dataDir>/specs/<id>.json` and never escape that directory (ids are
 * sanitized to [a-z0-9-_]).
 */

import fs from "node:fs";
import path from "node:path";

import type { EnvironmentSpecification } from "../core/types";

export type SpecRef = { id: string; label: string; mutable: boolean };

export class SpecStore {
  private seeded = new Map<string, { label: string; file: string }>();

  constructor(private readonly dataDir: string, seeded: { id: string; label: string; file: string }[]) {
    fs.mkdirSync(this.specsDir, { recursive: true });
    for (const s of seeded) {
      if (fs.existsSync(s.file)) this.seeded.set(s.id, { label: s.label, file: s.file });
    }
  }

  private get specsDir(): string {
    return path.join(this.dataDir, "specs");
  }

  private sanitize(id: string): string {
    const safe = id.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    if (!safe) throw new Error("invalid spec id");
    return safe;
  }

  list(): SpecRef[] {
    const refs: SpecRef[] = [];
    for (const [id, meta] of this.seeded) refs.push({ id, label: meta.label, mutable: false });
    if (fs.existsSync(this.specsDir)) {
      for (const f of fs.readdirSync(this.specsDir)) {
        if (!f.endsWith(".json")) continue;
        const id = f.slice(0, -".json".length);
        if (!this.seeded.has(id)) refs.push({ id, label: "saved spec", mutable: true });
      }
    }
    return refs;
  }

  get(id: string): EnvironmentSpecification | null {
    const seeded = this.seeded.get(id);
    const file = seeded ? seeded.file : path.join(this.specsDir, `${this.sanitize(id)}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as EnvironmentSpecification;
  }

  save(id: string, spec: EnvironmentSpecification): { saved: true; id: string } {
    const safe = this.sanitize(id);
    fs.mkdirSync(this.specsDir, { recursive: true });
    fs.writeFileSync(path.join(this.specsDir, `${safe}.json`), JSON.stringify(spec, null, 2), "utf-8");
    return { saved: true, id: safe };
  }
}
