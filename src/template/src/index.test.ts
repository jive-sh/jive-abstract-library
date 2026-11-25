import { expect, test } from "bun:test";
import { greet } from "./index";

test("greet greets by name", () => {
  expect(greet("Ada")).toBe("Hello, Ada!");
});
