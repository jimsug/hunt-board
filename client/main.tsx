import "bootstrap/dist/css/bootstrap.min.css";
import "@xyflow/react/dist/style.css";
import "./app.css";
import "./i18n";
import { setSession } from "client/methods";
import { Session } from "client/session";
import {
  applyChange,
  applyLive,
  applyPresence,
  applyWelcome,
  connection,
  welcome,
} from "client/store";
import { darkTheme, lightTheme } from "client/theme";
import WhiteboardPage from "client/WhiteboardPage";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { ThemeProvider } from "styled-components";
import { useMediaQuery } from "usehooks-ts";

// The board's entry point: opens the session with the token from the url,
// feeds what arrives to the store, and draws the page in Jolly Roger's
// theme, light or dark as the system prefers.

const socketUrl = () =>
  `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;

function openSession(token: string): Session {
  const session = new Session({
    url: socketUrl(),
    token,
    handlers: {
      welcome: (message) => {
        applyWelcome(message);
        welcome.set({ ...message, snapshot: undefined });
      },
      change: applyChange,
      live: (live) => {
        const boardId = welcome.peek()?.board;
        if (boardId) applyLive(boardId, live);
      },
      presence: (message) => {
        const boardId = welcome.peek()?.board;
        if (boardId) applyPresence(boardId, message);
      },
      state: (state) => connection.set(state),
    },
  });
  setSession(session);
  session.connect();
  return session;
}

const NoToken = () => {
  const { t } = useTranslation();
  return (
    <div className="jr-board-message">
      {t(
        "whiteboard.service.noToken",
        "Open the board from Jolly Roger, which signs you in to it.",
      )}
    </div>
  );
};

const App = ({ session }: { session: Session | undefined }) => {
  const systemPrefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const theme = systemPrefersDark ? darkTheme : lightTheme;
  useEffect(() => {
    document.body.dataset.bsTheme = systemPrefersDark ? "dark" : "light";
  }, [systemPrefersDark]);
  return (
    <ThemeProvider theme={theme}>
      {session ? <WhiteboardPage session={session} /> : <NoToken />}
    </ThemeProvider>
  );
};

const token = new URLSearchParams(window.location.search).get("token");
// The token stays out of the address bar (and the browser's history), as
// it's the viewer's sign-in to the board for a few minutes.
if (token) {
  const params = new URLSearchParams(window.location.search);
  params.delete("token");
  const query = params.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
  );
}

// Opened once, outside React, so a development double-mount doesn't open
// two sockets or close the one that's wanted.
const session = token ? openSession(token) : undefined;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App session={session} />
  </StrictMode>,
);
