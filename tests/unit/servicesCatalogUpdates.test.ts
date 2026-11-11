import test from "node:test";
import assert from "node:assert/strict";
import { getSubcategoryById, validateSpecs } from "../../services-tree";

const CLEARANCE = "Кліренс (см)";

test("підкатегорія 3.2 називається «Трактор+причепні»", () => {
  assert.equal(getSubcategoryById("3.2")?.name, "Трактор+причепні");
});

test("у «Трактор+причепні» та «Самохідні» є клиренс 300 см", () => {
  for (const id of ["3.2", "3.3"]) {
    const spec = getSubcategoryById(id)?.specs?.find((s) => s.name === CLEARANCE);
    assert.ok(spec, `клиренс є для ${id}`);
    assert.ok(spec.options?.includes(300), `300 см доступні для ${id}`);
  }
});

test("заказ з клиренсом 300 см проходить валідацію специфікацій", () => {
  const errors = validateSpecs("3.2.1", "3.2", {
    "Ширина внесення штанги (м)": 18,
    [CLEARANCE]: 300,
  });
  assert.deepEqual(errors, []);
});
