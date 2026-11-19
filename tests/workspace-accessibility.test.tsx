import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createSampleSession } from '../server/sampleData.ts';
import { BidWorkspacePanel } from '../src/components/BidWorkspacePanel.tsx';

test('sample workspace names its buttons, spells out statuses, and announces refusal', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    fetch: globalThis.fetch,
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById('root')!);
  const session = createSampleSession();
  const noop = () => {};
  try {
    await act(async () => root.render(
      <BidWorkspacePanel
        open
        session={session}
        initialTab="Findings"
        language="Eng"
        onClose={noop}
        onSessionUpdate={noop}
        onStartNewAnalysis={noop}
        onClearSession={noop}
      />
    ));
    const buttons = [...dom.window.document.querySelectorAll('button')]
      .filter(button => button.getClientRects().length || !button.hidden);
    for (const button of buttons) {
      const name = button.getAttribute('aria-label') || button.textContent?.trim();
      assert.ok(name, 'Visible button needs an accessible name');
    }
    for (const label of ['PASS', 'BLOCKER', 'REVIEW']) {
      assert.ok([...dom.window.document.querySelectorAll('span')]
        .some(span => span.textContent?.trim() === label), `${label} must be visible text`);
    }
    const blocker = buttons.find(button => button.textContent?.includes('Valid ISO 9001'));
    assert.ok(blocker);
    await act(async () => blocker.click());
    const approve = [...dom.window.document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === 'Approve');
    assert.ok(approve);
    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: false,
      session,
      message: 'Cannot approve R2: its validation status is EXPIRED.',
    }), { status: 422, headers: { 'Content-Type': 'application/json' } });
    await act(async () => approve.click());
    const announced = dom.window.document.querySelector('[role="status"], [role="alert"]');
    assert.ok(announced);
    assert.match(announced.textContent || '', /Cannot approve R2: its validation status is EXPIRED./);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = previous.fetch;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous.window });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previous.document });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator });
    dom.window.close();
  }
});
