import assert from "node:assert/strict";
import { test } from "node:test";
import { Pairing, PairingError, hashToken } from "../src/pairing.ts";
import type { PairedClient } from "../src/types.ts";

function setup() {
  let now = 1_000_000;
  const clients: PairedClient[] = [];
  const p = new Pairing({ clients, now: () => now, onChange: () => {} });
  return { p, clients, tick: (ms: number) => { now += ms; } };
}

test("a code confirms once and gives a token that verifies", () => {
  const { p, clients } = setup();
  p.start("laptop agent");
  const [{ code, client }] = p.pending();
  assert.match(code, /^\d{6}$/);
  assert.equal(client, "laptop agent");
  const { token, id } = p.confirm(code);
  assert.equal(p.verify(token)?.id, id);
  assert.equal(p.verify("nope"), null);
  assert.deepEqual(p.pending(), []);
  assert.throws(() => p.confirm(code), PairingError);
  // Stored hashed, never as given.
  assert.equal(clients.length, 1);
  assert.equal(clients[0].hash, hashToken(token));
  assert.ok(!JSON.stringify(clients).includes(token));
});

test("codes expire after two minutes", () => {
  const { p, tick } = setup();
  p.start("a");
  const { code } = p.pending()[0];
  tick(121_000);
  assert.deepEqual(p.pending(), []);
  assert.throws(() => p.confirm(code), /expired|invalid/i);
});

test("starting pairings is rate limited", () => {
  const { p, tick } = setup();
  for (let i = 0; i < 3; i++) p.start(`c${i}`);
  assert.throws(() => p.start("c4"), /too many/i);
  tick(61_000);
  assert.doesNotThrow(() => p.start("c5"));
});

test("wrong codes lock confirmation for a while, and kill pending codes", () => {
  const { p, tick } = setup();
  p.start("a");
  const { code } = p.pending()[0];
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) assert.throws(() => p.confirm(wrong), /invalid/i);
  assert.throws(() => p.confirm(code), /too many/i);
  tick(61_000);
  assert.throws(() => p.confirm(code), /invalid|expired/i);
});

test("clients are listed without their hash and can be revoked", () => {
  const { p } = setup();
  p.start("a");
  const { token, id } = p.confirm(p.pending()[0].code);
  const [listed] = p.list();
  assert.equal(listed.id, id);
  assert.equal(listed.name, "a");
  assert.equal((listed as any).hash, undefined);
  assert.ok(p.revoke(id));
  assert.equal(p.verify(token), null);
  assert.deepEqual(p.list(), []);
});

test("verify records when a client was last seen", () => {
  const { p, tick, clients } = setup();
  p.start("a");
  const { token } = p.confirm(p.pending()[0].code);
  tick(5000);
  p.verify(token);
  assert.equal(clients[0].lastUsedAt, 1_005_000);
});
