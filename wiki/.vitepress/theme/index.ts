import DefaultTheme from "vitepress/theme";
import { h, onMounted, watch, nextTick } from "vue";
import { getScrollOffset, inBrowser, useRoute, type Router, type Theme } from "vitepress";
import mediumZoom from "medium-zoom";
import { languageOf, rememberLanguage } from "../languages";
import NotFound from "./NotFound.vue";
import "./custom.css";

// Mermaid renders after the page mounts, so the diagrams are looked for a few times.
function whenDiagramsRender(fn: () => void) {
  let tries = 0;
  const timer = setInterval(() => {
    fn();
    if (++tries >= 20) clearInterval(timer);
  }, 500);
}

function makeZoomable() {
  document.querySelectorAll<HTMLElement>(".mermaid").forEach((el) => {
    if (el.dataset.zoomable || !el.querySelector("svg")) return;
    el.dataset.zoomable = "1";
    el.addEventListener("click", () => openDiagram(el));
  });
}

// A full-screen view of one diagram, dragged to pan and scrolled to zoom.
function openDiagram(el: HTMLElement) {
  const svg = el.querySelector("svg");
  if (!svg) return;
  const overlay = document.createElement("div");
  overlay.className = "diagram-zoom";
  const clone = svg.cloneNode(true) as SVGElement;
  clone.removeAttribute("style");
  clone.setAttribute("width", "100%");
  clone.setAttribute("height", "100%");
  overlay.appendChild(clone);
  document.body.appendChild(overlay);

  let scale = 1, x = 0, y = 0, dragging = false, startX = 0, startY = 0, moved = false;
  const apply = () => (clone.style.transform = `translate(${x}px, ${y}px) scale(${scale})`);
  overlay.addEventListener("wheel", (e) => {
    e.preventDefault();
    scale = Math.min(8, Math.max(0.5, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    apply();
  }, { passive: false });
  overlay.addEventListener("pointerdown", (e) => {
    dragging = true; moved = false; startX = e.clientX - x; startY = e.clientY - y;
  });
  overlay.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    moved = true; x = e.clientX - startX; y = e.clientY - startY; apply();
  });
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  overlay.addEventListener("pointerup", () => {
    dragging = false;
    if (!moved) close();
  });
  document.addEventListener("keydown", onKey);
}

// The heading the outline marks as the one being read, or null above the first.
function currentHeading(): string | null {
  let id: string | null = null;
  for (const h of document.querySelectorAll<HTMLElement>(".vp-doc :is(h2, h3)[id]")) {
    if (h.getBoundingClientRect().top > getScrollOffset() + 4) break;
    id = h.id;
  }
  return id;
}

// Both locales give a page the same heading anchors, so switching language
// lands on the section being read instead of the top of the page. The theme's
// language link carries the URL's anchor, which goes stale once the reader scrolls.
function keepSectionOnLanguageSwitch(router: Router, base: string) {
  router.onBeforeRouteChange = (href) => {
    const to = new URL(href, location.href);
    const pageOf = (path: string) => languageOf(path, base)?.rest;
    const page = pageOf(location.pathname);
    if (to.pathname === location.pathname || page === undefined || pageOf(to.pathname) !== page) return;
    const id = currentHeading();
    const target = id ? `${to.pathname}#${id}` : to.pathname;
    if (target === to.pathname + to.hash) return;
    router.go(target);
    return false;
  };
}

// Diagrams render after the router has scrolled to a heading and push it down the page,
// so the heading is put back each time the page grows, until the reader moves or the
// diagrams have had as long as whenDiagramsRender gives them.
function holdHeading(id: string) {
  const heading = document.getElementById(id);
  const doc = document.querySelector(".vp-doc");
  if (!heading || !doc) return;
  // Where the router's own scroll puts a heading.
  const place = () => {
    const padding = parseInt(getComputedStyle(heading).paddingTop, 10);
    window.scrollTo(0, window.scrollY + heading.getBoundingClientRect().top - getScrollOffset() + padding);
  };
  const observer = new ResizeObserver(place);
  const inputs = ["wheel", "touchstart", "keydown", "pointerdown"];
  const release = () => {
    observer.disconnect();
    clearTimeout(timer);
    inputs.forEach((e) => window.removeEventListener(e, release));
  };
  const timer = setTimeout(release, 10_000);
  inputs.forEach((e) => window.addEventListener(e, release, { passive: true }));
  observer.observe(doc);
}

// A pick is the reader following a link in the language menu, the desktop one or the
// mobile one, in this tab or a new one; the next neutral URL follows it. The desktop
// menu is the nav bar's own from 1280px and sits in its "…" flyout below that. The listeners
// capture, so they see the click before the router turns it into a route change.
// Reaching the other language any other way records nothing.
function rememberLanguagePicks(base: string) {
  const menus = [".VPNavBarTranslations", ".VPNavBarExtra .translations", ".VPNavScreenTranslations"]
    .map((menu) => `${menu} a[href]`)
    .join(", ");
  const record = (e: MouseEvent) => {
    if (e.type === "auxclick" && e.button !== 1) return;
    const link = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>(menus) : null;
    if (!link) return;
    const picked = languageOf(new URL(link.href, location.href).pathname, base)?.language;
    if (picked) rememberLanguage(() => localStorage, picked);
  };
  document.addEventListener("click", record, true);
  document.addEventListener("auxclick", record, true);
}

function holdHeadingAfterRouteChange(router: Router) {
  router.onAfterRouteChange = async (href) => {
    const id = decodeURIComponent(new URL(href, location.href).hash.slice(1));
    if (!id) return;
    await nextTick();
    holdHeading(id);
  };
}

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { "not-found": () => h(NotFound) }),
  enhanceApp({ router, siteData }) {
    if (!inBrowser) return;
    const base = siteData.value.base;
    keepSectionOnLanguageSwitch(router, base);
    rememberLanguagePicks(base);
    holdHeadingAfterRouteChange(router);
  },
  setup() {
    const route = useRoute();
    const refresh = () => {
      mediumZoom(".vp-doc img:not(.no-zoom)", { background: "rgba(0, 0, 0, 0.9)" });
      whenDiagramsRender(makeZoomable);
    };
    onMounted(refresh);
    watch(() => route.path, () => nextTick(refresh));
  },
} satisfies Theme;
