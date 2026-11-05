import { computed } from "vue";
import { useData, useRoute } from "vitepress";
import { useLangs as useThemeLangs } from "vitepress/dist/client/theme-default/composables/langs.js";
import { otherLanguageLink } from "../languages";

// The theme's language menu, in the nav bar, its flyout and the mobile screen, with the
// link a not-found page offers corrected. On an in-app not-found page VitePress keeps
// the base in the page's relative path, and the theme cuts the locale prefix off that
// path, so `/ticket-runner/ko/guide/nope` would offer `/en/ket-runner/ko/guide/nope`.
// The config's alias puts this module in place of the theme's own.
export function useLangs(options: { correspondingLink?: boolean } = {}) {
  const langs = useThemeLangs(options);
  const { page, site, hash } = useData();
  const route = useRoute();
  const localeLinks = computed(() => {
    const link =
      options.correspondingLink && page.value.isNotFound ? otherLanguageLink(route.path, site.value.base) : null;
    // With two languages the menu holds one link, the language not being read.
    return link === null
      ? langs.localeLinks.value
      : langs.localeLinks.value.map((locale: { text: string }) => ({ ...locale, link: link + hash.value }));
  });
  return { ...langs, localeLinks };
}
