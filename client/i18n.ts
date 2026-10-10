import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// The board's strings are the defaults written beside each key, as in Jolly
// Roger, but for the counted ones: a default can't say "1 reply" and "2
// replies", so those come from Jolly Roger's en.json, as it had them. React
// escapes what it renders, so i18next doesn't.
const plurals = {
  puzzleList: {
    moreUsers_one: "{{count}} more user",
    moreUsers_other: "{{count}} more users",
  },
  whiteboard: {
    comments: {
      replies_one: "{{count}} reply",
      replies_other: "{{count}} replies",
    },
    follow: {
      followingYou_one: "{{name}} is following you",
      followingYou_other: "{{count}} people are following you",
    },
    frame: {
      comments_one: "{{count}} comment",
      comments_other: "{{count}} comments",
      finishedUnsolved_one: "Finished, {{count}} unsolved",
      finishedUnsolved_other: "Finished, {{count}} unsolved",
      items_one: "{{count}} item",
      items_other: "{{count}} items",
    },
    history: {
      changes_one: "{{count}} change",
      changes_other: "{{count}} changes",
    },
  },
};

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { translation: plurals } },
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
