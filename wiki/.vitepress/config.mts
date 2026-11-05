import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type DefaultTheme } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
import { alternates, neutralPaths, neutralStub } from "./languages";
import { fonts, mermaidTheme, paletteCss } from "./palette";

const repo = "https://github.com/jjongs2/ticket-runner";
const editPattern = `${repo}/edit/main/wiki/:path`;
const glossary = `${repo}/blob/main/GLOSSARY.md`;
const origin = "https://jjongs2.github.io";
const base = "/ticket-runner/";

type Page = { link: string; en: string; ko: string };
type Section = { en: string; ko: string; pages: Page[] };

// One list drives both sidebars and the neutral URLs, so a page added to one locale is
// added to the other, and has a neutral URL that opens it in the reader's language.
const sections: Section[] = [
  {
    en: "Using it",
    ko: "사용하기",
    pages: [
      { link: "/guide/installation", en: "Install and remove", ko: "설치와 제거" },
      { link: "/guide/planning", en: "Planning the work", ko: "일 계획하기" },
      { link: "/guide/running", en: "Running", ko: "실행하기" },
      { link: "/guide/configuration", en: "Configuration", ko: "설정" },
    ],
  },
  {
    en: "How it works",
    ko: "동작 방식",
    pages: [
      { link: "/guide/ticket-to-merge", en: "From Ticket to merge", ko: "Ticket 하나가 merge되기까지" },
      { link: "/guide/stopping-and-resuming", en: "Hand-offs, stopping and resuming", ko: "Hand-off, 멈추고 이어 하기" },
      { link: "/guide/internals", en: "Internals", ko: "내부 구조" },
    ],
  },
];

function sidebar(lang: "en" | "ko"): DefaultTheme.SidebarItem[] {
  return sections.map((s) => ({
    text: s[lang],
    collapsed: false,
    items: s.pages.map((p) => ({ text: p[lang], link: `/${lang}${p.link}` })),
  }));
}

// A neutral URL is a static stub, not a page of the site, so the build writes one beside
// the pages for the home and every page of the list: `guide/running.html` is served at
// both `/guide/running` and `/guide/running.html`.
function writeNeutralStubs(outDir: string) {
  for (const path of neutralPaths(sections)) {
    const file = join(outDir, path === "" ? "index.html" : `${path}.html`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, neutralStub(base, path));
  }
}

export default withMermaid(
  defineConfig({
    title: "ticket-runner",
    lang: "en",
    base,
    cleanUrls: true,
    lastUpdated: true,
    head: [
      ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
      ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
      ["link", { rel: "stylesheet", href: fonts.stylesheet }],
      ["style", {}, paletteCss],
    ],
    transformHead: ({ pageData }) => alternates(origin, base, pageData.relativePath),
    buildEnd: ({ outDir }) => writeNeutralStubs(outDir),
    // The theme's language menu links a broken URL on a not-found page; theme/langs.ts
    // wraps the composable every menu takes its links from. The theme's components import
    // it by this relative path, which only they use.
    vite: {
      resolve: {
        alias: [
          {
            find: /^\.\.\/composables\/langs$/,
            replacement: fileURLToPath(new URL("./theme/langs.ts", import.meta.url)),
          },
        ],
      },
    },
    themeConfig: {
      search: { provider: "local" },
      socialLinks: [{ icon: "github", link: repo }],
      editLink: { pattern: editPattern },
      // The 404 belongs to neither language, and its title link would otherwise be the
      // neutral home. The theme takes logoLink as written, so it carries the base, and
      // each locale sets its own, since this one would otherwise apply to both.
      logoLink: `${base}en/`,
    },
    // No root locale: every page is under /en/ or /ko/, and a path without a prefix is a
    // neutral URL's stub or the 404.
    locales: {
      en: {
        label: "English",
        lang: "en",
        link: "/en/",
        description: "How ticket-runner carries a Ticket from the board to a merge while nobody watches.",
        themeConfig: {
          nav: [
            { text: "Guide", link: "/en/guide/installation" },
            { text: "Glossary", link: glossary },
          ],
          sidebar: sidebar("en"),
          outline: { level: [2, 3] },
          logoLink: `${base}en/`,
        },
      },
      ko: {
        label: "한국어",
        lang: "ko",
        link: "/ko/",
        description: "ticket-runner가 아무도 지켜보지 않는 사이 Ticket 하나를 보드에서 merge까지 가져가는 방법.",
        themeConfig: {
          nav: [
            { text: "가이드", link: "/ko/guide/installation" },
            { text: "용어집", link: glossary },
          ],
          sidebar: sidebar("ko"),
          logoLink: `${base}ko/`,
          outline: { level: [2, 3], label: "이 페이지에서" },
          docFooter: { prev: "이전", next: "다음" },
          lastUpdated: { text: "마지막 수정" },
          editLink: { pattern: editPattern, text: "GitHub에서 이 페이지 고치기" },
          langMenuLabel: "언어",
          returnToTopLabel: "맨 위로",
          sidebarMenuLabel: "메뉴",
          darkModeSwitchLabel: "테마",
        },
      },
    },
    // The light theme's; the plugin switches to "dark" whenever the page is dark.
    mermaid: {
      theme: "neutral",
      themeVariables: mermaidTheme,
    },
  }),
);
