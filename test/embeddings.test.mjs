import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import {
  cosineSimilarity, createEmbeddingEngine, decodeFloat32Vector, DEFAULT_EMBEDDING_DIMS,
  DEFAULT_EMBEDDING_MODEL, encodeFloat32Vector, normalizeVector,
} from '../src/embeddings.mjs';

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `Expected ${actual} to be close to ${expected}`);
}

test('serializes float32s in little-endian order and decodes offset views', () => {
  const vector = new Float32Array([1, -2.5, 0.125]);
  const bytes = encodeFloat32Vector(vector);
  assert.ok(Buffer.isBuffer(bytes));
  assert.deepEqual(encodeFloat32Vector([1, -2.5, 0.125]), bytes);
  assert.deepEqual([...bytes.subarray(0, 4)], [0, 0, 128, 63]);
  assert.deepEqual(decodeFloat32Vector(bytes), vector);
  assert.deepEqual(decodeFloat32Vector(Uint8Array.from(bytes).buffer), vector);

  const padded = new Uint8Array(bytes.length + 2);
  padded.set(bytes, 1);
  assert.deepEqual(decodeFloat32Vector(padded.subarray(1, -1)), vector);
  assert.throws(() => decodeFloat32Vector(padded.subarray(1)), RangeError);
});

test('normalizes finite vectors without modifying them or dividing zero by zero', () => {
  const input = new Float32Array([3, 4]);
  const normalized = normalizeVector(input);
  assert.ok(normalized instanceof Float32Array);
  assert.notEqual(normalized, input);
  assert.deepEqual(input, new Float32Array([3, 4]));
  assertClose(normalized[0], 0.6);
  assertClose(normalized[1], 0.8);
  assertClose(Math.hypot(...normalized), 1);
  assert.deepEqual(normalizeVector([0, -0, 0]), new Float32Array(3));
  assertClose(Math.hypot(...normalizeVector([Number.MAX_VALUE, Number.MAX_VALUE])), 1);
  assert.deepEqual(normalizeVector([Number.MIN_VALUE, 0]), new Float32Array([1, 0]));
  for (const invalid of [NaN, Infinity, '1']) {
    assert.throws(() => normalizeVector([1, invalid]), TypeError);
  }
});

test('computes cosine similarity on unnormalized vectors and handles zero norms', () => {
  assert.equal(cosineSimilarity([3, 4], [3, 4]), 1);
  assert.equal(cosineSimilarity([2, 0], [0, 3]), 0);
  assert.equal(cosineSimilarity([3, 4], [-3, -4]), -1);
  assertClose(cosineSimilarity([2, 2], [10, 0]), Math.SQRT1_2);
  assert.equal(cosineSimilarity([0, 0], [3, 4]), 0);
  assert.equal(cosineSimilarity([3, 4], [0, 0]), 0);
  assert.equal(cosineSimilarity([Number.MAX_VALUE], [Number.MIN_VALUE]), 1);
  assert.throws(() => cosineSimilarity([1], [1, 2]), RangeError);
  assert.throws(() => cosineSimilarity([], []), RangeError);
});

test('uses CLS pooling and accepts a 768-dimensional default model output', async () => {
  const values = new Float32Array(DEFAULT_EMBEDDING_DIMS);
  values[0] = 3;
  values[1] = 4;
  const engine = createEmbeddingEngine({
    env: {},
    loader: () => ({
      pipeline(task, model) {
        assert.equal(task, 'feature-extraction');
        assert.equal(model, DEFAULT_EMBEDDING_MODEL);
        return (text, options) => {
          assert.equal(text, 'fixture');
          assert.deepEqual(options, { pooling: 'cls', normalize: true });
          return { data: values };
        };
      },
    }),
  });

  assert.equal(engine.getStatus().dims, 768);
  const vector = await engine.embed('fixture');
  assert.equal(vector.length, 768);
  assertClose(vector[0], 0.6);
  assertClose(vector[1], 0.8);
  assert.equal(engine.getStatus().available, true);
});

test('initializes a configured model lazily and shares initialization across concurrent requests', async () => {
  let loads = 0;
  let pipelines = 0;
  const loadGate = Promise.withResolvers();
  const outputs = new Map([
    ['tensor', { data: new Float32Array([3, 4]) }],
    ['array', [[0, -2]]],
    ['typed', new Float32Array([5, 0])],
  ]);
  const engine = createEmbeddingEngine({
    embedding: { enabled: true, model: 'fixture-model' },
    env: { MULTI_SUB_MEMORY_NO_EMBEDDINGS: 'False' },
    async loader() {
      loads++;
      await loadGate.promise;
      return {
        async pipeline(task, model) {
          pipelines++;
          assert.equal(task, 'feature-extraction');
          assert.equal(model, 'fixture-model');
          return async (text, options) => {
            assert.deepEqual(options, { pooling: 'mean', normalize: true });
            return outputs.get(text);
          };
        },
      };
    },
  });
  assert.equal(loads, 0);
  assert.equal(engine.getStatus().dims, DEFAULT_EMBEDDING_DIMS);
  const pending = Promise.all([engine.embed('tensor'), engine.embed('array'), engine.embed('typed')]);
  assert.equal(loads, 1);
  assert.equal(pipelines, 0);
  loadGate.resolve();
  const [tensor, array, typed] = await pending;
  assertClose(tensor[0], 0.6);
  assertClose(tensor[1], 0.8);
  assert.deepEqual(array, new Float32Array([0, -1]));
  assert.deepEqual(typed, new Float32Array([1, 0]));
  assert.equal(pipelines, 1);
  assert.deepEqual(engine.getStatus(), {
    enabled: true, available: true, mode: 'onnx', model: 'fixture-model', dims: 2,
  });
});

test('disabling embeddings via config or a true environment flag skips loading and warnings', async () => {
  let loads = 0;
  let warnings = 0;
  for (const options of [
    { enabled: false, env: {} },
    { embedding: { enabled: false }, env: { MULTI_SUB_MEMORY_NO_EMBEDDINGS: 'no' } },
    ...['1', ' TRUE ', 'Yes'].map((value) => ({ env: { MULTI_SUB_MEMORY_NO_EMBEDDINGS: value } })),
  ]) {
    const engine = createEmbeddingEngine({
      ...options,
      loader() { loads++; },
      warn() { warnings++; },
    });
    assert.equal(await engine.embed('fixture'), null);
    assert.deepEqual(engine.getStatus(), {
      enabled: false, available: false, mode: 'fts-only', model: DEFAULT_EMBEDDING_MODEL,
      dims: DEFAULT_EMBEDDING_DIMS, reason: 'disabled',
    });
  }
  assert.equal(loads, 0);
  assert.equal(warnings, 0);
});

const failureCases = [
  ['loader failure', 'initialization-failed', async () => { throw new Error('import failed'); }],
  ['pipeline failure', 'initialization-failed', async () => ({
    async pipeline() { throw new Error('initialization failed'); },
  })],
  ['inference failure', 'inference-failed', async () => ({
    pipeline: () => async () => { throw new Error('inference failed'); },
  })],
  ['empty inference output', 'inference-failed', async () => ({ pipeline: () => () => [[]] })],
  ['non-numeric inference output', 'inference-failed', async () => ({
    pipeline: () => () => Array(DEFAULT_EMBEDDING_DIMS).fill('1'),
  })],
  ['default model dimension mismatch', 'inference-failed', async () => ({
    pipeline: () => () => [1, 0],
  })],
  ['zero-norm inference output', 'inference-failed', async () => ({
    pipeline: () => () => new Float32Array(DEFAULT_EMBEDDING_DIMS),
  })],
];

for (const [name, reason, loader] of failureCases) {
  test(`${name} permanently falls back and warns once on stderr`, async (t) => {
    const stderr = t.mock.method(process.stderr, 'write', () => true);
    const stdout = t.mock.method(process.stdout, 'write', () => true);
    let loads = 0;
    const engine = createEmbeddingEngine({ env: {}, loader: () => { loads++; return loader(); } });
    assert.deepEqual(await Promise.all([engine.embed('first'), engine.embed('second')]), [null, null]);
    assert.equal(await engine.embed('third'), null);
    assert.equal(loads, 1);
    assert.equal(stderr.mock.callCount(), 1);
    assert.match(stderr.mock.calls[0].arguments[0], /FTS-only mode/);
    assert.equal(stdout.mock.callCount(), 0);
    assert.deepEqual(engine.getStatus(), {
      enabled: true, available: false, mode: 'fts-only', model: DEFAULT_EMBEDDING_MODEL,
      dims: DEFAULT_EMBEDDING_DIMS, reason,
    });
  });
}

for (const [name, options, inferDims] of [
  ['first valid output', {}, true],
  ['top-level dims', { dims: 2, embedding: { dims: 3 } }, false],
  ['nested dims', { embedding: { dims: 2 } }, false],
]) {
  test(`custom model enforces dimensions from ${name}`, async (t) => {
    const stderr = t.mock.method(process.stderr, 'write', () => true);
    const extractor = t.mock.fn((text) => text === 'invalid' ? [1, 0, 0] : [1, 0]);
    const engine = createEmbeddingEngine({
      ...options,
      model: 'fixture-model',
      pooling: 'cls',
      env: {},
      loader: () => ({ pipeline: () => extractor }),
    });

    if (inferDims) assert.deepEqual(await engine.embed('valid'), new Float32Array([1, 0]));
    assert.equal(engine.getStatus().dims, 2);
    assert.equal(await engine.embed('invalid'), null);
    assert.equal(await engine.embed('valid'), null);
    assert.equal(extractor.mock.callCount(), inferDims ? 2 : 1);
    assert.deepEqual(extractor.mock.calls.at(-1).arguments, ['invalid', { pooling: 'cls', normalize: true }]);
    assert.equal(stderr.mock.callCount(), 1);
    assert.match(stderr.mock.calls[0].arguments[0], /FTS-only mode/);
    assert.deepEqual(engine.getStatus(), {
      enabled: true, available: false, mode: 'fts-only', model: 'fixture-model',
      dims: 2, reason: 'inference-failed',
    });
  });
}

test('late inference results cannot re-enable an engine after another inference fails', async () => {
  const lateOutput = Promise.withResolvers();
  const engine = createEmbeddingEngine({
    model: 'fixture-model',
    env: {},
    loader: () => ({
      pipeline: () => async (text) => {
        if (text === 'late') return lateOutput.promise;
        if (text === 'failure') throw new Error('inference failed');
        return [1, 0];
      },
    }),
    warn() { throw new Error('diagnostic sink failed'); },
  });

  assert.deepEqual(await engine.embed('success'), new Float32Array([1, 0]));
  const late = engine.embed('late');
  assert.equal(await engine.embed('failure'), null);
  lateOutput.resolve([1, 0, 0]);
  assert.equal(await late, null);
  assert.equal(engine.getStatus().dims, 2);
  assert.equal(engine.getStatus().available, false);
});
