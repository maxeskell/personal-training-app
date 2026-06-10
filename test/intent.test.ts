import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, parseIntentReply, isLastSessionQuestion } from "../src/coach/intent.js";
import type { ChatCompleter, LocalChatOpts } from "../src/llm/localClient.js";

/** A fake completer: returns a canned reply, or throws, and records whether it was called. */
function fakeLLM(reply: string | (() => never)): ChatCompleter & { called: boolean } {
  return {
    called: false,
    async chat(_opts: LocalChatOpts): Promise<string> {
      this.called = true;
      if (typeof reply === "function") return reply();
      return reply;
    },
  };
}

test("isLastSessionQuestion: routes recency+session-noun questions, leaves general Q&A alone", () => {
  for (const q of ["what happened in my last run?", "how did my latest ride go?", "feedback on today's session", "analyse my most recent swim"]) {
    assert.equal(isLastSessionQuestion(q), true, q);
  }
  for (const q of ["how were my long rides this month?", "am I overtraining?", "what's my FTP?", "how is my fitness trending?"]) {
    assert.equal(isLastSessionQuestion(q), false, q);
  }
});

test("parseIntentReply: tolerates small-model noise in casing, punctuation, and wrapping words", () => {
  assert.equal(parseIntentReply("LAST_SESSION"), "last_session");
  assert.equal(parseIntentReply("last session"), "last_session");
  assert.equal(parseIntentReply("Last-Session."), "last_session");
  assert.equal(parseIntentReply("The answer is: GENERAL"), "general");
  assert.equal(parseIntentReply("general\n"), "general");
  assert.equal(parseIntentReply("I am not sure"), null);
  assert.equal(parseIntentReply(""), null);
});

test("classifyIntent: regex match short-circuits — no model call", async () => {
  const llm = fakeLLM(() => {
    throw new Error("should not be called");
  });
  const res = await classifyIntent("how did my last run go?", llm);
  assert.deepEqual(res, { intent: "last_session", source: "regex" });
  assert.equal(llm.called, false);
});

test("classifyIntent: regex miss with no local model defaults to general (source regex)", async () => {
  const res = await classifyIntent("break down Tuesday's ride", null);
  assert.deepEqual(res, { intent: "general", source: "regex" });
});

test("classifyIntent: local model catches a paraphrase the regex misses", async () => {
  const llm = fakeLLM("LAST_SESSION");
  const res = await classifyIntent("break down Tuesday's ride", llm);
  assert.deepEqual(res, { intent: "last_session", source: "local-model" });
  assert.equal(llm.called, true);
});

test("classifyIntent: local model can confirm a general question", async () => {
  const llm = fakeLLM("GENERAL");
  const res = await classifyIntent("how's my training going overall?", llm);
  assert.deepEqual(res, { intent: "general", source: "local-model" });
});

test("classifyIntent: unparseable reply falls back to general (source fallback)", async () => {
  const llm = fakeLLM("hmm, maybe?");
  const res = await classifyIntent("break down Tuesday's ride", llm);
  assert.deepEqual(res, { intent: "general", source: "fallback" });
});

test("classifyIntent: a throwing/unavailable local model falls back to general", async () => {
  const llm = fakeLLM(() => {
    throw new Error("connection refused");
  });
  const res = await classifyIntent("break down Tuesday's ride", llm);
  assert.deepEqual(res, { intent: "general", source: "fallback" });
});
