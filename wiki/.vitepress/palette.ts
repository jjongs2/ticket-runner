// The wiki's colours and fonts, in one place. The config writes them into the page as
// CSS variables, which is what custom.css reads, diagrams included.

export const colors = {
  bg: "#0d1117",
  bgAlt: "#0a0d12",
  surface: "#161b22",
  border: "#30363d",
  node: "#2d333b",
  text: "#e6edf3",
  textMuted: "#9da7b3",
  line: "#8b949e",
  brandLight: "#8b7dff",
  brand: "#6d5dfc",
  brandDark: "#5a4ae0",
  brandSoft: "rgba(109, 93, 252, 0.16)",
};

// The light theme keeps VitePress's own colours; only the diagrams need two of their own.
export const lightColors = {
  node: "#ffffff",
  line: "#57606a",
};

// Plex Sans KR shares Plex Sans's Latin glyphs, so English and Korean set in one text look alike.
export const fonts = {
  sans: '"IBM Plex Sans", "IBM Plex Sans KR", ui-sans-serif, system-ui, sans-serif',
  mono: '"IBM Plex Mono", "IBM Plex Sans KR", ui-monospace, monospace',
  stylesheet:
    "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap",
};

// `html.dark` outranks the default theme's `.dark`, whichever stylesheet loads last.
export const paletteCss = `
html:root {
  --vp-font-family-base: ${fonts.sans};
  --vp-font-family-mono: ${fonts.mono};
  --wiki-node: ${lightColors.node};
  --wiki-line: ${lightColors.line};
}
html.dark {
  --vp-c-bg: ${colors.bg};
  --vp-c-bg-alt: ${colors.bgAlt};
  --vp-c-bg-soft: ${colors.surface};
  --vp-c-bg-elv: ${colors.surface};
  --vp-c-divider: ${colors.border};
  --vp-c-text-1: ${colors.text};
  --vp-c-text-2: ${colors.textMuted};
  --vp-c-brand-1: ${colors.brandLight};
  --vp-c-brand-2: ${colors.brand};
  --vp-c-brand-3: ${colors.brandDark};
  --vp-c-brand-soft: ${colors.brandSoft};
  --wiki-node: ${colors.node};
  --wiki-line: ${colors.line};
}`;

// Mermaid is given one set of theme variables for both themes, so it gets no colours:
// custom.css paints the diagrams from the page's variables instead.
export const mermaidTheme = {
  fontFamily: fonts.sans,
};
