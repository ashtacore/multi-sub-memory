import { Buffer } from 'node:buffer';

export const DEFAULT_EMBEDDING_MODEL = 'BAAI/bge-base-en-v1.5';
export const DEFAULT_EMBEDDING_DIMS = 768;

const float32Bytes = Float32Array.BYTES_PER_ELEMENT;

function maxMagnitude(vector) {
  let max = 0;
  for (let index = 0; index < vector.length; index++) {
    const value = vector[index];
    if (!Number.isFinite(value)) throw new TypeError('Vector values must be finite numbers');
    max = Math.max(max, Math.abs(value));
  }
  return max;
}

export function normalizeVector(vector) {
  const scale = maxMagnitude(vector);
  const result = new Float32Array(vector.length);
  if (scale === 0) return result;

  // Scale before squaring so finite inputs cannot overflow or underflow as a group.
  let squaredNorm = 0;
  for (let index = 0; index < vector.length; index++) {
    const value = vector[index] / scale;
    squaredNorm += value * value;
  }

  const norm = Math.sqrt(squaredNorm);
  for (let index = 0; index < vector.length; index++) {
    result[index] = (vector[index] / scale) / norm;
  }
  return result;
}

export function encodeFloat32Vector(vector) {
  const values = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  const bytes = Buffer.alloc(values.byteLength);
  for (let index = 0; index < values.length; index++) {
    bytes.writeFloatLE(values[index], index * float32Bytes);
  }
  return bytes;
}

export function decodeFloat32Vector(blob) {
  let view;
  if (blob instanceof Uint8Array) {
    view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  } else if (blob instanceof ArrayBuffer) {
    view = new DataView(blob);
  } else {
    throw new TypeError('Vector BLOB must be a Uint8Array or ArrayBuffer');
  }

  if (view.byteLength % float32Bytes !== 0) throw new RangeError('Invalid Float32 vector byte length');
  const vector = new Float32Array(view.byteLength / float32Bytes);
  for (let index = 0; index < vector.length; index++) {
    vector[index] = view.getFloat32(index * float32Bytes, true);
  }
  return vector;
}

export function cosineSimilarity(a, b) {
  if (a instanceof Uint8Array || a instanceof ArrayBuffer) a = decodeFloat32Vector(a);
  if (b instanceof Uint8Array || b instanceof ArrayBuffer) b = decodeFloat32Vector(b);

  if (a.length === 0 || a.length !== b.length) {
    throw new RangeError('Vectors must have the same non-zero length');
  }
  const scaleA = maxMagnitude(a);
  const scaleB = maxMagnitude(b);
  if (scaleA === 0 || scaleB === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index++) {
    const left = a[index] / scaleA;
    const right = b[index] / scaleB;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  const similarity = dot / Math.sqrt(normA * normB);
  return Math.max(-1, Math.min(1, similarity));
}

function isTypedArray(value) {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function vectorFromOutput(output) {
  let vector = output?.data ?? output;
  while (Array.isArray(vector) && vector.length === 1
    && (Array.isArray(vector[0]) || isTypedArray(vector[0]))) {
    vector = vector[0];
  }
  if (!(Array.isArray(vector) || isTypedArray(vector)) || vector.length === 0) {
    throw new TypeError('Embedding output must contain a non-empty vector');
  }
  return vector;
}

export function createEmbeddingEngine(options = {}) {
  const {
    embedding,
    env = process.env,
    loader = () => import('@huggingface/transformers'),
    pipelineOptions,
    warn = (message) => { process.stderr.write(`${message}\n`); },
  } = options;
  const model = options.model ?? embedding?.model ?? DEFAULT_EMBEDDING_MODEL;
  const isDefaultModel = model === DEFAULT_EMBEDDING_MODEL;
  const pooling = options.pooling ?? (isDefaultModel ? 'cls' : 'mean');
  const disableFlag = env.MULTI_SUB_MEMORY_NO_EMBEDDINGS?.trim().toLowerCase();
  const enabled = Boolean(options.enabled ?? embedding?.enabled ?? true)
    && !['1', 'true', 'yes'].includes(disableFlag);
  let expectedDims = options.dims ?? embedding?.dims ?? (isDefaultModel ? DEFAULT_EMBEDDING_DIMS : undefined);
  let reason = enabled ? undefined : 'disabled';
  let available = false;
  let initialization;

  async function initialize() {
    const { pipeline } = await loader();
    const extractor = await pipeline('feature-extraction', model, pipelineOptions);
    if (typeof extractor !== 'function') throw new TypeError('Expected a feature extractor');
    return extractor;
  }

  function degrade(failure) {
    if (reason) return;
    reason = failure;
    available = false;
    try {
      void Promise.resolve(warn(`Embeddings ${failure.replace('-', ' ')}. Continuing in FTS-only mode.`))
        .catch(() => {});
    } catch {
      // A diagnostic failure must leave lexical search available.
    }
  }

  return {
    async embed(text) {
      if (reason) return null;

      let extractor;
      try {
        initialization ??= initialize();
        extractor = await initialization;
      } catch {
        degrade('initialization-failed');
        return null;
      }
      if (reason) return null;

      try {
        const output = await extractor(text, { pooling, normalize: true });
        if (reason) return null;
        const values = vectorFromOutput(output);
        if (expectedDims !== undefined && values.length !== expectedDims) {
          throw new RangeError(`Expected ${expectedDims} embedding dimensions, got ${values.length}`);
        }
        const vector = normalizeVector(values);
        if (!vector.some((value) => value !== 0)) throw new RangeError('Embedding output has zero norm');
        expectedDims ??= vector.length;
        available = true;
        return vector;
      } catch {
        degrade('inference-failed');
        return null;
      }
    },
    getExpectedDims() {
      return expectedDims;
    },
    getStatus() {
      const dims = expectedDims ?? DEFAULT_EMBEDDING_DIMS;
      return { enabled, available, mode: available ? 'onnx' : 'fts-only', model, dims, ...(reason ? { reason } : {}) };
    },
  };
}
