// R2-4: the panel's quiet colours meet critique-2 §6's contrast targets in both themes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { infoContrast, infoTones } from "../model.js";

const theme = (name) => JSON.parse(readFileSync(new URL(`../../../themes/nix-islands-b-${name}.json`, import.meta.url), "utf8")).colors;

for (const name of ["dark", "light"]) {
  test(`${name}: meter, chevron and guide colours meet their targets`, () => {
    const t = theme(name), c = infoTones(t);
    assert.ok(infoContrast(c.track, t.chrome) >= 1.25, `track ${infoContrast(c.track, t.chrome)}`);
    assert.ok(infoContrast(c.fill, c.track) >= 3.5, `fill ${infoContrast(c.fill, c.track)}`);
    assert.ok(infoContrast(c.notch, t.chrome) >= 3, `notch ${infoContrast(c.notch, t.chrome)}`);
    assert.ok(infoContrast(c.chevron, t.chrome) >= 3, `chevron ${infoContrast(c.chevron, t.chrome)}`);
    const g = infoContrast(c.guide, t.chrome);
    assert.ok(g >= 1.3 && g <= 1.5, `guide ${g}`);
  });
  test(`${name}: code blocks sit one step above the island`, () => {
    const t = theme(name), c = infoTones(t);
    assert.equal(c.code, t.surface);
  });
}

test("contrast is WCAG's", () => {
  assert.equal(Math.round(infoContrast("#000000", "#ffffff") * 100) / 100, 21);
  assert.equal(infoContrast("#777777", "#777777"), 1);
});
