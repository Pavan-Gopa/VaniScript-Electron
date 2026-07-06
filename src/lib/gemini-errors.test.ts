import test from 'node:test';
import assert from 'node:assert/strict';

import { formatGeminiError, isRetryableGeminiError } from './gemini-errors';

test('isRetryableGeminiError detects temporary overload and unavailable responses', () => {
  assert.equal(
    isRetryableGeminiError(`503 UNAVAILABLE. {'error': {'code': 503, 'message': 'The model is overloaded. Please try again later.', 'status': 'UNAVAILABLE'}}`),
    true
  );
  assert.equal(
    isRetryableGeminiError('Error: connection aborted'),
    false
  );
});

test('formatGeminiError returns a readable transient-service message for 503 overloads', () => {
  const message = formatGeminiError(`Error: {"error":{"message":"{\\n \\"error\\": {\\"code\\": 503,\\"message\\": \\"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.\\",\\"status\\": \\"UNAVAILABLE\\"}\\n}","code":503,"status":""}}`);

  assert.match(message, /Gemini is temporarily unavailable/i);
  assert.match(message, /retry/i);
});

test('formatGeminiError preserves a short fallback message for unknown failures', () => {
  assert.equal(formatGeminiError('Something odd happened'), 'Gemini transcription failed: Something odd happened');
});
