import test from "node:test";
import assert from "node:assert/strict";
import { getCategoryById, getSubcategoryById, validateSpecs } from "../../services-tree";

const CLEARANCE = "Кліренс (см)";
const SPRAY = "Ширина внесення штанги (м)";

const options = (id: string, name: string) =>
  ((getSubcategoryById(id)?.specs?.find((s) => s.name === name)?.options ?? []) as number[]);

test("підкатегорія 3.2 називається «Трактор+причепні»", () => {
  assert.equal(getSubcategoryById("3.2")?.name, "Трактор+причепні");
});

test("клиренс у «Трактор+причепні» та «Самохідні»: 105–210 см, без 300", () => {
  for (const id of ["3.2", "3.3"]) {
    assert.deepEqual(options(id, CLEARANCE), [105, 125, 135, 155, 175, 180, 190, 210]);
  }
});

test("дрони: штанга 4, 6, 7, 10 м", () => {
  assert.deepEqual(options("3.1", SPRAY), [4, 6, 7, 10]);
});

test("самохідні: штанга 18, 24, 28, 30, 32, 36, 42, 48 м", () => {
  assert.deepEqual(options("3.3", SPRAY), [18, 24, 28, 30, 32, 36, 42, 48]);
});

test("опції йдуть від меншого до більшого", () => {
  for (const [id, name] of [["3.1", SPRAY], ["3.2", CLEARANCE], ["3.3", SPRAY], ["3.3", CLEARANCE]] as const) {
    const list = options(id, name);
    assert.deepEqual(list, [...list].sort((a, b) => a - b), `${id} ${name}`);
  }
});

test("заказ зі штангою 7 м для дрона проходить валідацію", () => {
  assert.deepEqual(validateSpecs("3.1.1", "3.1", { [SPRAY]: 7 }), []);
});

test("заказ зі штангою 42 м для самохідного проходить валідацію", () => {
  assert.deepEqual(validateSpecs("3.3.1", "3.3", { [SPRAY]: 42, [CLEARANCE]: 175 }), []);
});

test("трактор+причепні: штанга 18, 24, 30 м", () => {
  assert.deepEqual(options("3.2", SPRAY), [18, 24, 30]);
});

test("клиренс 300 см більше не приймається", () => {
  const errors = validateSpecs("3.3.1", "3.3", { [SPRAY]: 32, [CLEARANCE]: 300 });
  assert.ok(errors.length > 0);
});

test("категорія 3 називається «Внесення ЗЗР, мікродобрив»", () => {
  assert.equal(getCategoryById("3")?.name, "Внесення ЗЗР, мікродобрив");
});
