"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const NestPlateau = require("../main/util/plateau.js");

test("does not stop while fitness keeps improving", () => {
  const p = NestPlateau.create({
    enabled: true,
    plateauGenerations: 3,
    plateauSeconds: 0,
    minGenerations: 1,
  });
  p.reset(0);

  for (let g = 0; g < 8; g++) {
    const decision = p.onGeneration([100 - g, 110 - g], 1000 + g);
    assert.equal(decision.stop, false, "stopped early at generation " + (g + 1));
    assert.equal(decision.generation, g + 1);
    assert.equal(decision.generationsWithoutImprovement, 0);
  }
});

test("stops after N generations without improvement", () => {
  const p = NestPlateau.create({
    enabled: true,
    plateauGenerations: 3,
    plateauSeconds: 0,
    minGenerations: 1,
  });
  p.reset(0);

  const first = p.onGeneration([50, 80], 1000);
  assert.equal(first.stop, false);
  assert.equal(first.bestFitness, 50);

  assert.equal(p.onGeneration([50, 70], 2000).stop, false); // stale 1
  assert.equal(p.onGeneration([52, 50], 3000).stop, false); // stale 2 (equal is not improvement)
  const stopped = p.onGeneration([50, 61], 4000);
  assert.equal(stopped.stop, true);
  assert.equal(stopped.reason, "generations");
  assert.equal(stopped.generationsWithoutImprovement, 3);
  assert.equal(stopped.generation, 4);
});

test("tiny floating-point jitter does not count as improvement", () => {
  const p = NestPlateau.create({
    enabled: true,
    plateauGenerations: 2,
    plateauSeconds: 0,
    epsilon: 1e-9,
  });
  p.reset(0);
  p.onGeneration(10, 0);
  p.onGeneration(10 - 1e-12, 1);
  const stopped = p.onGeneration(10 - 1e-12, 2);
  assert.equal(stopped.stop, true);
});

test("stops after M seconds without improvement once a generation has finished", () => {
  const p = NestPlateau.create({
    enabled: true,
    plateauGenerations: 0,
    plateauSeconds: 5,
    minGenerations: 1,
  });
  p.reset(1000);
  assert.equal(p.onGeneration([20], 1000).stop, false);

  assert.equal(p.evaluate(5000).stop, false);

  const stopped = p.evaluate(1000 + 5000);
  assert.equal(stopped.stop, true);
  assert.equal(stopped.reason, "time");
});

test("time stop does not fire before the first generation completes", () => {
  const p = NestPlateau.create({
    enabled: true,
    plateauGenerations: 0,
    plateauSeconds: 1,
    minGenerations: 1,
  });
  p.reset(0);
  p.onResult(42, 0);
  assert.equal(p.evaluate(10 * 1000).stop, false, "must finish at least one generation");
  p.onGeneration([42], 10 * 1000);
  assert.equal(p.evaluate(10 * 1000 + 999).stop, false);
  assert.equal(p.evaluate(10 * 1000 + 1000).stop, true);
});

test("mid-generation improvement is not counted as a stale generation", () => {
  const p = NestPlateau.create({
    enabled: true,
    plateauGenerations: 2,
    plateauSeconds: 0,
  });
  p.reset(0);
  p.onResult(40, 0);
  const gen1 = p.onGeneration([40, 90], 1);
  assert.equal(gen1.stop, false);
  assert.equal(gen1.generationsWithoutImprovement, 0);

  p.onResult(40, 2);
  const gen2 = p.onGeneration([40, 41], 3);
  assert.equal(gen2.generationsWithoutImprovement, 1);
  assert.equal(gen2.stop, false);

  const gen3 = p.onGeneration([40], 4);
  assert.equal(gen3.stop, true);
  assert.equal(gen3.generationsWithoutImprovement, 2);
});

test("onResult resets the time clock when a better nest arrives mid-generation", () => {
  const p = NestPlateau.create({
    enabled: true,
    plateauGenerations: 0,
    plateauSeconds: 5,
    minGenerations: 1,
  });
  p.reset(0);
  p.onGeneration([30], 0);
  p.onResult(30, 4000);
  assert.equal(p.evaluate(4000).stop, false);
  p.onResult(25, 4000); // improvement
  assert.equal(p.evaluate(8000).stop, false, "clock should have reset");
  assert.equal(p.evaluate(4000 + 5000).stop, true);
});

test("disabled detector never stops", () => {
  const p = NestPlateau.create({
    enabled: false,
    plateauGenerations: 1,
    plateauSeconds: 1,
  });
  p.reset(0);
  p.onGeneration([1], 0);
  p.onGeneration([1], 10 * 1000);
  assert.equal(p.evaluate(60 * 1000).stop, false);
});

test("zero limits mean manual stop only", () => {
  const p = NestPlateau.create({
    enabled: true,
    plateauGenerations: 0,
    plateauSeconds: 0,
  });
  p.reset(0);
  for (let i = 0; i < 50; i++) {
    assert.equal(p.onGeneration([9], i * 1000).stop, false);
  }
});

test("either limit can fire, and both together report plateau", () => {
  const gensOnly = NestPlateau.create({
    enabled: true,
    plateauGenerations: 1,
    plateauSeconds: 0,
  });
  gensOnly.reset(0);
  gensOnly.onGeneration([5], 0);
  assert.equal(gensOnly.onGeneration([5], 999999).reason, "generations");

  const timeOnly = NestPlateau.create({
    enabled: true,
    plateauGenerations: 0,
    plateauSeconds: 5,
  });
  timeOnly.reset(0);
  timeOnly.onGeneration([5], 0);
  assert.equal(timeOnly.evaluate(5000).reason, "time");

  const both = NestPlateau.create({
    enabled: true,
    plateauGenerations: 1,
    plateauSeconds: 5,
  });
  both.reset(0);
  both.onGeneration([5], 0);
  const stopped = both.onGeneration([5], 6000);
  assert.equal(stopped.stop, true);
  assert.equal(stopped.reason, "plateau");
});

test("resume clears stall so a restarted nest does not immediately halt", () => {
  const p = NestPlateau.create({
    enabled: true,
    plateauGenerations: 1,
    plateauSeconds: 0,
  });
  p.reset(0);
  p.onGeneration([8], 0);
  const stopped = p.onGeneration([8], 1);
  assert.equal(stopped.stop, true);

  p.resume(100);
  assert.equal(p.snapshot(100).state, "running");
  assert.equal(p.evaluate(100).stop, false);
  assert.equal(p.snapshot(100).bestFitness, 8);
  assert.equal(p.onGeneration([8], 101).stop, true);
});

test("resume keeps the best result across a time-limit stop", () => {
  const p = NestPlateau.create({
    enabled: true,
    plateauGenerations: 0,
    plateauSeconds: 10,
    minGenerations: 1,
  });
  p.reset(0);
  p.onGeneration([12], 0);
  p.onResult(9, 1000);
  assert.equal(p.evaluate(1000 + 10000).stop, true);
  assert.equal(p.snapshot().bestFitness, 9);

  p.resume(20000);
  assert.equal(p.snapshot(20000).bestFitness, 9);
  assert.equal(p.evaluate(20000).stop, false);
  // Equal to the kept best is not a new improvement, but the clock was cleared.
  assert.equal(p.onResult(9, 20000).stop, false);
  assert.equal(p.onResult(8, 21000).stop, false);
  assert.equal(p.snapshot(21000).bestFitness, 8);
});

test("enabled detector breaks the legacy infinite-generation loop", () => {
  const maxSafety = 200;

  const disabled = NestPlateau.create({
    enabled: false,
    plateauGenerations: 3,
    plateauSeconds: 0,
  });
  disabled.reset(0);
  let generations = 0;
  while (generations < maxSafety) {
    if (disabled.onGeneration([10], generations).stop) {
      break;
    }
    generations++;
  }
  assert.equal(generations, maxSafety, "disabled search must keep going like the old engine");

  const enabled = NestPlateau.create({
    enabled: true,
    plateauGenerations: 3,
    plateauSeconds: 0,
  });
  enabled.reset(0);
  generations = 0;
  let stopped = false;
  while (generations < maxSafety) {
    if (enabled.onGeneration([10], generations).stop) {
      stopped = true;
      break;
    }
    generations++;
  }
  assert.equal(stopped, true);
  assert.equal(generations, 3);
});

test("status text is human readable", () => {
  const running = NestPlateau.formatStatus({
    state: "running",
    generation: 4,
    bestFitness: 12.5,
    generationsWithoutImprovement: 2,
  });
  assert.ok(running.indexOf("Generation 4") !== -1);
  assert.ok(running.indexOf("no improvement for 2 generations") !== -1);

  const msg = NestPlateau.formatStopMessage({
    reason: "generations",
    generationsWithoutImprovement: 10,
  });
  assert.ok(msg.indexOf("10 generations") !== -1);
  assert.ok(msg.indexOf("export") !== -1);
});
