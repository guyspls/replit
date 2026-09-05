import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHot, applyJitter, computeDelayMs } from '../src/scheduler.js';

const base = {
  id: 't',
  intervalMs: 60_000,
  hotIntervalMs: 2_000,
  hotBeforeMs: 15 * 60_000,
  hotAfterMs: 30 * 60_000,
  jitterRatio: 0,
};

test('a known drop time turns polling hot before it lands and stays hot after', () => {
  const dropAt = 1_000_000_000;
  const t = { ...base, dropAt };
  assert.equal(isHot(t, {}, dropAt - 60 * 60_000).hot, false, 'an hour out is still cold');
  assert.equal(isHot(t, {}, dropAt - 60_000).hot, true, 'a minute out is hot');
  assert.equal(isHot(t, {}, dropAt).hot, true);
  assert.equal(isHot(t, {}, dropAt + 20 * 60_000).hot, true, 'sites run late, so stay hot after');
  assert.equal(isHot(t, {}, dropAt + 60 * 60_000).hot, false);
});

test('a live coming-soon or preorder page goes hot on its own', () => {
  assert.equal(isHot(base, { state: 'coming_soon' }).hot, true);
  assert.equal(isHot(base, { state: 'preorder' }).hot, true);
  assert.equal(isHot(base, { state: 'unknown' }).hot, false);
  assert.equal(isHot(base, { state: 'absent' }).hot, false);
  assert.equal(isHot({ ...base, alwaysHot: true }, { state: 'absent' }).hot, true);
});

test('the hot interval is what actually gets used when hot', () => {
  assert.equal(computeDelayMs(base, { state: 'unknown' }), 60_000);
  assert.equal(computeDelayMs(base, { state: 'coming_soon' }), 2_000);
});

test('repeated failures back off instead of hammering a dead URL', () => {
  assert.equal(computeDelayMs(base, { state: 'unknown', failures: 1 }), 120_000);
  assert.equal(computeDelayMs(base, { state: 'unknown', failures: 3 }), 480_000);
  // ...but the backoff is capped so a recovered target is picked up again.
  assert.equal(computeDelayMs(base, { state: 'unknown', failures: 99 }), 30 * 60_000);
});

test('jitter spreads requests without ever collapsing to zero', () => {
  assert.equal(applyJitter(10_000, 0), 10_000, 'no jitter configured means exact');
  assert.equal(applyJitter(10_000, 0.5, () => 0), 7_500);
  assert.equal(applyJitter(10_000, 0.5, () => 1), 12_500);
  assert.equal(applyJitter(10_000, 0.5, () => 0.5), 10_000);
  assert.ok(applyJitter(600, 2, () => 0) >= 500, 'never polls faster than the floor');
});

test('jitter stays inside its band across many draws', () => {
  for (let i = 0; i < 500; i += 1) {
    const v = applyJitter(20_000, 0.2);
    assert.ok(v >= 18_000 && v <= 22_000, `${v} escaped the jitter band`);
  }
});
