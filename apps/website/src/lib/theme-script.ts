/**
 * The only inline script on the site. It runs in <head> before first paint so the page never
 * flashes the wrong theme, and marks the document as scripted (`.js`) so JS-only controls are
 * shown without layout shift. The Worker allows exactly this script via a CSP hash computed
 * from this same string, so any edit here updates the policy automatically.
 */
export const THEME_STORAGE_KEY = "kalcode-theme";

export const THEME_SCRIPT = `(function(){var d=document.documentElement,p="system";try{p=localStorage.getItem("${THEME_STORAGE_KEY}")||"system"}catch(e){}if(p!=="light"&&p!=="dark")p="system";var t=p;if(p==="system"){t="dark";try{if(window.matchMedia("(prefers-color-scheme: light)").matches)t="light"}catch(e){}}d.setAttribute("data-theme",t);d.setAttribute("data-theme-preference",p);d.classList.add("js")})();`;
