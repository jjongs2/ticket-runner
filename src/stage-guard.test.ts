import { describe, expect, it } from "vitest";
import { STAGE_ENV_VAR, nestedRunRefusal } from "./stage-guard.js";

describe("nestedRunRefusal", () => {
  it("lets a human shell through", () => {
    expect(nestedRunRefusal({})).toBeUndefined();
    expect(nestedRunRefusal({ CLAUDECODE: "1" })).toBeUndefined();
  });

  it("refuses a shell that belongs to a Stage, naming the variable and the Stage", () => {
    const refusal = nestedRunRefusal({ [STAGE_ENV_VAR]: "implement" });

    expect(refusal).toContain(STAGE_ENV_VAR);
    expect(refusal).toContain("implement");
    expect(refusal).toMatch(/stage.*(may not|must not|cannot) run the pipeline/i);
  });

  it("names whichever Stage the shell came from", () => {
    expect(nestedRunRefusal({ [STAGE_ENV_VAR]: "verify" })).toContain("verify");
    expect(nestedRunRefusal({ [STAGE_ENV_VAR]: "fix" })).toContain("fix");
  });

  it("refuses a value it does not recognise, rather than assuming a human set it", () => {
    expect(nestedRunRefusal({ [STAGE_ENV_VAR]: "something-else" })).toContain(
      "something-else",
    );
  });

  it("refuses a blanked mark too, since only an unset variable is a human's shell", () => {
    expect(nestedRunRefusal({ [STAGE_ENV_VAR]: "" })).toContain(STAGE_ENV_VAR);
    expect(nestedRunRefusal({ [STAGE_ENV_VAR]: "  " })).toMatch(/belongs to a Stage/);
  });

  it("points the session at the tests and fakes instead", () => {
    expect(nestedRunRefusal({ [STAGE_ENV_VAR]: "implement" })).toMatch(/tests? and fakes/i);
  });
});
