/**
 * Persistence sub-entry — adapters ship separately from the kernel so the
 * core install stays dependency-free (§29). The SQLCipher adapter is loaded
 * lazily and only needs its optional dependency at construction time.
 */

export type { PersistenceAdapter, SnapshotMeta } from "./adapter";
export { FilePersistenceAdapter } from "./fileAdapter";
export { SqlCipherPersistenceAdapter, deriveKeyHex } from "./sqlCipherAdapter";
export type { SqlCipherAdapterOptions } from "./sqlCipherAdapter";
export type { EngineSnapshot } from "../environment/snapshot";
export { SNAPSHOT_VERSION, sha256Canonical } from "../environment/snapshot";
