/**
 * CPU-only semantic-consistency helper for the CCE engine.
 *
 * Lazily instantiates a single shared ONNX pipeline (Xenova/nli-deberta-v3-small,
 * dtype q8) for zero-shot classification and NLI contradiction detection.
 *
 * This module is PURE/READ-ONLY: no DB access, no writes to World state, no
 * interaction with the engine's step loop or RNG. It must never be imported
 * by simulator.ts — determinism of the seeded run must be provably unaffected.
 */

import { pipeline, type AllTasks } from "@huggingface/transformers";

type ZeroShot = AllTasks["zero-shot-classification"];
type Nli = AllTasks["text-classification"];

let _zeroShot: Promise<ZeroShot> | null = null;
let _nli: Promise<Nli> | null = null;

async function getZeroShot(): Promise<ZeroShot> {
  if (!_zeroShot) {
    _zeroShot = pipeline("zero-shot-classification", "Xenova/nli-deberta-v3-small", {
      dtype: "q8",
    }) as Promise<ZeroShot>;
  }
  return _zeroShot;
}

async function getNli(): Promise<Nli> {
  if (!_nli) {
    _nli = pipeline("text-classification", "Xenova/nli-deberta-v3-small", {
      dtype: "q8",
    }) as Promise<Nli>;
  }
  return _nli;
}

/**
 * Suggest tags for a piece of text using zero-shot classification against a
 * given vocabulary. Returns labels + scores sorted descending. The caller
 * decides any cutoff threshold — this function does not filter internally.
 */
export async function suggestTags(
  text: string,
  vocabulary: string[]
): Promise<{ tag: string; score: number }[]> {
  const classifier = await getZeroShot();
  const output = await classifier(text, vocabulary);
  const single = Array.isArray(output) ? output[0] : output;
  const labels: string[] = single.labels ?? [];
  const scores: number[] = single.scores ?? [];
  return labels
    .map((tag, i) => ({ tag, score: scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Check whether two texts contradict each other, entail one another, or are
 * neutral using the NLI model. Returns the top label and its probability.
 *
 * In @huggingface/transformers v4.2.x the `{ text, text_pair }` object form
 * silently returns a constant and the two-argument form `(textA, textB)` feeds
 * the model incorrectly (wrong labels).  The model's SEP token is "[SEP]".
 * The working format is concatenation:  `${textA} [SEP] ${textB}`.
 * The model also has a known bias: when two texts share zero content words
 * it almost always predicts "contradiction" regardless of actual relationship.
 * We guard against that: if the model says "contradiction" but the two texts
 * share no content-word overlap, we downgrade to "neutral".
 */
export async function checkContradiction(
  textA: string,
  textB: string
): Promise<{ label: "contradiction" | "entailment" | "neutral"; score: number }> {
  const nli = await getNli();
  const classifier = nli as unknown as (text: string) => Promise<{ label: string; score: number }[]>;
  const output = await classifier(`${textA} [SEP] ${textB}`);
  const single = Array.isArray(output) ? output[0] : output;
  let label = (single?.label as "contradiction" | "entailment" | "neutral") ?? "neutral";
  const score = single?.score ?? 0;

  // Model bias guard: when the model says "contradiction" for a pair that
  // shares zero content-word overlap, it's almost certainly the model's
  // known "no overlap → contradiction" bias rather than a real contradiction.
  if (label === "contradiction" && noSharedContent(textA, textB)) {
    label = "neutral";
  }

  return { label, score };
}

/** Content-word tokens (lowercased, no stopwords, min length 2). */
const STOP_WORDS = new Set([
  "a","an","the","is","are","was","were","am","be","been","being","and","or","but","if",
  "then","than","so","for","of","on","in","at","to","from","with","without","by","about",
  "as","it","its","this","that","these","those","he","she","him","her","his","their",
  "they","we","our","i","you","your","my","me","not","no","do","does","did","have","has",
  "had","will","would","can","could","should","may","might","must","shall",
]);

function contentTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9']+/g) ?? [])
    .filter((t) => !STOP_WORDS.has(t))
    .filter((t) => t.length > 1);
}

function noSharedContent(a: string, b: string): boolean {
  const ta = new Set(contentTokens(a));
  const tb = new Set(contentTokens(b));
  for (const t of Array.from(ta)) if (tb.has(t)) return false;
  return true;
}