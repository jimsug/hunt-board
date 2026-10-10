import { welcome } from "client/store/current";
import type { AnchorHTMLAttributes } from "react";
import { createElement, forwardRef } from "react";

// Jolly Roger's pages are another site from inside the board's iframe, so a
// react-router Link becomes a plain link that leaves the frame, built on the
// origin the welcome gave.

const jrHref = (to: string) => {
  const origin = welcome.peek()?.jrUrl ?? "";
  return /^[a-z]+:/i.test(to) ? to : `${origin}${to}`;
};

export const Link = forwardRef<
  HTMLAnchorElement,
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { to: string }
>(function Link({ to, ...rest }, ref) {
  return createElement("a", {
    ref,
    href: jrHref(to),
    target: "_top",
    rel: "noreferrer",
    ...rest,
  });
});

// Going to a Jolly Roger page means the top window leaving for it. One
// seam, so a test page (which can't leave) can record the visit instead.
export const topNavigation = {
  go(url: string) {
    (window.top ?? window).location.href = url;
  },
};

export function useNavigate() {
  return (to: string) => {
    topNavigation.go(jrHref(to));
  };
}
