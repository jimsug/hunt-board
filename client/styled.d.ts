import type { Theme } from "client/theme";

declare module "styled-components" {
  // biome-ignore lint/suspicious/noEmptyInterface: the theme is the DefaultTheme
  export interface DefaultTheme extends Theme {}
}
