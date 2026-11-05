// What makes the wiki open in the reader's language. Every page has three URLs under
// the base: `/en/…` and `/ko/…`, which never redirect, and a language-neutral one
// without a prefix, which is a static stub the build writes from the page list and
// which sends the reader on to one of the other two. Nothing here imports VitePress or
// Node, so the theme can use it in the browser and the build can use it in Node.

export type Language = "en" | "ko";

// Every Pages site of the account shares the origin, so the key names the wiki's owner.
export const languageKey = "ticket-runner:wiki-language";

// Records a pick from the language menu. Storage that cannot be written leaves the
// reader with no pick, and nothing fails.
export function rememberLanguage(storage: () => { setItem(key: string, value: string): void }, language: Language): void {
  try {
    storage().setItem(languageKey, language);
  } catch {
    // Nothing to do: the next neutral URL falls back to the browser's languages.
  }
}

// The language a path on the site names, and the path after it: `/ticket-runner/ko/guide/x`
// is Korean's `guide/x`. Null for a path that names none.
export function languageOf(pathname: string, base: string): { language: Language; rest: string } | null {
  if (!pathname.startsWith(base)) return null;
  const match = /^(en|ko)(?:\/|$)(.*)$/.exec(pathname.slice(base.length));
  return match ? { language: match[1] as Language, rest: match[2] ?? "" } : null;
}

// The language menu's link on a not-found page at `pathname`: the same path under the
// other language's prefix, without the base, as the theme writes its links. Null for a
// path that names no language, where the theme shows no language menu.
export function otherLanguageLink(pathname: string, base: string): string | null {
  const page = languageOf(pathname, base);
  if (!page) return null;
  return `/${page.language === "en" ? "ko" : "en"}/${page.rest}`;
}

// The stub's script, in the plain JavaScript every browser runs, since a stub loads
// nothing: a remembered pick, else the first of the browser's languages whose primary
// subtag is ko or en, else English. Storage that cannot be read counts as no pick.
function redirectScript(base: string): string {
  return `(function () {
var base = ${JSON.stringify(base)}, lang = null;
try { lang = localStorage.getItem(${JSON.stringify(languageKey)}); } catch (e) {}
if (lang !== "en" && lang !== "ko") {
  lang = "en";
  var prefs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language];
  for (var i = 0; i < prefs.length; i++) {
    var primary = String(prefs[i] || "").toLowerCase().split("-")[0];
    if (primary === "ko" || primary === "en") { lang = primary; break; }
  }
}
var path = location.pathname;
var rest = path.indexOf(base) === 0 ? path.slice(base.length) : path + "/" === base ? "" : path.replace(/^\\//, "");
location.replace(base + lang + "/" + rest + location.search + location.hash);
})();`;
}

// Korean link text as character references, so the stub reads right whatever charset
// the browser assumes before it reaches the meta tag.
function characterReferences(text: string): string {
  return text.replace(/[^\x00-\x7f]/g, (c) => `&#${c.codePointAt(0)};`);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// The page served at a neutral URL: `path` is the page's path after the base, empty for
// the home. Its head starts with the script, and it loads no stylesheet or theme, so
// nothing is drawn before the redirect. Without JavaScript it sends the reader to the
// English page, which keeps the path but not the query or anchor.
export function neutralStub(base: string, path: string): string {
  const en = escapeHtml(`${base}en/${path}`);
  const ko = escapeHtml(`${base}ko/${path}`);
  return `<!doctype html>
<html lang="en">
<head>
<script>${redirectScript(base)}</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ticket-runner</title>
<noscript><meta http-equiv="refresh" content="0; url=${en}"></noscript>
</head>
<body>
<p><a href="${en}" lang="en">English</a> &middot; <a href="${ko}" lang="ko">${characterReferences("한국어")}</a></p>
</body>
</html>
`;
}

// The neutral URLs the build writes a stub for: the home, and every page of the list
// that drives both sidebars, as paths after the base.
export function neutralPaths(sections: readonly { pages: readonly { link: string }[] }[]): string[] {
  return ["", ...sections.flatMap((s) => s.pages.map((p) => p.link.replace(/^\//, "")))];
}

type HeadLink = ["link", { rel: "alternate"; hreflang: string; href: string }];

// The `hreflang` alternates of the page at `relativePath` (`ko/guide/running.md`), as
// absolute URLs on the published site: each language's version and the neutral URL as
// `x-default`. None for a file that is no page of either language, such as the 404.
export function alternates(origin: string, base: string, relativePath: string): HeadLink[] {
  const match = /^(?:en|ko)\/(.*)\.md$/.exec(relativePath);
  if (!match) return [];
  const path = (match[1] ?? "").replace(/(^|\/)index$/, "$1");
  const url = (prefix: string) => `${origin}${base}${prefix}${path}`;
  return [
    ["link", { rel: "alternate", hreflang: "en", href: url("en/") }],
    ["link", { rel: "alternate", hreflang: "ko", href: url("ko/") }],
    ["link", { rel: "alternate", hreflang: "x-default", href: url("") }],
  ];
}
