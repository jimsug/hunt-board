import { nonEmptyString } from "lib/typedModel/customTypes";
import type { ModelType } from "lib/typedModel/Model";
import Model from "lib/typedModel/Model";
import { z } from "zod";

// Server-side settings that can change while the process runs, by name.
// For now only the feature flags live here (see flags.ts).
const Setting = z.object({
  name: nonEmptyString,
  value: z.unknown(),
  updatedAt: z.date(),
});

const Settings = new Model("settings", Setting);
Settings.addIndex({ name: 1 }, { unique: true });
export type SettingType = ModelType<typeof Settings>;

export default Settings;
