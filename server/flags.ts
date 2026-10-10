import Settings from "./models/Settings";

// The switches Jolly Roger's feature flags gave the board. A flag is on for
// the whole process when FLAGS names it in the environment (comma
// separated), or for as long as a settings document says so, which set()
// writes. The checks sit where the source had them.
export const FlagNames = [
  "disable.whiteboard",
  "disable.whiteboard_live",
  "disable.whiteboard_versions",
] as const;
export type FlagName = (typeof FlagNames)[number];

const settingName = (name: FlagName) => `flag.${name}`;

const fromEnvironment = () =>
  new Set(
    (process.env.FLAGS ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  );

const Flags = {
  async activeAsync(name: FlagName) {
    if (fromEnvironment().has(name)) return true;
    const setting = await Settings.findOneAsync({ name: settingName(name) });
    return setting?.value === true;
  },

  async set(name: FlagName, active: boolean) {
    if (active) {
      await Settings.upsertAsync(
        { name: settingName(name) },
        { $set: { value: true, updatedAt: new Date() } },
      );
    } else {
      await Settings.removeAsync({ name: settingName(name) });
    }
  },
};

export default Flags;
