import test from 'node:test';
import assert from 'node:assert/strict';

import { greet } from '../hello.mjs';

test('greet returns "Hello, <name>!" for a normal input', () => {
  assert.equal(greet('Ada'), 'Hello, Ada!');
});

test('greet handles the empty string', () => {
  // The name is used verbatim, so the greeting keeps the literal slot.
  assert.equal(greet(''), 'Hello, !');
});

test('greet keeps names containing spaces and non-ASCII characters', () => {
  assert.equal(greet('Ada Lovelace'), 'Hello, Ada Lovelace!');
  assert.equal(greet('李雷'), 'Hello, 李雷!');
});
