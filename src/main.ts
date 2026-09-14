import { createApp } from "vue";
import "./style.css";
// Font experiment: bundle candidate UI fonts (self-hosted, offline-safe).
// Each <weight>.css covers all subsets incl. Cyrillic via unicode-range.
import "@fontsource/montserrat/400.css";
import "@fontsource/montserrat/500.css";
import "@fontsource/montserrat/600.css";
import "@fontsource/montserrat/700.css";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/500.css";
import "@fontsource/fira-code/600.css";
import "@fontsource/fira-code/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
// Per-font size tuning (one file per font), keyed off :root[data-font=…].
import "./styles/fonts/montserrat.css";
import "./styles/fonts/fira-code.css";
import "./styles/fonts/jetbrains-mono.css";
import App from "./App.vue";
import i18n from "./i18n";
import { installErrorLogging, reportFatal } from "./logging";
import { applyFont, readCachedFontId } from "./fontSwitch";

installErrorLogging();
// Apply the cached font before paint (every window) to avoid a flash; App.vue
// reconciles it against the persisted store value on load.
applyFont(readCachedFontId());

const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(err);
    void reportFatal(`Ошибка Vue (${info})`, detail);
};
app.use(i18n).mount("#app");
