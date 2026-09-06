/**
 * Shared bi-encoder for CCM guidance retrieval.
 *
 * This is deliberately separate from `semantics.ts`: the NLI cross-encoder
 * evaluates sentence pairs, while this model produces one normalized vector
 * per input for cosine similarity search.
 */
import { pipeline } from "@huggingface/transformers";

export const CCM_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

type FeatureExtractor = (
  input: string,
  options: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array | Float64Array | number[] }>;

let embedderPromise: Promise<FeatureExtractor> | null = null;

async function getEmbedder(): Promise<FeatureExtractor> {
  if (!embedderPromise) {
    embedderPromise = pipeline("feature-extraction", CCM_EMBEDDING_MODEL, {
      dtype: "q8",
    }) as unknown as Promise<FeatureExtractor>;
  }
  return embedderPromise;
}

/**
 * Mean-pool and L2-normalize a single piece of text with the CCM bi-encoder.
 * Both the build-time indexer and runtime search call this exact helper so
 * their vectors always inhabit the same embedding space.
 */
export async function embedCcmText(text: string): Promise<number[]> {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(output.data, Number);
}
