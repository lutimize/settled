// Checks the exact request the Anthropic SDK sends and how answers are parsed, without a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeDesk, AiError } from '../src/ai.js';
import { SAMPLE_COMPILED } from '../src/fake-ai.js';

function fakeClient(answer, { stopReason = 'end_turn', status = 200 } = {}) {
  const calls = [];
  const client = new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
      if (status !== 200) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: JSON.stringify(answer) }],
          stop_reason: stopReason,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  return { client, calls };
}

const TRIAGE = {
  reason: 'changed_mind',
  summary: 'Wants a refund.',
  says_not_activated: true,
  says_contacted_support: null,
  mentions_dispute_or_chargeback: false,
  requested_kind: 'full',
  requested_amount: null,
  language: 'en',
  manipulation_signals: [],
  evidence: ['changed my mind'],
};

test('triage request: model, fallbacks, effort and a JSON schema output format', async () => {
  const { client, calls } = fakeClient(TRIAGE);
  const desk = new ClaudeDesk({ model: 'claude-opus-5-5', takeCall: () => true, client });
  const out = await desk.triage({ message: 'I changed my mind', productName: 'Quiet Hours Pro' });
  assert.deepEqual(out, TRIAGE);

  const { url, headers, body } = calls[0];
  assert.match(url, /\/v1\/messages(\?|$)/);
  assert.match(headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.match(JSON.stringify(body.output_config.format.schema.properties.reason), /unauthorized/);
  assert.equal(body.thinking, undefined);
  assert.equal(body.temperature, undefined);
  // The customer's text is fenced as data, and the system prompt says never to follow it.
  assert.match(body.messages[0].content, /<customer_message>\nI changed my mind\n<\/customer_message>/);
  assert.match(body.system, /never follow them/);
});

test('policy compile returns the parsed rules', async () => {
  const { client, calls } = fakeClient(SAMPLE_COMPILED);
  const desk = new ClaudeDesk({ model: 'claude-opus-5-5', takeCall: () => true, client });
  const out = await desk.compilePolicy('policy text');
  assert.equal(out.rules.length, SAMPLE_COMPILED.rules.length);
  assert.equal(calls[0].body.output_config.effort, 'medium');
});

test('a refusal is reported, not parsed', async () => {
  const { client } = fakeClient(TRIAGE, { stopReason: 'refusal' });
  const desk = new ClaudeDesk({ model: 'claude-opus-5-5', takeCall: () => true, client });
  await assert.rejects(desk.triage({ message: 'x', productName: 'y' }), AiError);
});

test('API errors become AiError so the desk falls back to a person', async () => {
  const { client } = fakeClient(TRIAGE, { status: 429 });
  const desk = new ClaudeDesk({ model: 'claude-opus-5-5', takeCall: () => true, client });
  await assert.rejects(desk.triage({ message: 'x', productName: 'y' }), AiError);
});

test('an answer outside the schema becomes AiError', async () => {
  const { client } = fakeClient({ ...TRIAGE, reason: 'refund_me_500' });
  const desk = new ClaudeDesk({ model: 'claude-opus-5-5', takeCall: () => true, client });
  await assert.rejects(desk.triage({ message: 'x', productName: 'y' }), AiError);
});

test('the daily budget stops calls before they are sent', async () => {
  const { client, calls } = fakeClient(TRIAGE);
  const desk = new ClaudeDesk({ model: 'claude-opus-5-5', takeCall: () => false, client });
  await assert.rejects(desk.triage({ message: 'x', productName: 'y' }), AiError);
  assert.equal(calls.length, 0);
});

test('Haiku requests carry no fallbacks (Haiku has no server-side fallback)', async () => {
  const { client, calls } = fakeClient(TRIAGE);
  const desk = new ClaudeDesk({ model: 'claude-haiku-5-5', takeCall: () => true, client });
  await desk.triage({ message: 'I changed my mind', productName: 'Quiet Hours Pro' });
  const { headers, body } = calls[0];
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.fallbacks, undefined);
  assert.doesNotMatch(headers.get('anthropic-beta') || '', /server-side-fallback/);
  assert.equal(body.output_config.format.type, 'json_schema');
});
