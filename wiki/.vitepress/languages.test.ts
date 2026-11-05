import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  alternates,
  languageKey,
  languageOf,
  neutralPaths,
  neutralStub,
  otherLanguageLink,
  rememberLanguage,
} from "./languages.js";

const base = "/ticket-runner/";

type Visit = {
  pathname: string;
  search?: string;
  hash?: string;
  languages?: string[];
  stored?: string | null;
  storage?: "throws";
};

// Runs the stub's inline script as a browser would on arriving at the neutral URL,
// and returns where it sent the reader.
function visit(html: string, v: Visit): string | undefined {
  const script = /^<!doctype html>\s*<html[^>]*>\s*<head>\s*<script>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  if (script === undefined) throw new Error("the stub's head does not start with an inline script");
  let replaced: string | undefined;
  const store = new Map<string, string>();
  if (v.stored != null) store.set("ticket-runner:wiki-language", v.stored);
  const localStorage = { getItem: (k: string) => store.get(k) ?? null };
  runInNewContext(script, {
    location: {
      pathname: v.pathname,
      search: v.search ?? "",
      hash: v.hash ?? "",
      replace: (url: string) => (replaced = url),
    },
    navigator: { languages: v.languages ?? ["en-US"], language: (v.languages ?? ["en-US"])[0] },
    get localStorage() {
      if (v.storage === "throws") throw new Error("SecurityError");
      return localStorage;
    },
  });
  return replaced;
}

describe("a neutral URL's stub", () => {
  const stub = neutralStub(base, "guide/running");

  it("sends a reader whose browser ranks Korean first among ko and en to the Korean page", () => {
    expect(visit(stub, { pathname: "/ticket-runner/guide/running", languages: ["ja", "ko", "en"] })).toBe(
      "/ticket-runner/ko/guide/running",
    );
  });

  it("sends a reader whose browser ranks English first among ko and en to the English page", () => {
    expect(visit(stub, { pathname: "/ticket-runner/guide/running", languages: ["en-US", "ko"] })).toBe(
      "/ticket-runner/en/guide/running",
    );
  });

  it("reads ko-KR as Korean", () => {
    expect(visit(stub, { pathname: "/ticket-runner/guide/running", languages: ["ko-KR"] })).toBe(
      "/ticket-runner/ko/guide/running",
    );
  });

  it("sends a reader whose browser lists neither language to English", () => {
    expect(visit(stub, { pathname: "/ticket-runner/guide/running", languages: ["ja", "fr"] })).toBe(
      "/ticket-runner/en/guide/running",
    );
  });

  it("puts a remembered pick before the browser's languages", () => {
    expect(visit(stub, { pathname: "/ticket-runner/guide/running", languages: ["ko"], stored: "en" })).toBe(
      "/ticket-runner/en/guide/running",
    );
    expect(visit(stub, { pathname: "/ticket-runner/guide/running", languages: ["en"], stored: "ko" })).toBe(
      "/ticket-runner/ko/guide/running",
    );
  });

  it("ignores a stored value that names no language", () => {
    expect(visit(stub, { pathname: "/ticket-runner/guide/running", languages: ["ko"], stored: "fr" })).toBe(
      "/ticket-runner/ko/guide/running",
    );
  });

  it("treats storage that cannot be read as no pick", () => {
    expect(visit(stub, { pathname: "/ticket-runner/guide/running", languages: ["ko"], storage: "throws" })).toBe(
      "/ticket-runner/ko/guide/running",
    );
  });

  it("keeps the query and the anchor", () => {
    expect(
      visit(stub, { pathname: "/ticket-runner/guide/running", search: "?a=1", hash: "#lanes", languages: ["ko"] }),
    ).toBe("/ticket-runner/ko/guide/running?a=1#lanes");
  });

  it("keeps the path it was reached by, .html included", () => {
    expect(visit(stub, { pathname: "/ticket-runner/guide/running.html", languages: ["en"] })).toBe(
      "/ticket-runner/en/guide/running.html",
    );
  });

  it("sends the neutral home to a language's home", () => {
    const home = neutralStub(base, "");
    expect(visit(home, { pathname: "/ticket-runner/", languages: ["ko"] })).toBe("/ticket-runner/ko/");
    expect(visit(home, { pathname: "/ticket-runner", languages: ["en"] })).toBe("/ticket-runner/en/");
  });

  it("loads no stylesheet or script of its own", () => {
    expect(stub).not.toMatch(/<link\b/i);
    expect(stub).not.toMatch(/<script[^>]*\bsrc=/i);
    expect(stub).not.toMatch(/<style\b/i);
  });

  it("sends a reader without JavaScript to the English page and links both languages", () => {
    expect(stub).toMatch(
      /<noscript><meta http-equiv="refresh" content="0; url=\/ticket-runner\/en\/guide\/running"><\/noscript>/,
    );
    const body = /<body>([\s\S]*)<\/body>/.exec(stub)?.[1] ?? "";
    expect(body).toContain('href="/ticket-runner/en/guide/running"');
    expect(body).toContain('href="/ticket-runner/ko/guide/running"');
  });
});

describe("the neutral URLs the build writes", () => {
  it("are the home and every page of the page list", () => {
    const sections = [
      { pages: [{ link: "/guide/installation" }, { link: "/guide/planning" }] },
      { pages: [{ link: "/guide/internals" }] },
    ];
    expect(neutralPaths(sections)).toEqual(["", "guide/installation", "guide/planning", "guide/internals"]);
  });
});

describe("a page's alternates", () => {
  const site = "https://jjongs2.github.io";

  it("name both languages and the neutral URL, as absolute URLs on the published site", () => {
    expect(alternates(site, base, "ko/guide/running.md")).toEqual([
      ["link", { rel: "alternate", hreflang: "en", href: "https://jjongs2.github.io/ticket-runner/en/guide/running" }],
      ["link", { rel: "alternate", hreflang: "ko", href: "https://jjongs2.github.io/ticket-runner/ko/guide/running" }],
      ["link", { rel: "alternate", hreflang: "x-default", href: "https://jjongs2.github.io/ticket-runner/guide/running" }],
    ]);
  });

  it("are the homes for a home page", () => {
    expect(alternates(site, base, "en/index.md").map(([, a]) => a.href)).toEqual([
      "https://jjongs2.github.io/ticket-runner/en/",
      "https://jjongs2.github.io/ticket-runner/ko/",
      "https://jjongs2.github.io/ticket-runner/",
    ]);
  });

  it("are none for the 404", () => {
    expect(alternates(site, base, "404.md")).toEqual([]);
  });
});

describe("the language a path names", () => {
  it("is the prefix after the base", () => {
    expect(languageOf("/ticket-runner/ko/guide/running", base)).toEqual({ language: "ko", rest: "guide/running" });
    expect(languageOf("/ticket-runner/en/", base)).toEqual({ language: "en", rest: "" });
  });

  it("is none for a neutral URL", () => {
    expect(languageOf("/ticket-runner/guide/running", base)).toBeNull();
    expect(languageOf("/ticket-runner/", base)).toBeNull();
  });
});

describe("the language menu's link on a not-found page", () => {
  it("is the same path under the other language's prefix", () => {
    expect(otherLanguageLink("/ticket-runner/ko/guide/nope", base)).toBe("/en/guide/nope");
    expect(otherLanguageLink("/ticket-runner/en/guide/running", base)).toBe("/ko/guide/running");
  });

  it("is the other language's home for a language's home", () => {
    expect(otherLanguageLink("/ticket-runner/en/", base)).toBe("/ko/");
    expect(otherLanguageLink("/ticket-runner/ko", base)).toBe("/en/");
  });

  it("is none for a path that names no language", () => {
    expect(otherLanguageLink("/ticket-runner/guide/nope", base)).toBeNull();
    expect(otherLanguageLink("/ticket-runner/", base)).toBeNull();
  });
});

describe("a pick the language menu records", () => {
  it("is what a neutral URL then follows, under a key naming ticket-runner", () => {
    const store = new Map<string, string>();
    rememberLanguage(() => ({ setItem: (k: string, v: string) => void store.set(k, v) }), "ko");
    expect([...store.keys()]).toEqual(["ticket-runner:wiki-language"]);
    const stub = neutralStub(base, "guide/running");
    expect(visit(stub, { pathname: "/ticket-runner/guide/running", languages: ["en"], stored: store.get(languageKey) ?? null })).toBe(
      "/ticket-runner/ko/guide/running",
    );
  });

  it("throws nothing when storage cannot be written", () => {
    const blocked = () => {
      throw new Error("SecurityError");
    };
    expect(() => rememberLanguage(blocked, "ko")).not.toThrow();
    expect(() => rememberLanguage(() => ({ setItem: blocked }), "ko")).not.toThrow();
  });
});
