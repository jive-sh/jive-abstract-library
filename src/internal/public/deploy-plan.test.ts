import { expect, test } from "bun:test";
import { Schema } from "effect";
import { DeployPlan } from "./deploy-plan";

const decode = Schema.decodeUnknownOption(DeployPlan);

test("accepts nothing to deploy, or a deploy with an absolute HTTP(S) URL", () => {
  expect(decode({ deploy: false })._tag).toBe("Some");
  expect(decode({ deploy: true, url: "https://www.npmjs.com/package/x/v/1.0.0" })._tag).toBe("Some");
  expect(decode({ deploy: true, url: "http://localhost:8080/" })._tag).toBe("Some");
});

test("rejects a deploy without a usable URL", () => {
  for (const plan of [
    { deploy: true },
    { deploy: true, url: "" },
    { deploy: true, url: "/relative" },
    { deploy: true, url: "ftp://example.com" },
    { deploy: true, url: "https://example.com/a b" },
    { deploy: "true", url: "https://example.com" },
    "https://example.com",
  ]) {
    expect(decode(plan)._tag).toBe("None");
  }
});
