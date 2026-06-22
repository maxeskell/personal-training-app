import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEmbeddingResponse, embeddingPromptTokens } from "../src/llm/embeddings.js";

test("parseEmbeddingResponse: returns vectors ordered by index, regardless of array order", () => {
  const json = {
    object: "list",
    data: [
      { object: "embedding", index: 1, embedding: [0, 1] },
      { object: "embedding", index: 0, embedding: [1, 0] },
    ],
    model: "nomic-embed-text",
  };
  assert.deepEqual(parseEmbeddingResponse(json, 2), [
    [1, 0],
    [0, 1],
  ]);
});

test("parseEmbeddingResponse: throws on a missing/garbled data array (degrades like a server-down throw)", () => {
  assert.throws(() => parseEmbeddingResponse({}, 1), /missing data/);
  assert.throws(() => parseEmbeddingResponse(null, 1), /missing data/);
  assert.throws(() => parseEmbeddingResponse({ data: "nope" }, 1), /missing data/);
});

test("parseEmbeddingResponse: throws when the count doesn't match the inputs", () => {
  const json = { data: [{ index: 0, embedding: [1, 2] }] };
  assert.throws(() => parseEmbeddingResponse(json, 2), /expected 2 embeddings, got 1/);
});

test("parseEmbeddingResponse: throws on a non-numeric embedding", () => {
  const json = { data: [{ index: 0, embedding: ["x", "y"] }] };
  assert.throws(() => parseEmbeddingResponse(json, 1), /no numeric embedding/);
});

test("embeddingPromptTokens: reads usage.prompt_tokens for the local cost log; 0 when absent/garbled", () => {
  assert.equal(embeddingPromptTokens({ usage: { prompt_tokens: 42 } }), 42);
  assert.equal(embeddingPromptTokens({ data: [] }), 0);
  assert.equal(embeddingPromptTokens({ usage: { prompt_tokens: "x" } }), 0);
  assert.equal(embeddingPromptTokens(null), 0);
});
