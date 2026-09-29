import { defineConfig, type DefaultTheme } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

const repo = "https://github.com/jjongs2/ticket-runner";

type Page = { link: string; en: string; ko: string };
type Section = { en: string; ko: string; pages: Page[] };

// One list drives both sidebars, so a page added to one locale is added to the other.
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
      { link: "/guide/ticket-to-merge", en: "From Ticket to merge", ko: "Ticket 하나가 머지되기까지" },
      { link: "/guide/stopping-and-resuming", en: "Stopping and resuming", ko: "멈추고 이어 하기" },
      { link: "/guide/internals", en: "Internals", ko: "내부 구조" },
    ],
  },
];

function sidebar(lang: "en" | "ko"): DefaultTheme.SidebarItem[] {
  const prefix = lang === "ko" ? "/ko" : "";
  return sections.map((s) => ({
    text: s[lang],
    collapsed: false,
    items: s.pages.map((p) => ({ text: p[lang], link: prefix + p.link })),
  }));
}

export default withMermaid(
  defineConfig({
    title: "ticket-runner",
    base: "/ticket-runner/",
    cleanUrls: true,
    lastUpdated: true,
    appearance: "dark",
    head: [
      ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
      ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
      [
        "link",
        {
          rel: "stylesheet",
          href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap",
        },
      ],
    ],
    themeConfig: {
      search: { provider: "local" },
      socialLinks: [{ icon: "github", link: repo }],
      editLink: { pattern: `${repo}/edit/main/wiki/:path` },
    },
    locales: {
      root: {
        label: "English",
        lang: "en",
        description: "How ticket-runner carries a Ticket from the board to a merge while nobody watches.",
        themeConfig: {
          nav: [
            { text: "Guide", link: "/guide/installation" },
            { text: "Glossary", link: `${repo}/blob/main/CONTEXT.md` },
          ],
          sidebar: sidebar("en"),
          outline: { level: [2, 3] },
        },
      },
      ko: {
        label: "한국어",
        lang: "ko",
        link: "/ko/",
        description: "ticket-runner가 아무도 지켜보지 않는 사이 Ticket 하나를 보드에서 머지까지 가져가는 방법.",
        themeConfig: {
          nav: [
            { text: "가이드", link: "/ko/guide/installation" },
            { text: "용어집", link: `${repo}/blob/main/CONTEXT.md` },
          ],
          sidebar: sidebar("ko"),
          outline: { level: [2, 3], label: "이 페이지에서" },
          docFooter: { prev: "이전", next: "다음" },
          lastUpdated: { text: "마지막 수정" },
          editLink: { pattern: `${repo}/edit/main/wiki/:path`, text: "GitHub에서 이 페이지 고치기" },
          langMenuLabel: "언어",
          returnToTopLabel: "맨 위로",
          sidebarMenuLabel: "메뉴",
          darkModeSwitchLabel: "테마",
        },
      },
    },
    mermaid: {
      theme: "dark",
      themeVariables: {
        primaryColor: "#2d333b",
        primaryTextColor: "#e6edf3",
        primaryBorderColor: "#6d5dfc",
        lineColor: "#8b949e",
        secondaryColor: "#2d333b",
        tertiaryColor: "#161b22",
        background: "#0d1117",
        mainBkg: "#2d333b",
        nodeBorder: "#6d5dfc",
        clusterBkg: "#161b22",
        clusterBorder: "#30363d",
        titleColor: "#e6edf3",
        edgeLabelBackground: "#161b22",
        actorBkg: "#2d333b",
        actorBorder: "#6d5dfc",
        actorTextColor: "#e6edf3",
        signalColor: "#8b949e",
        signalTextColor: "#e6edf3",
        noteBkgColor: "#161b22",
        noteTextColor: "#e6edf3",
        noteBorderColor: "#30363d",
        fontFamily: "Inter, sans-serif",
      },
    },
  }),
);
