import { resolve } from "node:path";

import {
  type DataType,
  type FeatureExtractionPipeline,
  pipeline,
  env as transformersEnv,
} from "@huggingface/transformers";

export type EmbeddingEngine = {
  name: string;
  embed(input: readonly string[]): Promise<number[][]>;
};

export type EmbeddingEngineStatus =
  | {
      available: true;
      engine: string;
    }
  | {
      available: false;
      reason: string;
    };

type LocalEmbeddingConfig = {
  model: string;
  dtype: DataType;
  cacheDir: string;
  localFilesOnly: boolean;
  batchSize: number;
};

type TensorLike = {
  dims: readonly number[];
  tolist(): unknown;
};

const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_LOCAL_EMBEDDING_DTYPE: DataType = "q8";
const PIPELINE_CACHE = new Map<string, Promise<FeatureExtractionPipeline>>();
const EMBEDDING_CACHE = new Map<string, number[]>();

export function createEmbeddingEngineFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingEngine | null {
  const provider = readEnv(env, "SANDI_EMBEDDING_PROVIDER") ?? "local";
  const normalized = provider.toLowerCase();
  if (
    normalized === "none" ||
    normalized === "off" ||
    normalized === "disabled"
  ) {
    return null;
  }
  if (normalized !== "local") {
    throw new Error(
      `Unsupported SANDI_EMBEDDING_PROVIDER: ${provider}. Only "local" and "disabled" are supported.`,
    );
  }
  const config = localEmbeddingConfig(env);
  return {
    name: `local:${config.model}:${config.dtype}`,
    async embed(input) {
      if (input.length === 0) return [];
      const extractor = await localFeatureExtractor(config);
      const embeddings: (number[] | undefined)[] = [];
      const misses: { index: number; text: string; cacheKey: string }[] = [];
      for (const [index, text] of input.entries()) {
        const cacheKey = embeddingCacheKey(config, text);
        const cached = EMBEDDING_CACHE.get(cacheKey);
        if (cached) {
          embeddings[index] = cached;
        } else {
          misses.push({ index, text, cacheKey });
        }
      }

      for (let index = 0; index < misses.length; index += config.batchSize) {
        const batch = misses.slice(index, index + config.batchSize);
        const output = await extractor(
          batch.map((miss) => miss.text),
          {
            pooling: "mean",
            normalize: true,
          },
        );
        const rows = tensorRows(output);
        for (const [batchIndex, row] of rows.entries()) {
          const miss = batch[batchIndex];
          if (!miss) continue;
          EMBEDDING_CACHE.set(miss.cacheKey, row);
          embeddings[miss.index] = row;
        }
      }
      return embeddings.map((embedding) => {
        if (!embedding) throw new Error("Embedding cache produced a gap.");
        return embedding;
      });
    },
  };
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]) {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;

  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    aNorm += left * left;
    bNorm += right * right;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function localEmbeddingConfig(env: NodeJS.ProcessEnv): LocalEmbeddingConfig {
  return {
    model:
      readEnv(env, "SANDI_EMBEDDING_MODEL") ?? DEFAULT_LOCAL_EMBEDDING_MODEL,
    dtype: readDtype(env) ?? DEFAULT_LOCAL_EMBEDDING_DTYPE,
    cacheDir: resolve(
      readEnv(env, "SANDI_EMBEDDING_CACHE_DIR") ??
        `${readEnv(env, "SANDI_DATA_DIR") ?? "./data"}/embedding-models`,
    ),
    localFilesOnly: readBooleanEnv(env, "SANDI_EMBEDDING_LOCAL_FILES_ONLY"),
    batchSize: readPositiveIntEnv(env, "SANDI_EMBEDDING_BATCH_SIZE") ?? 24,
  };
}

function localFeatureExtractor(
  config: LocalEmbeddingConfig,
): Promise<FeatureExtractionPipeline> {
  const cacheKey = JSON.stringify(config);
  const cached = PIPELINE_CACHE.get(cacheKey);
  if (cached) return cached;
  transformersEnv.cacheDir = config.cacheDir;
  const created = pipeline("feature-extraction", config.model, {
    cache_dir: config.cacheDir,
    dtype: config.dtype,
    local_files_only: config.localFilesOnly,
  });
  PIPELINE_CACHE.set(cacheKey, created);
  return created;
}

function embeddingCacheKey(config: LocalEmbeddingConfig, text: string): string {
  return `${config.model}\0${config.dtype}\0${text}`;
}

function tensorRows(tensor: TensorLike): number[][] {
  const rows = tensor.tolist();
  if (!Array.isArray(rows)) {
    throw new Error("Embedding tensor did not convert to an array.");
  }
  if (tensor.dims.length === 1) return [numberArray(rows)];
  return rows.map(numberArray);
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new Error("Embedding row was not an array.");
  }
  const values: number[] = [];
  for (const item of value) {
    if (typeof item !== "number") {
      throw new Error("Embedding row contained a non-number value.");
    }
    values.push(item);
  }
  return values;
}

function readDtype(env: NodeJS.ProcessEnv): DataType | undefined {
  const value = readEnv(env, "SANDI_EMBEDDING_DTYPE");
  if (!value) return undefined;
  if (
    value === "auto" ||
    value === "fp32" ||
    value === "fp16" ||
    value === "q8" ||
    value === "int8" ||
    value === "uint8" ||
    value === "q4" ||
    value === "bnb4" ||
    value === "q4f16"
  ) {
    return value;
  }
  throw new Error(`Unsupported SANDI_EMBEDDING_DTYPE: ${value}`);
}

function readBooleanEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = readEnv(env, name);
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
}

function readPositiveIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const value = readEnv(env, name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}
