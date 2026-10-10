// What the viewer may do on the board, as Jolly Roger's permission stubs
// named it: "edit" includes commenting, and "comment" includes viewing. The
// welcome says which; the page adds the reasons only it knows.
export type WhiteboardAccess = "edit" | "comment" | "view" | "none";
// Why someone has less than "edit": their hunt is archived (the token's
// mayEdit is off), the board's edit policy, a phone-sized screen, or no
// connection.
export type WhiteboardAccessReason =
  | "archived"
  | "operators"
  | "operatorsAndEditors"
  | "narrow"
  | "offline";
