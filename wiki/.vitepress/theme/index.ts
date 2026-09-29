import DefaultTheme from "vitepress/theme";
import { onMounted, watch, nextTick } from "vue";
import { useRoute } from "vitepress";
import mediumZoom from "medium-zoom";
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
  overlay.addEventListener("pointerup", () => {
    dragging = false;
    if (!moved) overlay.remove();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onKey); }
  };
  document.addEventListener("keydown", onKey);
}

export default {
  extends: DefaultTheme,
  setup() {
    const route = useRoute();
    const refresh = () => {
      mediumZoom(".vp-doc img:not(.no-zoom)", { background: "rgba(0, 0, 0, 0.9)" });
      whenDiagramsRender(makeZoomable);
    };
    onMounted(refresh);
    watch(() => route.path, () => nextTick(refresh));
  },
};
