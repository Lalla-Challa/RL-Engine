/**
 * Read-only, token-budgeted retrieval over the static CCM framework index.
 *
 * The index is generated at build time. Runtime only reads this JSON once and
 * lazily loads the MiniLM bi-encoder when semantic search is requested.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { embedCcmText } from "./embeddings";

type IndexedSection = {
  id: string;
  title: string;
  content: string;
  estimatedTokens: number;
  embedding: number[];
};

export type CcmGuidanceSection = Pick<IndexedSection, "title" | "content">;

function loadIndex(): IndexedSection[] {
  // In packaged builds, the builder copies ccm-index.json into extraResources.
  // Probe that location first; fall back to the source-adjacent file (dev).
  let indexPath = fileURLToPath(new URL("./ccm-index.json", import.meta.url));
  try {
    if (typeof process !== "undefined" && process.resourcesPath && fs.existsSync(`${process.resourcesPath}/server/ccm/ccm-index.json`)) {
      indexPath = `${process.resourcesPath}/server/ccm/ccm-index.json`;
    } else if (typeof process !== "undefined" && process.resourcesPath && fs.existsSync(`${process.resourcesPath}/ccm-index.json`)) {
      indexPath = `${process.resourcesPath}/ccm-index.json`;
    }
  } catch {}
  const parsed: unknown = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("CCM guidance index must be an array");
  return parsed as IndexedSection[];
}

const ccmIndex = loadIndex();
const sectionsById = new Map(ccmIndex.map((section) => [section.id, section]));

/** Section ids are derived from the generated index and used by tool schemas. */
export const CCM_SECTION_IDS = ccmIndex.map((section) => section.id);

/**
 * Tier 0 — the document's compact Master Law, preserved verbatim. It is small
 * enough to attach to MCP initialization without consuming retrieval budget.
 */
export const CCM_CORE_LAW = `## Master Law of Causal Continuity

> **Every meaningful Event must emerge from the existing state and governing Systems of the world; meaningful Events alter that state, and their consequences become conditions for subsequent Events. The level of causal scrutiny should be proportional to the Event's Causal Load.**

The practical version is:

> **State creates possibilities. The author selects. Events change state. Consequences create new possibilities.**

The philosophical version is:

> **Every consequence can become a cause.**`;

export function getSectionById(id: string): CcmGuidanceSection | null {
  const section = sectionsById.get(id);
  return section ? { title: section.title, content: section.content } : null;
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? -Infinity : dot / denominator;
}

/**
 * Return the most relevant sections without exceeding the requested budget.
 * A section which does not fit is trimmed to the remaining character budget,
 * preserving the hard `content.length / 4` token approximation cap.
 */
export async function searchSections(
  query: string,
  opts: { topK?: number; tokenBudget?: number } = {}
): Promise<CcmGuidanceSection[]> {
  const topK = Math.max(0, Math.floor(opts.topK ?? 2));
  const tokenBudget = Math.max(0, Math.floor(opts.tokenBudget ?? 1200));
  if (!query.trim() || topK === 0 || tokenBudget === 0) return [];

  const queryEmbedding = await embedCcmText(query);
  const ranked = ccmIndex
    .map((section) => ({ section, similarity: cosineSimilarity(queryEmbedding, section.embedding) }))
    .sort((left, right) => right.similarity - left.similarity);

  const result: CcmGuidanceSection[] = [];
  let remainingCharacters = tokenBudget * 4;
  for (const { section } of ranked) {
    if (result.length >= topK || remainingCharacters <= 0) break;
    const content = section.content.slice(0, remainingCharacters);
    if (content.length === 0) break;
    result.push({ title: section.title, content });
    remainingCharacters -= content.length;
    // The next section cannot fit once this one was shortened.
    if (content.length < section.content.length) break;
  }
  return result;
}
