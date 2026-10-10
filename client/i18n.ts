import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// The board's strings are the defaults written beside each key, as in Jolly
// Roger; there are no resource files. React escapes what it renders, so
// i18next doesn't.
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { translation: {} } },
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
