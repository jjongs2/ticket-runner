import { describe, expect, it } from "vitest";
import { tickCriteria } from "./criteria.js";

describe("ticking a criterion", () => {
  it("ticks the box whose text a Verdict met", () => {
    const body = ["## Acceptance criteria", "", "- [ ] it works", "- [ ] it is documented"].join("\n");

    expect(tickCriteria(body, ["it works"])).toBe(
      ["## Acceptance criteria", "", "- [x] it works", "- [ ] it is documented"].join("\n"),
    );
  });

  it("leaves every box the Verdict did not name unticked", () => {
    const body = "- [ ] it works\n- [ ] the docs say so";

    expect(tickCriteria(body, ["it works"])).toBe("- [x] it works\n- [ ] the docs say so");
  });

  it("keeps the bullet, the indent and the text exactly as they were", () => {
    const body = "  * [ ]   it   works  ";

    expect(tickCriteria(body, ["it works"])).toBe("  * [x]   it   works  ");
  });

  it("matches a criterion the verify Stage reported with different spacing or case", () => {
    const body = "- [ ] It works, end to end";

    expect(tickCriteria(body, ["it   works,\nend to end"])).toBe("- [x] It works, end to end");
  });

  it("leaves a box already ticked alone", () => {
    const body = "- [x] it works";

    expect(tickCriteria(body, ["it works"])).toBe(body);
  });

  it("leaves everything else in the text untouched", () => {
    const body = "Some prose about `- [ ] it works` and then:\n\n- [ ] it works";

    expect(tickCriteria(body, ["it works"])).toBe(
      "Some prose about `- [ ] it works` and then:\n\n- [x] it works",
    );
  });

  it("returns the text unchanged when nothing matched, so nothing is written back", () => {
    const body = "- [ ] it works";

    expect(tickCriteria(body, ["something else entirely"])).toBe(body);
  });

  it("ticks every box a repeated criterion matches", () => {
    const body = "- [ ] it works\n- [ ] it works";

    expect(tickCriteria(body, ["it works"])).toBe("- [x] it works\n- [x] it works");
  });
});
