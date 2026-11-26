import test from 'node:test';
import assert from 'node:assert/strict';
import { clearToasts, dismiss, notify, toasts } from '../web/src/lib/toasts.js';

test('micro notifications are added, dismissed and cleared', () => {
  clearToasts();
  const id = notify('Тестирование недоступно', 'error', 0);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].message, 'Тестирование недоступно');
  assert.equal(toasts[0].type, 'error');
  dismiss(id);
  assert.equal(toasts.length, 0);

  notify('a', 'info', 0);
  notify('b', 'success', 0);
  assert.equal(toasts.length, 2);
  clearToasts();
  assert.equal(toasts.length, 0);
});
